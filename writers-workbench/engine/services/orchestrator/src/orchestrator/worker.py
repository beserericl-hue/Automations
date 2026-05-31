"""arq worker entry point for the newsletter saga.

A single task ``advance_newsletter_saga`` is registered. Each invocation loads the saga state, advances as many
stages as possible, and exits when a HITL gate is reached or the saga terminates. The resolve endpoint
re-enqueues the same task to drive the next batch of stages.

Run with::

    uv run arq orchestrator.worker.WorkerSettings
"""

from __future__ import annotations

from typing import Any, ClassVar
from uuid import UUID

from arq.connections import RedisSettings

from writer_engine.config import get_settings
from writer_engine.state_machine.durable import RedisSagaRepo

from .newsletter_saga import NewsletterSagaDriver


async def advance_newsletter_saga(_ctx: dict[str, Any], execution_id: str) -> dict[str, str]:
    """Advance the saga as far as possible. Persists state between stages."""
    driver = NewsletterSagaDriver(RedisSagaRepo())
    result = await driver.advance(UUID(execution_id))
    return {"execution_id": execution_id, "result": result.value}


def build_redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


class WorkerSettings:
    redis_settings = build_redis_settings()
    functions: ClassVar[list[Any]] = [advance_newsletter_saga]
    queue_name = "newsletter"
    max_jobs = 16
