"""The run lease: one LIVE execution of a run at a time, across every replica.

Why the ledger alone was not enough (measured on DEV, 2026-11-02, run a8855eae…):

    15:17:12  replica A  worker.write_tool.start      run_id=a8855eae… (ingestion, heavy queue)
    15:35:28  replica A  SIGTERM (deploy) -> drain begins
    15:36:02  replica A  arq: "cancelled, will be run again"      <- arq frees the job
    15:36:04  replica B  idempotency.rerun  prior_status=in_progress, attempts -> 2
    15:36:04  replica B  worker.write_tool.start      run_id=a8855eae…
    15:36:05..12  replica A's steps_app is STILL scraping, calling Gemini and writing rows
    15:36:12  replica A  supervisor.drain_timeout killing=['steps_app']

arq cancels the *worker coroutine*, which only drops the worker's HTTP request to the step service.
The step handler on the other end keeps running until its container dies. arq meanwhile deletes its
own in-progress key and re-queues the job, another replica picks it up within a second, and the
ledger — which treats ``in_progress`` as "the previous owner died" — lets it run. For eight seconds
the same run executed on two instances. Ingestion absorbed it (it upserts on ``key``); a chapter
write would have paid for the LLM twice and raced two persists.

The lease closes that window. A run holds ``engine:run-lease:<run_id>`` while it executes and
refreshes it every ``REFRESH_S``. On a clean finish it is released. On a cancel it is deliberately
LEFT to expire, because the cancel does not stop the step — the TTL is what covers the step's
remaining life. ``LEASE_TTL_S`` must therefore exceed the longest a step can outlive its worker's
cancel: the platform's drain window (RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60) minus the shortest
queue drain wait (20s) = 40s. 60s covers it.

A retry that finds the lease held waits for it (``WAIT_S``, a little over one TTL). A dead holder's
lease lapses inside that window and the retry proceeds — and then the ledger decides whether it is a
replay (the prior run completed) or a genuine re-run. A holder that is still refreshing after the
wait is a live duplicate, and the caller skips rather than running the same work twice.

Fails open like the ledger: if Redis cannot be reached, the work proceeds.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from writer_engine.telemetry.logging import get_logger

logger = get_logger("idempotency.lease")

LEASE_PREFIX = "engine:run-lease:"
LEASE_TTL_S = 60.0
REFRESH_S = 15.0
WAIT_S = LEASE_TTL_S + 15.0
POLL_S = 1.0


def lease_key(run_id: str) -> str:
    return f"{LEASE_PREFIX}{run_id}"


def new_owner(instance: str = "") -> str:
    """A token unique to this attempt — the instance makes it readable in Redis, the uuid unique."""
    return f"{instance or 'local'}:{uuid.uuid4().hex[:12]}"


@dataclass
class Lease:
    run_id: str
    owner: str
    acquired: bool
    """True when this attempt holds the lease."""
    available: bool = True
    """False when Redis could not be reached; the caller proceeds without a lease (fail open)."""
    waited_s: float = 0.0
    holder: str | None = None
    """Who held it when we gave up waiting, for the log line."""


def _s(v: Any) -> str | None:
    if v is None:
        return None
    return v.decode() if isinstance(v, bytes) else str(v)


def _ttl(ttl_s: float | None) -> float:
    # Resolved at call time, not bound as a default, so an operator (or a test) can tune the module
    # constants without every caller having to pass them.
    return LEASE_TTL_S if ttl_s is None else ttl_s


async def try_acquire(redis: Any, run_id: str, owner: str, *, ttl_s: float | None = None) -> bool:
    return bool(await redis.set(lease_key(run_id), owner, nx=True, px=int(_ttl(ttl_s) * 1000)))


async def acquire(
    redis: Any,
    run_id: str,
    owner: str,
    *,
    ttl_s: float | None = None,
    wait_s: float | None = None,
    poll_s: float | None = None,
) -> Lease:
    """Take the lease, waiting up to ``wait_s`` for a current holder to finish or lapse."""
    wait_s = WAIT_S if wait_s is None else wait_s
    poll_s = POLL_S if poll_s is None else poll_s
    started = time.monotonic()
    try:
        while True:
            if await try_acquire(redis, run_id, owner, ttl_s=ttl_s):
                return Lease(run_id, owner, acquired=True, waited_s=round(time.monotonic() - started, 2))
            if time.monotonic() - started >= wait_s:
                holder = _s(await redis.get(lease_key(run_id)))
                if holder is None:  # lapsed between the SET and the GET — one more try
                    continue
                return Lease(
                    run_id,
                    owner,
                    acquired=False,
                    waited_s=round(time.monotonic() - started, 2),
                    holder=holder,
                )
            await asyncio.sleep(poll_s)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("lease.unavailable", run_id=run_id, error=f"{type(exc).__name__}: {str(exc)[:160]}")
        return Lease(run_id, owner, acquired=False, available=False)


async def _if_owner(redis: Any, run_id: str, owner: str, action: str, ttl_s: float | None) -> bool:
    """Compare-and-(expire|delete) in a WATCH transaction, so a lease that lapsed and was taken by
    another attempt is never extended or deleted by us."""
    key = lease_key(run_id)
    async with redis.pipeline(transaction=True) as pipe:
        try:
            await pipe.watch(key)
            if _s(await pipe.get(key)) != owner:
                await pipe.unwatch()
                return False
            pipe.multi()
            if action == "refresh":
                pipe.pexpire(key, int(_ttl(ttl_s) * 1000))
            else:
                pipe.delete(key)
            await pipe.execute()
            return True
        except Exception as exc:  # WatchError included: someone else touched it, so it is not ours
            logger.debug("lease.compare_failed", run_id=run_id, action=action, error=str(exc)[:120])
            return False


async def refresh(redis: Any, run_id: str, owner: str, *, ttl_s: float | None = None) -> bool:
    return await _if_owner(redis, run_id, owner, "refresh", ttl_s)


async def release(redis: Any, run_id: str, owner: str) -> bool:
    return await _if_owner(redis, run_id, owner, "release", None)


@contextlib.asynccontextmanager
async def held(
    redis: Any,
    lease: Lease,
    *,
    ttl_s: float | None = None,
    refresh_s: float | None = None,
) -> AsyncIterator[Lease]:
    """Keep ``lease`` alive while the body runs.

    Released when the body returns or raises an ordinary exception — the step has answered, so it is
    no longer running. NOT released on cancellation: the step on the other end of the cancelled
    request is still running, and the lease's remaining TTL is what keeps a retry off it.
    """
    if not (lease.acquired and lease.available):
        yield lease
        return

    every = REFRESH_S if refresh_s is None else refresh_s

    async def _keepalive() -> None:
        while True:
            await asyncio.sleep(every)
            try:
                if not await refresh(redis, lease.run_id, lease.owner, ttl_s=ttl_s):
                    logger.warning("lease.lost", run_id=lease.run_id, owner=lease.owner)
                    return
            except Exception as exc:
                logger.warning("lease.refresh_failed", run_id=lease.run_id, error=str(exc)[:160])

    task = asyncio.create_task(_keepalive())
    cancelled = False
    try:
        yield lease
    except asyncio.CancelledError:
        cancelled = True
        raise
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        if not cancelled:
            with contextlib.suppress(Exception):
                await release(redis, lease.run_id, lease.owner)
        else:
            logger.info("lease.left_to_expire", run_id=lease.run_id, ttl_s=_ttl(ttl_s))


__all__ = [
    "LEASE_PREFIX",
    "LEASE_TTL_S",
    "REFRESH_S",
    "WAIT_S",
    "Lease",
    "acquire",
    "held",
    "lease_key",
    "new_owner",
    "refresh",
    "release",
    "try_acquire",
]
