"""arq worker entry point for the newsletter saga.

A single task ``advance_newsletter_saga`` is registered. Each invocation loads the saga state, advances as many
stages as possible, and exits when a HITL gate is reached or the saga terminates. The resolve endpoint
re-enqueues the same task to drive the next batch of stages.

Run with::

    uv run arq orchestrator.worker.WorkerSettings
"""

from __future__ import annotations

import time
from typing import Any, ClassVar
from uuid import UUID, uuid4

from arq.connections import RedisSettings

from writer_engine.config import get_settings
from writer_engine.idempotency import RunClaim, claim_run, complete_run, fail_run
from writer_engine.queues import (
    HEAVY,
    INTERACTIVE,
    KIND_CRASH,
    KIND_STEP_ERROR,
    QueueProfile,
    record_dead_letter,
)
from writer_engine.state_machine.durable import RedisSagaRepo
from writer_engine.state_machine.saga import StepRef, run_step_via_http
from writer_engine.telemetry.logging import get_logger

from .newsletter_saga import NewsletterSagaDriver
from .write_tools import WORKER_STEP_TIMEOUT_S, resolve_step_url

logger = get_logger("orchestrator.worker")


async def _dlq(
    ctx: dict[str, Any],
    function: str,
    args: Any,
    exc: BaseException | str,
    *,
    kind: str = KIND_CRASH,
) -> None:
    """Record a terminal job failure (B5).

    Recorded from inside the job rather than from arq's ``after_job_end`` hook, because that hook's
    ctx carries only ``job_id``/``job_try``/``enqueue_time``/``score`` — no exception and no args, so
    it cannot tell a failure from a success — and because arq's "max retries exceeded" branch returns
    before the hook is invoked at all.

    A plain exception IS terminal in arq: only ``Retry``, ``RetryJob`` and ``CancelledError`` re-queue
    a job, so ``max_tries`` does not give a crashed chapter write a second attempt. The one terminal
    case this cannot see is a job cancelled repeatedly by worker shutdown until it exceeds max_tries,
    which arq fails without ever entering the coroutine.
    """
    profile = ctx.get("queue_profile")
    detail = exc if isinstance(exc, str) else f"{type(exc).__name__}: {exc}"
    await record_dead_letter(
        queue=getattr(profile, "name", ""),
        function=function,
        args=args,
        error=detail,
        job_id=str(ctx.get("job_id") or "") or None,
        kind=kind,
    )


async def advance_newsletter_saga(ctx: dict[str, Any], execution_id: str) -> dict[str, str]:
    """Advance the saga as far as possible. Persists state between stages."""
    driver = NewsletterSagaDriver(RedisSagaRepo())
    try:
        result = await driver.advance(UUID(execution_id))
    except Exception as exc:
        await _dlq(ctx, "advance_newsletter_saga", {"execution_id": execution_id}, exc)
        raise
    return {"execution_id": execution_id, "result": result.value}


async def _ledger() -> Any | None:
    """The Supabase client for the run ledger, or None when it is not reachable.

    Deliberately soft: an engine configured without Supabase (the key-less local stack, the test
    suite) runs exactly as it did before B6 rather than refusing to work.
    """
    try:
        from writer_engine.supabase.client import get_supabase_admin

        return await get_supabase_admin()
    except Exception as exc:
        logger.warning("worker.ledger_unavailable", error=str(exc)[:160])
        return None


