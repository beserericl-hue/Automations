"""arq worker entry point for the newsletter saga.

A single task ``advance_newsletter_saga`` is registered. Each invocation loads the saga state, advances as many
stages as possible, and exits when a HITL gate is reached or the saga terminates. The resolve endpoint
re-enqueues the same task to drive the next batch of stages.

Run with::

    uv run arq orchestrator.worker.WorkerSettings
"""

from __future__ import annotations

from typing import Any, ClassVar
from uuid import UUID, uuid4

from arq.connections import RedisSettings

from writer_engine.config import get_settings
from writer_engine.state_machine.durable import RedisSagaRepo
from writer_engine.state_machine.saga import StepRef, run_step_via_http

from .newsletter_saga import NewsletterSagaDriver
from .write_tools import WORKER_STEP_TIMEOUT_S, resolve_step_url


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
        return {"status": "error", "error": {"code": "UNKNOWN_TOOL", "message": tool}}
    out = await run_step_via_http(
        StepRef(name=tool, url=url), execution_id=uuid4(), payload=body, timeout_s=WORKER_STEP_TIMEOUT_S
    )
    return out.model_dump(mode="json")


def build_redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


class WorkerSettings:
    redis_settings = build_redis_settings()
    functions: ClassVar[list[Any]] = [advance_newsletter_saga, run_write_tool_job]
    queue_name = "newsletter"
    max_jobs = 16
    # Keep job results long enough for the UI/hub to poll a multi-minute generation.
    keep_result = 3600
    # arq's default job_timeout is 300s — too short for a full-novel outline or a 5-sub-chapter
    # fan-out (10-15 min). Without this, arq kills the job at 300s and retries it forever
    # (perpetual in_progress -> error). Give heavy write jobs 30 min, and don't re-run expensive
    # LLM work on a flake more than once.
    job_timeout = 1800
    max_tries = 2
