"""Simple sliding-window rate limit using ``INCR`` + ``EXPIRE``.

Per-key, per-window — e.g. ``allow(key="apikey:abc", limit=60, window_s=60)`` for 60 RPM per key.
Good enough for F0; replaced with token-bucket if/when finer fairness is needed.
"""

from __future__ import annotations

from writer_engine.redis_client import client as _redis_module


async def allow(key: str, *, limit: int, window_s: int) -> bool:
    """Return ``True`` if the request fits in the current window, ``False`` if exceeded."""
    client = await _redis_module.get_redis()
    rkey = f"rl:{key}:{window_s}"
    count = await client.incr(rkey)
    if count == 1:
        await client.expire(rkey, window_s)
    return int(count) <= limit
