"""Cache the result of an async callable under a key in Redis for ``ttl`` seconds.

Used by every step service: a step keyed on ``(execution_id, step_name)`` replays cheaply on retry.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import TypeVar, cast

from writer_engine.redis_client import client as _redis_module

T = TypeVar("T")


async def idempotent_call(
    key: str,
    *,
    ttl_seconds: int = 24 * 60 * 60,
    func: Callable[[], Awaitable[T]],
    serializer: Callable[[T], str] = lambda v: json.dumps(v, default=str),
    deserializer: Callable[[str], T] = json.loads,
) -> T:
    """Return cached result for ``key`` or compute + cache it."""
    client = await _redis_module.get_redis()
    cached = await client.get(f"idem:{key}")
    if cached is not None:
        return cast(T, deserializer(cached))
    result = await func()
    await client.set(f"idem:{key}", serializer(result), ex=ttl_seconds)
    return result
