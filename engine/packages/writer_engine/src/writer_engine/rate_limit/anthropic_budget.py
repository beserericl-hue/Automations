"""Per-model token + request budget for Anthropic calls, Redis-backed sliding window.

Anthropic enforces three independent per-minute limits per model: input-tokens-TPM,
output-tokens-TPM, and requests-RPM. The numbers are in the ``anthropic-ratelimit-*``
response headers and live on a true 60-second sliding window. This module mirrors that
window so the chapter step (which fans 5-8 sub-chapter calls in parallel) can reserve
budget BEFORE issuing the call and queue if exhausted, rather than burning latency on
HTTP 429 + retry-after.

The two-call usage is intentionally simple:

    budget = AnthropicBudget()
    await budget.wait_for_capacity(model="claude-sonnet-4-6", input_tokens=8000, output_tokens=3000)
    resp = await router.complete(...)
    await budget.record_usage(model=resp.model, input_tokens=resp.input_tokens, output_tokens=resp.output_tokens)

If Redis is unconfigured (e.g. local dev without ``REDIS_URL``), the budget is a no-op:
``wait_for_capacity`` returns immediately and ``record_usage`` does nothing. This keeps
the test stack and ``InMemorySagaRepo`` flows working without a Redis dependency.

Defaults match Anthropic Tier 4 (Scale) — confirmed on 2026-05-31 via the
``anthropic-ratelimit-*`` headers on a probe call against each model:

    claude-sonnet-4-6:          450k input TPM,  90k output TPM, 1000 RPM
    claude-haiku-4-5-20251001:  450k input TPM,  90k output TPM, 1000 RPM
    claude-opus-4-8:           2000k input TPM, 200k output TPM, 1000 RPM

Override via constructor or by patching :data:`DEFAULT_LIMITS`. The window is 60 seconds
because that's the Anthropic enforcement boundary.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING

from writer_engine.redis_client import client as _redis_module

if TYPE_CHECKING:
    import redis.asyncio as redis


class BudgetExhausted(RuntimeError):
    """Raised when ``wait_for_capacity`` could not secure budget within ``max_wait_s``."""


@dataclass(frozen=True)
class ModelLimits:
    """Per-minute budget for one Anthropic model."""

    input_tpm: int
    output_tpm: int
    rpm: int


# Tier 4 / Scale defaults — see module docstring.
DEFAULT_LIMITS: dict[str, ModelLimits] = {
    "claude-sonnet-4-6": ModelLimits(input_tpm=450_000, output_tpm=90_000, rpm=1_000),
    "claude-haiku-4-5-20251001": ModelLimits(input_tpm=450_000, output_tpm=90_000, rpm=1_000),
    "claude-opus-4-8": ModelLimits(input_tpm=2_000_000, output_tpm=200_000, rpm=1_000),
}

# Conservative fallback for any unknown model id — half of the smallest Tier-4 model.
_DEFAULT_UNKNOWN = ModelLimits(input_tpm=225_000, output_tpm=45_000, rpm=500)

_WINDOW_S = 60.0
_POLL_INTERVAL_S = 0.5


class AnthropicBudget:
    """Sliding-window per-model budget enforcer for the Anthropic provider."""

    def __init__(
        self,
        *,
        redis_client: "redis.Redis | None" = None,
        limits: dict[str, ModelLimits] | None = None,
        key_prefix: str = "engine:llm-budget:anthropic",
    ) -> None:
        self._redis = redis_client
        self._limits = limits or DEFAULT_LIMITS
        self._prefix = key_prefix

    def limits_for(self, model: str) -> ModelLimits:
        return self._limits.get(model, _DEFAULT_UNKNOWN)

    async def _client(self) -> "redis.Redis | None":
        if self._redis is not None:
            return self._redis
        try:
            return await _redis_module.get_redis()
        except Exception:
            return None

    def _key(self, model: str, kind: str) -> str:
        return f"{self._prefix}:{model}:{kind}"

    async def _current(self, client: "redis.Redis", model: str, kind: str) -> int:
        key = self._key(model, kind)
        now = time.time()
        cutoff = now - _WINDOW_S
        await client.zremrangebyscore(key, "-inf", cutoff)
        members = await client.zrangebyscore(key, cutoff, "+inf")
        total = 0
        for m in members:
            try:
                _, count = m.rsplit(":", 1)
                total += int(count)
            except (ValueError, AttributeError):
                continue
        return total

    async def wait_for_capacity(
        self,
        *,
        model: str,
        input_tokens: int,
        output_tokens: int,
        max_wait_s: float = 30.0,
    ) -> None:
        """Block until the next call's projected usage fits the model's 60s window.

        Raises :class:`BudgetExhausted` if capacity does not free up within ``max_wait_s``.
        """
        client = await self._client()
        if client is None:
            return
        limits = self.limits_for(model)
        deadline = time.time() + max_wait_s
        while True:
            in_used = await self._current(client, model, "input")
            out_used = await self._current(client, model, "output")
            req_used = await self._current(client, model, "requests")
            if (
                in_used + input_tokens <= limits.input_tpm
                and out_used + output_tokens <= limits.output_tpm
                and req_used + 1 <= limits.rpm
            ):
                return
            if time.time() >= deadline:
                raise BudgetExhausted(
                    f"Anthropic budget exhausted for {model} after {max_wait_s:.1f}s "
                    f"(in={in_used}/{limits.input_tpm}, out={out_used}/{limits.output_tpm}, "
                    f"req={req_used}/{limits.rpm})"
                )
            await asyncio.sleep(_POLL_INTERVAL_S)

    async def record_usage(
        self,
        *,
        model: str,
        input_tokens: int,
        output_tokens: int,
    ) -> None:
        """Record an actual call's usage in the sliding window. Safe to call after the LLM responds."""
        client = await self._client()
        if client is None:
            return
        now = time.time()
        token = uuid.uuid4().hex[:12]
        # Even when one number is 0 we still want the request to count toward RPM.
        if input_tokens > 0:
            await client.zadd(self._key(model, "input"), {f"{token}:{input_tokens}": now})
            await client.expire(self._key(model, "input"), int(_WINDOW_S * 2))
        if output_tokens > 0:
            await client.zadd(self._key(model, "output"), {f"{token}:{output_tokens}": now})
            await client.expire(self._key(model, "output"), int(_WINDOW_S * 2))
        await client.zadd(self._key(model, "requests"), {f"{token}:1": now})
        await client.expire(self._key(model, "requests"), int(_WINDOW_S * 2))

    async def snapshot(self, model: str) -> dict[str, int]:
        """Return current sliding-window usage for the model. Used by /metrics + admin."""
        client = await self._client()
        if client is None:
            return {"input_tokens": 0, "output_tokens": 0, "requests": 0}
        return {
            "input_tokens": await self._current(client, model, "input"),
            "output_tokens": await self._current(client, model, "output"),
            "requests": await self._current(client, model, "requests"),
        }
