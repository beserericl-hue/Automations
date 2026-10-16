"""The run ledger: an async write job persists its work at most once (B6).

An async job can run more than once for a single user request. arq re-queues a job on
``CancelledError``, which is exactly what a worker restart, a Railway deploy or a SIGTERM mid-chapter
produces. Four of the engine's persist paths are plain ``INSERT``s and duplicate under that —
``persist_content``, ``persist_research``, ``persist_chapter_qa`` and, worst, ``persist_token_usage``,
which is billing data: a duplicate over-reports what the user owes.

Two of the tables involved are immutable base tables and cannot gain a dedupe key of their own
(see docs/schema-governance.md), so the key lives in one meta table instead — ``engine_job_runs``,
migration 028. A run claims its ``run_id`` before doing any work; a run already recorded ``complete``
does not execute again at all, which stops the duplicated LLM spend as well as the duplicated rows.

Everything here FAILS OPEN. If the ledger is unreachable the job proceeds exactly as it did before
this module existed: a degraded ledger must not stop a user's chapter from being written. The
unavailability is logged at warning so it is visible rather than silent.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from writer_engine.telemetry.logging import get_logger

logger = get_logger("idempotency")

TABLE = "engine_job_runs"

STATUS_IN_PROGRESS = "in_progress"
STATUS_COMPLETE = "complete"
STATUS_ERROR = "error"

# A chapter write's StepOutput carries the whole chapter. Keeping every one of those in the ledger
# would turn a control table into a second copy of the content tables, so large outputs are recorded
# as truncated: the prose itself is already in published_content_v2, and the Workbench reads a
# finished job from the database rather than from the job result (it polls only for `status`).
MAX_RESULT_BYTES = 64 * 1024


@dataclass(frozen=True)
class RunClaim:
    """The outcome of trying to claim a run.

    ``available`` is False when the ledger could not be reached at all — the caller must then
    proceed, because refusing to work on a bookkeeping outage is worse than a possible duplicate.
    """

    run_id: str
    won: bool
    """True when this caller inserted the row, i.e. nothing has run under this id before."""
    status: str | None = None
    """The prior row's status, when one existed."""
    replay: dict[str, Any] | None = None
    """A completed prior run's recorded output, when it was small enough to keep."""
    available: bool = True

    @property
    def should_skip(self) -> bool:
        """True when the work has already been done and must not be done again."""
        return self.available and not self.won and self.status == STATUS_COMPLETE


async def _rows(resp: Any) -> list[dict[str, Any]]:
    data = getattr(resp, "data", None)
    return list(data) if isinstance(data, list) else []


async def claim_run(
    client: Any,
    *,
    run_id: str,
    tool: str,
    op: str = "",
    queue: str = "",
    user_id: str = "",
    project_id: str | None = None,
    chapter_number: int | None = None,
) -> RunClaim:
    """Claim ``run_id`` before doing the work.

    Outcomes:

    * **no prior row** — the row is inserted and ``won`` is True: go ahead.
    * **prior row is complete** — ``should_skip`` is True: the work is done, replay the result.
    * **prior row is in_progress** — go ahead. The previous owner died mid-run (arq only re-queues a
      job after a cancel), so re-running is the correct repair, and the idempotent persist paths
      absorb the overlap. ``attempts`` is bumped so the repetition is visible.
    * **prior row errored** — go ahead and reset the row to in_progress.
    """
    if not run_id:
        return RunClaim(run_id="", won=False, available=False)

    row = {
        "run_id": run_id,
        "tool": tool,
        "op": op or "",
        "queue": queue or "",
        "user_id": user_id or None,
        "project_id": str(project_id) if project_id else None,
        "chapter_number": chapter_number,
        "status": STATUS_IN_PROGRESS,
    }
    try:
        await client.table(TABLE).insert(row).execute()
        return RunClaim(run_id=run_id, won=True, status=STATUS_IN_PROGRESS)
    except Exception as exc:
        # A duplicate primary key is the expected path for a retry, and is indistinguishable here
        # from a genuine outage, so read the row back: if it is there, this was a conflict.
        prior = await _read(client, run_id)
        if prior is None:
            logger.warning(
                "idempotency.claim_unavailable",
                run_id=run_id,
                tool=tool,
                op=op,
                error=f"{type(exc).__name__}: {str(exc)[:160]}",
            )
            return RunClaim(run_id=run_id, won=False, available=False)

    status = str(prior.get("status") or "")
    if status == STATUS_COMPLETE:
        logger.info("idempotency.replay", run_id=run_id, tool=tool, op=op)
        result = prior.get("result")
        return RunClaim(
            run_id=run_id,
            won=False,
            status=STATUS_COMPLETE,
            replay=result if isinstance(result, dict) else None,
        )

    logger.warning(
        "idempotency.rerun",
        run_id=run_id,
        tool=tool,
        op=op,
        prior_status=status,
        attempts=int(prior.get("attempts") or 1),
    )
    await _update(
        client,
        run_id,
        {
            "status": STATUS_IN_PROGRESS,
            "attempts": int(prior.get("attempts") or 1) + 1,
            "error": None,
        },
    )
    return RunClaim(run_id=run_id, won=True, status=status)


async def complete_run(client: Any, *, run_id: str, result: dict[str, Any] | None) -> None:
    """Mark a run complete, recording its output when that output is small enough to keep."""
    if not run_id:
        return
    payload: dict[str, Any] = {"status": STATUS_COMPLETE, "error": None}
    kept = _small_enough(result)
    payload["result"] = kept
    payload["result_truncated"] = result is not None and kept is None
    await _update(client, run_id, payload)


async def fail_run(client: Any, *, run_id: str, error: str) -> None:
    """Mark a run failed so a later attempt is allowed to claim it again."""
    if not run_id:
        return
    await _update(client, run_id, {"status": STATUS_ERROR, "error": str(error)[:1000]})


def _small_enough(result: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(result, dict):
        return None
    try:
        if len(json.dumps(result, default=str).encode()) <= MAX_RESULT_BYTES:
            return result
    except Exception:  # pragma: no cover - a non-serialisable output is simply not kept
        return None
    return None


async def _read(client: Any, run_id: str) -> dict[str, Any] | None:
    try:
        resp = await client.table(TABLE).select("*").eq("run_id", run_id).limit(1).execute()
    except Exception as exc:
        logger.warning("idempotency.read_failed", run_id=run_id, error=str(exc)[:160])
        return None
    rows = await _rows(resp)
    return rows[0] if rows else None


async def _update(client: Any, run_id: str, patch: dict[str, Any]) -> None:
    try:
        await (
            client.table(TABLE)
            .update({**patch, "updated_at": datetime.now(UTC).isoformat()})
            .eq("run_id", run_id)
            .execute()
        )
    except Exception as exc:
        # Losing a ledger write is a bookkeeping failure, never a reason to fail the user's job.
        logger.warning("idempotency.update_failed", run_id=run_id, error=str(exc)[:160])


__all__ = [
    "MAX_RESULT_BYTES",
    "STATUS_COMPLETE",
    "STATUS_ERROR",
    "STATUS_IN_PROGRESS",
    "TABLE",
    "RunClaim",
    "claim_run",
    "complete_run",
    "fail_run",
]
