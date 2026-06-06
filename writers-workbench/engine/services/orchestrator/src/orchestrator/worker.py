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
from writer_engine.state_machine.durable import RedisSagaRepo
from writer_engine.state_machine.saga import StepRef, run_step_via_http
from writer_engine.telemetry.logging import get_logger

from .newsletter_saga import NewsletterSagaDriver
from .write_tools import WORKER_STEP_TIMEOUT_S, resolve_step_url

logger = get_logger("orchestrator.worker")


async def advance_newsletter_saga(_ctx: dict[str, Any], execution_id: str) -> dict[str, str]:
    """Advance the saga as far as possible. Persists state between stages."""
    driver = NewsletterSagaDriver(RedisSagaRepo())
    result = await driver.advance(UUID(execution_id))
    return {"execution_id": execution_id, "result": result.value}


async def run_write_tool_job(_ctx: dict[str, Any], tool: str, body: dict[str, Any]) -> dict[str, Any]:
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
    logger.info("worker.write_tool.start", tool=tool, op=op, chapter=chapter,
                project=body.get("project_id") or body.get("project_title"), user_id=body.get("user_id"))
    started = time.monotonic()
    try:
        out = await run_step_via_http(
            StepRef(name=tool, url=url), execution_id=uuid4(), payload=body,
            timeout_s=WORKER_STEP_TIMEOUT_S,
        )
    except Exception:
        # arq will retry per max_tries; log so a timeout/crash is attributable to the chapter.
        logger.exception("worker.write_tool.crashed", tool=tool, op=op, chapter=chapter,
                         duration_s=round(time.monotonic() - started, 1))
        raise
    dumped = out.model_dump(mode="json")
    status = dumped.get("status")
    logger.info("worker.write_tool.finish", tool=tool, op=op, chapter=chapter, status=status,
                duration_s=round(time.monotonic() - started, 1),
                error=(dumped.get("error") or {}).get("message") if status == "ERROR" else None)
    return dumped


def build_redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


class WorkerSettings:
    redis_settings = build_redis_settings()
    functions: ClassVar[list[Any]] = [advance_newsletter_saga, run_write_tool_job]
    queue_name = "newsletter"
    max_jobs = 16
    # Keep job results long enough for the UI/hub to poll a long generation (must outlive job_timeout).
    keep_result = 7200
    # job_timeout must cover the WORST case, not the solo case. A solo chapter is ~12 min, but under
    # 10-concurrent the shared Anthropic account output-TPM (90k Sonnet) + the per-process LLM
    # semaphore serialize ~90 sub-chapter calls across the batch, so a single chapter's wall-time
    # balloons well past 30 min. At 1800s arq was killing every job at exactly 30 min and retrying
    # (perpetual timeout->retry, 0 completions). Give heavy write jobs 90 min. MUST stay <= the
    # worker->step HTTP read timeout (WORKER_STEP_TIMEOUT_S) or the HTTP call dies first.
    job_timeout = 5400
    # Don't re-run expensive LLM work on a flake more than once (a real timeout shouldn't loop).
    max_tries = 2
