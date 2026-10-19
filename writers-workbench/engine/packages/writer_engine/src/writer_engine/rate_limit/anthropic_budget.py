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
from dataclasses import dataclass
from typing import TYPE_CHECKING

from writer_engine.rate_limit import window as _window
from writer_engine.redis_client import client as _redis_module
from writer_engine.telemetry.logging import get_logger

if TYPE_CHECKING:
    import redis.asyncio as redis

logger = get_logger("rate_limit.anthropic_budget")

_UNGATED_WARN_INTERVAL_S = 60.0
"""How often to repeat the "budgets are not being enforced" warning.

Once per call would be thousands of identical lines a minute during a Redis blip, which is its own
kind of silence."""

_last_ungated_warning = 0.0


def _warn_ungated(where: str, error: str = "") -> None:
    """Say out loud that rate limiting is OFF.

    C4: `_client()` returned None on any Redis failure and the caller then returned True, so a Redis
    blip silently removed EVERY provider budget — the engine would hammer providers into 429s, or
    spend without a cap, with nothing in the logs to say the guard had gone. Redis died unnoticed
    for nine days in May; this is the same shape of failure one layer down.
    """
    global _last_ungated_warning
    now = time.time()
    if now - _last_ungated_warning < _UNGATED_WARN_INTERVAL_S:
        return
    _last_ungated_warning = now
    logger.warning(
        "rate_limit.unenforced",
        where=where,
        error=error[:160],
        consequence="provider rate limits are NOT being applied while Redis is unreachable",
    )


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

# The window itself lives in rate_limit.window (shared with the per-provider budget, B8).
_WINDOW_S = _window.WINDOW_S
_POLL_INTERVAL_S = 0.5


class AnthropicBudget:
    """Sliding-window per-model budget enforcer for the Anthropic provider."""

    def __init__(
        self,
        *,
        redis_client: redis.Redis | None = None,
        limits: dict[str, ModelLimits] | None = None,
        key_prefix: str = "engine:llm-budget:anthropic",
    ) -> None:
        self._redis = redis_client
        self._limits = limits or DEFAULT_LIMITS
        self._prefix = key_prefix

    def limits_for(self, model: str) -> ModelLimits:
        return self._limits.get(model, _DEFAULT_UNKNOWN)

    async def _client(self) -> redis.Redis | None:
        if self._redis is not None:
            return self._redis
        try:
            return await _redis_module.get_redis()
        except Exception as exc:
            # NOT silent: callers treat None as "no budget to check" and proceed.
            _warn_ungated("anthropic_budget", f"{type(exc).__name__}: {exc}")
            return None

    def _key(self, model: str, kind: str) -> str:
        return f"{self._prefix}:{model}:{kind}"

    async def _current(self, client: redis.Redis, model: str, kind: str) -> int:
        """Window usage, or 0 when Redis cannot answer.

        Same lazy-connection trap as ProviderBudget._usage: redis-py fails on the first COMMAND, not
        when the client is built, so an unguarded read turns a Redis outage into a raise. Reporting
        0 means the budget believes there is headroom and lets the call through — the provider's own
        429 handling is the backstop, and that is the right failure direction for a rate gate.
        """
        try:
            return await _window.current(client, self._key(model, kind))
        except Exception as exc:
            logger.warning("budget.unavailable", model=model, error=f"{type(exc).__name__}: {str(exc)[:120]}")
            return 0

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
        start = time.time()
        deadline = start + max_wait_s
        stalled = False
        while True:
            in_used = await self._current(client, model, "input")
            out_used = await self._current(client, model, "output")
            req_used = await self._current(client, model, "requests")
            if (
                in_used + input_tokens <= limits.input_tpm
                and out_used + output_tokens <= limits.output_tpm
                and req_used + 1 <= limits.rpm
            ):
                if stalled:
                    # We queued for TPM/RPM headroom and then got it — this is "queued", not "hung".
                    logger.info(
                        "budget.capacity_granted",
                        model=model,
                        waited_s=round(time.time() - start, 1),
                        in_used=in_used,
                        out_used=out_used,
                        req_used=req_used,
                    )
                return
            if not stalled:
                # First time we couldn't proceed: log WHICH limit is the bottleneck under load.
                stalled = True
                logger.info(
                    "budget.stall",
                    model=model,
                    in_used=in_used,
                    in_limit=limits.input_tpm,
                    out_used=out_used,
                    out_limit=limits.output_tpm,
                    req_used=req_used,
                    req_limit=limits.rpm,
                    want_in=input_tokens,
                    want_out=output_tokens,
                    max_wait_s=max_wait_s,
                )
            if time.time() >= deadline:
                logger.warning(
                    "budget.exhausted",
                    model=model,
                    waited_s=round(time.time() - start, 1),
                    in_used=in_used,
                    out_used=out_used,
                    req_used=req_used,
                )
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
        token = _window.new_token()
        try:
            # Even when one number is 0 we still want the request to count toward RPM.
            await _window.record(client, self._key(model, "input"), input_tokens, token=token)
            await _window.record(client, self._key(model, "output"), output_tokens, token=token)
            await _window.record(client, self._key(model, "requests"), 1, token=token)
        except Exception as exc:
            logger.warning(
                "budget.record_failed", model=model, error=f"{type(exc).__name__}: {str(exc)[:120]}"
            )

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
