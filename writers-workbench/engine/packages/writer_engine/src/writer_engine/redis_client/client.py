"""Module-scoped async Redis client + helpers used everywhere we need pub/sub or KV."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

import redis.asyncio as redis

from writer_engine.config import get_settings

_redis: redis.Redis | None = None


async def get_redis() -> redis.Redis:
    """Return the process-wide async Redis client, creating it on first call.

    The connection options are the ones the B11 load test asked for. At 20 concurrent users a
    connect attempt timed out and killed an arq worker (arq's own default is a 1s connect timeout);
    Redis was busy, not down. Everything this client carries — the queues, the shared provider
    budgets, the HITL gates, SSE — is better served by waiting a few seconds than by erroring.

    * ``socket_connect_timeout`` / ``socket_timeout``: generous enough to ride out a busy moment,
      short enough that a genuinely dead Redis is still noticed inside one readiness cycle.
    * ``retry_on_timeout``: redis-py retries the command rather than surfacing a timeout that most
      call sites would only log and swallow, silently losing a budget reservation or a gate write.
    * ``health_check_interval``: pings an idle pooled connection before reuse, which is what
      prevents the "first request after a quiet period fails" class of error behind a proxy.
    * ``max_connections``: a ceiling, so a burst cannot open unbounded sockets.
    """
    global _redis
    if _redis is None:
        settings = get_settings()
        _redis = redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=settings.redis_connect_timeout_s,
            socket_timeout=settings.redis_connect_timeout_s,
            retry_on_timeout=True,
            health_check_interval=30,
            max_connections=settings.redis_max_connections,
        )
    return _redis


async def close_redis() -> None:
    """Close the client. Call from FastAPI lifespan on shutdown."""
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


def progress_channel(execution_id: UUID | str) -> str:
    """Standard SSE pub/sub channel for an execution."""
    return f"engine:exec:{execution_id}"


async def publish_progress(execution_id: UUID | str, event: dict[str, Any]) -> None:
    """Publish a progress event for SSE consumers."""
    client = await get_redis()
    await client.publish(progress_channel(execution_id), json.dumps(event, default=str))
