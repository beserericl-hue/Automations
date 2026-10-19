"""The 60-second sliding counter both budgets are built on.

Extracted from ``anthropic_budget`` when the per-provider budget (B8) needed the same window. The
window arithmetic is the part that is easy to get subtly wrong — an off-by-one on the cutoff, or a
missing key expiry that leaks a zset per model forever — so it exists once and is tested once rather
than being copied per provider.

Why a sorted set rather than ``INCR`` + ``EXPIRE`` (which ``sliding_window.allow`` uses): a fixed
window lets a caller spend the whole minute's allowance in the last second of one window and again in
the first second of the next, i.e. 2x the limit across a one-second boundary. Providers enforce a
true rolling 60 seconds, so the gate has to as well or it will report headroom that a 429 then
contradicts.

Each member is ``"<token>:<count>"`` scored by its timestamp, so one key holds the window for one
(scope, kind) pair and the sum of the counts is the current usage.
"""

from __future__ import annotations

import time
import uuid
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import redis.asyncio as redis

WINDOW_S = 60.0
"""The providers' own enforcement boundary. Not configurable for that reason."""

# Keys are kept for two windows so a crash mid-window cannot leave a stale counter alive forever,
# while a live counter is never expired out from under a caller.
_KEY_TTL_S = int(WINDOW_S * 2)


async def current(client: redis.Redis, key: str) -> int:
    """Sum of the counts recorded in the last ``WINDOW_S`` seconds, trimming what fell out."""
    cutoff = time.time() - WINDOW_S
    await client.zremrangebyscore(key, "-inf", cutoff)
    members = await client.zrangebyscore(key, cutoff, "+inf")
    total = 0
    for m in members:
        try:
            # Decoded here rather than assuming the client does it. `get_redis()` sets
            # decode_responses=True, so members arrive as str in this engine — but a client
            # constructed without it returns bytes, and `bytes.rsplit(":")` raises TypeError, which
            # the old `except (ValueError, AttributeError)` did not catch. The effect would have
            # been a budget that always reads zero usage and therefore never limits anything, from
            # one keyword argument in a caller nobody would think to check.
            text = m.decode("utf-8", "replace") if isinstance(m, bytes | bytearray) else str(m)
            _, count = text.rsplit(":", 1)
            total += int(count)
        except Exception:
            # A member written by an older/other format is ignored rather than crashing the gate:
            # over-counting or under-counting by one entry is survivable, refusing to answer is not.
            continue
    return total


async def record(client: redis.Redis, key: str, count: int, *, token: str | None = None) -> None:
    """Add ``count`` to ``key``'s window at the current instant."""
    if count <= 0:
        return
    member = f"{token or uuid.uuid4().hex[:12]}:{count}"
    await client.zadd(key, {member: time.time()})
    await client.expire(key, _KEY_TTL_S)


def new_token() -> str:
    """One id per call, so the several counters a single call touches can be correlated."""
    return uuid.uuid4().hex[:12]


__all__ = ["WINDOW_S", "current", "new_token", "record"]

STALL_KEY = "engine:budget:stalls"
"""Where a budget records that a call ACTUALLY had to wait for capacity.

Cross-process on purpose. The budgets live in the steps process; the queue sampler that has to
explain a backlog lives in the orchestrator. Prometheus counters are per-process, so they cannot
answer "is the account's token budget the thing holding this up?" from the other side — and without
an answer the sampler was guessing from queue age, which under a bulk submission is just depth.

Measured 2026-10-19 during a 96-chapter run: 89 jobs queued for 8 slots, oldest wait 429s, and
**zero** budget stalls. The verdict said "bounded by account-wide output TPM" and would have sent
somebody to buy a higher Anthropic tier for a queue that was simply deep.
"""


async def record_stall(client: redis.Redis, provider: str, model: str) -> None:
    """Note one stalled call. Best-effort: a telemetry write must not fail a generation."""
    try:
        await record(client, f"{STALL_KEY}:{provider}", 1)
        await record(client, STALL_KEY, 1)
    except Exception:  # pragma: no cover - never worth failing a call over
        return


async def stalls_in_window(client: redis.Redis, provider: str = "") -> int:
    """How many calls had to wait for token capacity in the last window. 0 when nothing stalled."""
    try:
        return await current(client, f"{STALL_KEY}:{provider}" if provider else STALL_KEY)
    except Exception:
        return 0