async def run_write_tool_job(ctx: dict[str, Any], tool: str, body: dict[str, Any]) -> dict[str, Any]:
    """Async write-tool job: dispatch to the step service off the request path (no edge timeout).

    The worker has no 300s edge limit, so a sub-chapter fan-out or a full-novel outline can run for
    minutes. Returns the StepOutput dict, which arq stores as the job result for polling.
    """
    url = resolve_step_url(tool, get_settings())
    if url is None:
        logger.error("worker.write_tool.unknown", tool=tool)
        return {"status": "error", "error": {"code": "UNKNOWN_TOOL", "message": tool}}
    chapter = body.get("chapter_number")
    op = body.get("op")

    # B6: claim the run before doing any work. arq re-queues a job on CancelledError (a worker
    # restart, a deploy, a SIGTERM mid-chapter), and four of the persist paths are plain INSERTs
    # that duplicate under that — including token_usage_v2, which is billing data. The run_id is
    # the arq job_id unless the caller supplied its own, so a retry shares it and a deliberate
    # second request does not. See writer_engine.idempotency.
    run_id = str(body.get("run_id") or ctx.get("job_id") or "")
    ledger = await _ledger() if run_id else None
    claim: RunClaim | None = None
    if ledger is not None:
        claim = await claim_run(
            ledger,
            run_id=run_id,
            tool=tool,
            op=str(op or ""),
            queue=getattr(ctx.get("queue_profile"), "name", ""),
            user_id=str(body.get("user_id") or ""),
            project_id=body.get("project_id"),
            chapter_number=chapter if isinstance(chapter, int) else None,
        )
        if claim.should_skip:
            logger.warning(
                "worker.write_tool.replay",
                tool=tool,
                op=op,
                chapter=chapter,
                run_id=run_id,
                replayed_result=claim.replay is not None,
            )
            # The original output when it was small enough to keep; otherwise a truthful envelope.
            # The Workbench polls a job for `status` and then refetches from the database, so this
            # does not change what a user sees — see client/src/hooks/useEngineJobQueue.ts.
            return claim.replay or {
                "status": "ok",
                "payload": {"result": {"idempotent_replay": True, "run_id": run_id}},
            }

    logger.info(
        "worker.write_tool.start",
        tool=tool,
        op=op,
        chapter=chapter,
        project=body.get("project_id") or body.get("project_title"),
        user_id=body.get("user_id"),
        run_id=run_id or None,
    )
    started = time.monotonic()
    try:
        out = await run_step_via_http(
            StepRef(name=tool, url=url),
            execution_id=uuid4(),
            payload=body,
            timeout_s=WORKER_STEP_TIMEOUT_S,
        )
    except Exception as exc:
        # Terminal: arq does not retry on a plain exception. Log so a timeout/crash is attributable
        # to the chapter, and record it so the failure survives the job's result expiry.
        logger.exception(
            "worker.write_tool.crashed",
            tool=tool,
            op=op,
            chapter=chapter,
            duration_s=round(time.monotonic() - started, 1),
        )
        await _dlq(
            ctx,
            "run_write_tool_job",
            {
                "tool": tool,
                "op": op,
                "chapter_number": chapter,
                "project_id": body.get("project_id") or body.get("project_title"),
                "user_id": body.get("user_id"),
            },
            exc,
        )
        if ledger is not None and claim is not None:
            # Release the claim so a later attempt may run. Without this a crashed run would be
            # permanently un-rerunnable.
            await fail_run(ledger, run_id=run_id, error=f"{type(exc).__name__}: {exc}")
        raise
    dumped = out.model_dump(mode="json")
    status = dumped.get("status")
    logger.info(
        "worker.write_tool.finish",
        tool=tool,
        op=op,
        chapter=chapter,
        status=status,
        duration_s=round(time.monotonic() - started, 1),
        error=(dumped.get("error") or {}).get("message") if str(status).lower() == "error" else None,
    )
    if str(status).lower() == "error":
        # The job did not crash, so nothing above recorded this — but the user's work still did not
        # get made, and arq drops the result after keep_result. Record it with its own kind so an
        # operator can tell a returned error from a crash.
        err = dumped.get("error") or {}
        await _dlq(
            ctx,
            "run_write_tool_job",
            {"tool": tool, "op": op, "chapter_number": chapter, "user_id": body.get("user_id")},
            f"{err.get('code') or 'ERROR'}: {err.get('message') or 'step returned error'}",
            kind=KIND_STEP_ERROR,
        )

    # CR-009: email the result + metadata on success (n8n parity). Best-effort — never affects the job.
    if str(status).lower() == "ok":
        try:
            from writer_engine.notifications.task_email import send_task_completion_email

            result = (dumped.get("payload") or {}).get("result") or {}
            await send_task_completion_email(tool, body, result)
        except Exception as exc:
            logger.warning("worker.task_email.error", tool=tool, error=str(exc)[:200])
    if ledger is not None and claim is not None:
        # A step that returns status=error is a real outcome, not a crash — record it as an error so
        # a retry is allowed to try again rather than replaying the failure forever.
        if str(status).lower() == "error":
            await fail_run(
                ledger,
                run_id=run_id,
                error=str((dumped.get("error") or {}).get("message") or "step returned error"),
            )
        else:
            await complete_run(ledger, run_id=run_id, result=dumped)
    return dumped


