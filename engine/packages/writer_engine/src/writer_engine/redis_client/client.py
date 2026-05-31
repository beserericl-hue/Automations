"""Module-scoped async Redis client + helpers used everywhere we need pub/sub or KV."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

import redis.asyncio as redis

from writer_engine.config import get_settings

_redis: redis.Redis | None = None


async def get_redis() -> redis.Redis:
    """Return the process-wide async Redis client, creating it on first call."""
    global _redis
    if _redis is None:
        _redis = redis.from_url(get_settings().redis_url, decode_responses=True)
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
