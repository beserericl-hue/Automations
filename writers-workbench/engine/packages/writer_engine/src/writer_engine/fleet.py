"""Which engine instances exist, and making sure a scheduled job runs on only one of them (CR-010 C1).

Everything before this assumed one runtime container. Three things break the moment there are two:

* **arq's heartbeat key was per queue, not per instance.** Two workers on ``engine-heavy`` wrote the
  same key, so readiness, saturation and the scaling verdict all reported whichever replica wrote
  last. The worker now writes ``<key>:<instance>`` and the sampler adds them up (``queue_metrics``).
* **every replica ran its own scheduler.** Ingestion and the cadence cron claim their own rows, but
  the scheduled publisher does not: two replicas reading the same due post would both enqueue it,
  which is a double publish and a double email. :func:`run_once` is the lock that prevents it.
* **nothing said how many instances there were.** Each instance now records itself in Redis on the
  queue-metrics timer, with a TTL, so the fleet is whatever has reported in the last ninety seconds.
  A replica that dies simply ages out; there is no deregistration to forget.

The instance id is Railway's ``RAILWAY_REPLICA_ID`` (opaque, one per replica, stable for the
replica's life) with the hostname as the fallback for local runs and docker-compose.
"""

from __future__ import annotations

import json
import os
import re
import socket
import time
from typing import Any

from prometheus_client import Gauge

from writer_engine.telemetry.logging import get_logger

logger = get_logger("fleet")

FLEET_PREFIX = "engine:fleet"
SINGLETON_PREFIX = "engine:singleton"

REGISTRATION_TTL_S = 90
"""Three missed 30s queue-metrics ticks. Long enough to ride out one slow tick, short enough that a
dead replica stops being counted within a minute and a half."""

_STARTED_AT = time.time()

INSTANCE_INFO = Gauge(
    "engine_instance_info",
    "Always 1. Labels say which replica served this scrape, so per-instance series can be told apart "
    "behind a load balancer that sends each scrape to a random replica.",
    labelnames=("service", "instance", "region", "commit"),
)
FLEET_INSTANCES = Gauge(
    "engine_fleet_instances",
    "Instances of each engine service that have reported in the last REGISTRATION_TTL_S seconds.",
    labelnames=("service",),
)


def instance_id() -> str:
    """This replica's id: ``RAILWAY_REPLICA_ID``, else the hostname. Safe to put in a Redis key."""
    raw = os.environ.get("RAILWAY_REPLICA_ID") or socket.gethostname() or "local"
    return re.sub(r"[^A-Za-z0-9_.-]", "-", raw)[:64]


def describe(service: str) -> dict[str, Any]:
    """What this instance says about itself in the registry."""
    return {
        "service": service,
        "instance": instance_id(),
        "region": os.environ.get("RAILWAY_REPLICA_REGION", ""),
        "commit": (os.environ.get("RAILWAY_GIT_COMMIT_SHA") or "")[:12],
        "deployment": os.environ.get("RAILWAY_DEPLOYMENT_ID", ""),
        "started_at": round(_STARTED_AT),
    }


def mark_instance(service: str) -> None:
    """Set the info gauge for this process. Cheap; called at startup."""
    me = describe(service)
    INSTANCE_INFO.labels(
        service=service, instance=me["instance"], region=me["region"], commit=me["commit"]
    ).set(1)


async def register(redis: Any, service: str, **extra: Any) -> None:
    """Record this instance as alive. Never raises: a registry write must not break a metrics tick."""
    body = {**describe(service), **extra, "last_seen": round(time.time())}
    try:
        await redis.set(
            f"{FLEET_PREFIX}:{service}:{body['instance']}", json.dumps(body), ex=REGISTRATION_TTL_S
        )
    except Exception as exc:
        logger.warning("fleet.register_failed", service=service, error=f"{type(exc).__name__}: {exc}"[:160])


async def deregister(redis: Any, service: str) -> None:
    """Leave the registry on shutdown, so a replaced replica is not counted for its last TTL.

    Found by the fleet E2E spec, which runs right after a deploy: the old replicas were still
    registered for up to REGISTRATION_TTL_S, so "runtime instances" read 4 while 2 workers ran.
    Best effort: a replica that dies without shutting down still ages out by the TTL.
    """
    try:
        await redis.delete(f"{FLEET_PREFIX}:{service}:{instance_id()}")
    except Exception as exc:
        logger.warning("fleet.deregister_failed", service=service, error=f"{type(exc).__name__}: {exc}"[:160])


async def scan_keys(redis: Any, pattern: str) -> list[str]:
    """``SCAN MATCH`` to a list. A client without ``scan`` (a test double) yields nothing."""
    scan = getattr(redis, "scan", None)
    if scan is None:
        return []
    keys: list[str] = []
    cursor: Any = 0
    for _ in range(1000):  # a bound, not a cap anyone should reach: the fleet is a handful of keys
        cursor, batch = await scan(cursor=cursor, match=pattern, count=200)
        keys += [k.decode() if isinstance(k, bytes) else str(k) for k in batch or []]
        if not int(cursor or 0):
            break
    return keys


async def read_fleet(redis: Any) -> list[dict[str, Any]]:
    """Every instance that has registered within the TTL, sorted by service then start time."""
    out: list[dict[str, Any]] = []
    try:
        for key in await scan_keys(redis, f"{FLEET_PREFIX}:*"):
            raw = await redis.get(key)
            if not raw:
                continue
            try:
                out.append(json.loads(raw))
            except ValueError:
                continue
    except Exception as exc:
        logger.warning("fleet.read_failed", error=f"{type(exc).__name__}: {exc}"[:160])
        return []
    out.sort(key=lambda r: (str(r.get("service")), r.get("started_at") or 0))
    counts: dict[str, int] = {}
    for row in out:
        counts[str(row.get("service"))] = counts.get(str(row.get("service")), 0) + 1
    for service, n in counts.items():
        FLEET_INSTANCES.labels(service=service).set(n)
    return out


async def run_once(redis: Any, name: str, *, ttl_s: float) -> bool:
    """Claim ``name`` for ``ttl_s`` seconds. True means this replica runs the job; False means another
    replica already has it.

    The lock is never released early, on purpose: it is a spacing guarantee, not a mutex. With the
    TTL just under the job's interval, whichever replica ticks first runs it and the others skip
    until the next interval, so the job runs about once per interval across the fleet however many
    replicas there are.

    **Fails open.** If Redis cannot be reached the job runs anyway. Every singleton job either claims
    its own rows (ingestion, cadence) or needs Redis to enqueue anything at all (the publisher), so
    running without the lock during an outage costs nothing, while skipping would silently stop the
    clock.
    """
    try:
        got = await redis.set(
            f"{SINGLETON_PREFIX}:{name}", instance_id(), nx=True, px=max(1000, int(ttl_s * 1000))
        )
        return bool(got)
    except Exception as exc:
        logger.warning(
            "fleet.lock_failed_running_anyway", job=name, error=f"{type(exc).__name__}: {exc}"[:160]
        )
        return True


__all__ = [
    "FLEET_PREFIX",
    "REGISTRATION_TTL_S",
    "SINGLETON_PREFIX",
    "deregister",
    "describe",
    "instance_id",
    "mark_instance",
    "read_fleet",
    "register",
    "run_once",
    "scan_keys",
]