def build_redis_settings() -> RedisSettings:
    """arq connection settings, with the defaults that survived the B11 load test.

    arq ships ``conn_timeout=1`` — one second to complete a socket connect. Under 20 concurrent
    users that timed out, and arq treats a Redis error in its main loop as fatal: the worker exited
    rc=1 and (before the supervisor learned to restart a child) took the container with it. Redis
    was not down, it was busy.

    ``conn_retries``/``conn_retry_delay`` only cover pool CREATION, so they do not help a connection
    taken from the pool mid-run; the timeout is what matters there.
    """
    settings = get_settings()
    redis = RedisSettings.from_dsn(settings.redis_url)
    redis.conn_timeout = settings.redis_connect_timeout_s
    redis.max_connections = settings.redis_max_connections
    return redis


# The worker writes its heartbeat here; /admin/ready reads it (B2). Named explicitly rather than
# relying on arq's "<queue_name>:health-check" default so the reader can't drift from the writer.
ARQ_HEALTH_CHECK_KEY = "engine:arq:health-check"


def _build_worker_settings(profile: QueueProfile) -> type:
    """One arq Worker class per queue (B4/B5).

    arq's ``job_timeout``/``max_jobs``/``max_tries`` live on the Worker, not the job, so per-operation
    timeouts are only achievable by running a worker per queue. See writer_engine.queues for the
    sizing rationale.
    """

    async def _on_startup(ctx: dict[str, Any]) -> None:
        # The job ctx arq hands a task is {**worker.ctx, job_id, job_try, enqueue_time, score} — it
        # carries NO queue name. Stash the profile here so a failing job can name its own queue in
        # the DLQ entry.
        ctx["queue_profile"] = profile
        logger.info(
            "worker.start",
            queue=profile.name,
            max_jobs=profile.max_jobs,
            job_timeout=profile.job_timeout,
            max_tries=profile.max_tries,
        )

    class _Settings:
        redis_settings = build_redis_settings()
        functions: ClassVar[list[Any]] = [advance_newsletter_saga, run_write_tool_job]
        queue_name = profile.name
        max_jobs = profile.max_jobs
        job_timeout = profile.job_timeout
        max_tries = profile.max_tries
        keep_result = profile.keep_result
        on_startup = staticmethod(_on_startup)
        # Per-queue heartbeat key so /admin/ready can tell WHICH worker is down, not just that one is.
        health_check_key = f"{ARQ_HEALTH_CHECK_KEY}:{profile.name}"
        # arq defaults to 3600s, which would let a dead worker look alive for an hour — useless as a
        # heartbeat. 30s means /admin/ready notices a stopped worker within ~a minute.
        health_check_interval = 30
        # Allow a queued/running write job to be cancelled from the UI (Fix Drift "Cancel"). arq checks
        # for an abort flag at enqueue and between awaits, so a queued job is dropped immediately and a
        # running job is cancelled at its next await. Aborted jobs are NOT retried. Repairs snapshot
        # content_versions_v2, so a mid-flight cancel leaves the DB consistent.
        allow_abort_jobs = True

    _Settings.__name__ = f"WorkerSettings_{profile.name.replace('-', '_')}"
    return _Settings


# Two workers, one per queue. The entrypoint runs both (see writer_engine.runtime_processes).
WorkerSettingsHeavy = _build_worker_settings(HEAVY)
WorkerSettingsInteractive = _build_worker_settings(INTERACTIVE)

# Back-compat alias: `arq orchestrator.worker.WorkerSettings` now runs the HEAVY queue. Anything
# still referencing the old symbol keeps working rather than failing to start.
WorkerSettings = WorkerSettingsHeavy
