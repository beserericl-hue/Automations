"""Close run-ledger rows that no job will ever finish.

``engine_job_runs`` rows are opened ``in_progress`` by ``claim_run`` and closed by the worker with
``complete_run`` / ``fail_run``. Two ways out of a job never reach either call:

* **arq's job_timeout** cancels the job coroutine (a ``CancelledError``, which the worker's
  ``except Exception`` does not see) and does not retry it;
* **a job cancelled by worker shutdown until it exceeds max_tries** is failed by arq without ever
  entering the coroutine again (the case ``worker._dlq`` documents it cannot see).

Both leave the row ``in_progress`` forever, and the Workbench shows the run as running forever: 22
QA runs from the 2026-10-20 deploy were still "in progress" on 2026-11-03. The run lease (item 16)
stops two live copies of a run; it does not close a dead one.

The reaper marks a row ``error`` when it is older than the longest its queue can legitimately keep a
run alive (every try at the full ``job_timeout``, plus a grace for queueing) AND no live run lease
holds it. Reaping is safe even when wrong: a later retry of the same run finds ``error`` and
``claim_run`` re-opens it, exactly as after any failure.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from writer_engine.idempotency.run_lease import lease_key
from writer_engine.idempotency.run_ledger import STATUS_ERROR, STATUS_IN_PROGRESS, TABLE
from writer_engine.queues import PROFILES, QUEUE_HEAVY
from writer_engine.telemetry.logging import get_logger

logger = get_logger("idempotency.reaper")

GRACE_S = 30 * 60
"""Queueing and lease-wait time on top of the job's own run time before a row is presumed dead."""

REASON = "abandoned: no live run lease and no update for {age_min} min (limit {limit_min} min); reaped"


def stale_after_s(queue: str) -> float:
    """The longest a run on ``queue`` can legitimately stay in_progress."""
    profile = PROFILES.get(queue) or PROFILES[QUEUE_HEAVY]  # unknown queue: the longest ceiling
    return float(profile.job_timeout * max(1, profile.max_tries) + GRACE_S)


def _parse(ts: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


async def _lease_held(redis: Any, run_id: str) -> bool:
    if redis is None:
        return False
    return bool(await redis.exists(lease_key(run_id)))


async def reap_stale_runs(
    client: Any, *, redis: Any = None, now: datetime | None = None, limit: int = 200
) -> dict[str, Any]:
    """Mark dead ``in_progress`` runs as ``error``. Returns what it looked at and what it closed."""
    now = now or datetime.now(UTC)
    shortest = min(stale_after_s(q) for q in PROFILES)
    cutoff = (now - timedelta(seconds=shortest)).isoformat()
    resp = await (
        client.table(TABLE)
        .select("run_id,tool,op,queue,updated_at")
        .eq("status", STATUS_IN_PROGRESS)
        .lt("updated_at", cutoff)
        .order("updated_at")
        .limit(limit)
        .execute()
    )
    rows = list(getattr(resp, "data", None) or [])
    reaped: list[str] = []
    live: list[str] = []
    for row in rows:
        run_id = str(row.get("run_id") or "")
        updated = _parse(row.get("updated_at"))
        if not run_id or updated is None:
            continue
        limit_s = stale_after_s(str(row.get("queue") or ""))
        age_s = (now - updated).total_seconds()
        if age_s < limit_s:
            continue
        if await _lease_held(redis, run_id):
            live.append(run_id)
            continue
        await (
            client.table(TABLE)
            .update(
                {
                    "status": STATUS_ERROR,
                    "error": REASON.format(age_min=int(age_s // 60), limit_min=int(limit_s // 60)),
                    "updated_at": now.isoformat(),
                }
            )
            .eq("run_id", run_id)
            # Only if still in progress: a run that completed since the select keeps its result.
            .eq("status", STATUS_IN_PROGRESS)
            .execute()
        )
        reaped.append(run_id)
        logger.warning(
            "idempotency.run_reaped",
            run_id=run_id,
            tool=row.get("tool"),
            op=row.get("op"),
            queue=row.get("queue"),
            age_min=int(age_s // 60),
        )
    return {"checked": len(rows), "reaped": len(reaped), "reaped_run_ids": reaped, "lease_held": live}


__all__ = ["GRACE_S", "reap_stale_runs", "stale_after_s"]
