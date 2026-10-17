"""Per-provider request budgets for every provider that is not Anthropic (B8).

Anthropic has had a Redis-shared per-model token budget since CR-003. Nothing else did, and the
others are not decorative: ``gemini`` routes every hub turn (voice and chat), ``perplexity`` is the
whole of ``research.run``, ``openai`` embeds project canon, ``firecrawl`` scrapes and ``kieai``
generates cover art. At one user that is invisible. At ten concurrent users each provider is being
called by up to 24 interactive jobs plus 8 heavy ones across however many instances are running, and
the account-wide per-minute limit is shared by all of them.

**These limits are caps WE chose, not limits we measured.** The Anthropic numbers in
``anthropic_budget`` came from that provider's ``anthropic-ratelimit-*`` response headers; no other
provider here returns its ceiling in a header we read, so the defaults below are deliberately
conservative and every one is overridable per environment with ``PROVIDER_RATE_LIMITS``. A cap that
is too low queues work that would have succeeded; a cap that is too high does nothing at all, which
is where we started. When a real ceiling is known for an account, set it in the env rather than
editing these.

Gating is on **requests per minute** rather than tokens, because requests are the limit these
providers actually publish and the only quantity knowable before the call. ``tpm`` exists for
``openai``, whose embedding limit is token-shaped.

Like the Anthropic budget, this FAILS OPEN: with no Redis, or with Redis unreachable, every call
proceeds. A rate gate that takes the engine down when its bookkeeping store blips is worse than the
429s it was added to prevent.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, TypeVar

from writer_engine.rate_limit import window as _window
from writer_engine.rate_limit.retry import with_retry
from writer_engine.redis_client import client as _redis_module
from writer_engine.telemetry.logging import get_logger

if TYPE_CHECKING:
    import redis.asyncio as redis

logger = get_logger("rate_limit.provider_budget")

_POLL_INTERVAL_S = 0.5

T = TypeVar("T")


@dataclass(frozen=True)
class ProviderLimits:
    """Per-minute cap for one provider. ``tpm`` of 0 means "do not gate on tokens"."""

    rpm: int
    tpm: int = 0


# Conservative defaults — see the module docstring on where these come from (us, not the providers).
DEFAULT_PROVIDER_LIMITS: dict[str, ProviderLimits] = {
    # Hub routing + the picker. Short structured calls, but one per conversational turn.
    "gemini": ProviderLimits(rpm=300),
    # research.run. The narrowest of the five in every published tier, and the easiest to exhaust
    # because a single research run issues several queries.
    "perplexity": ProviderLimits(rpm=40),
    # Embeddings only (text-embedding-3-small). Token-shaped limit, so both are set.
    "openai": ProviderLimits(rpm=500, tpm=1_000_000),
    # Scrape. One call per URL, fanned out per story in a newsletter.
    "firecrawl": ProviderLimits(rpm=50),
    # Image generation: slow, expensive, and polled. Low on purpose.
    "kieai": ProviderLimits(rpm=20),
    # Humanizer (E6). Billed per WORD with a hard 3000-word cap per request, so a single chapter is
    # 3+ calls and a "humanize all" would be dozens. Low rpm on purpose: the cost of being throttled
    # is a slower pass, and the cost of not being throttled is spending credits in a burst.
    "stealthgpt": ProviderLimits(rpm=30),
}

# Anthropic is deliberately absent: it has its own per-MODEL token budget, which is strictly more
# precise than an account-wide RPM. Gating it here as well would double-count.
EXCLUDED_PROVIDERS = frozenset({"anthropic"})

# A provider nobody has configured is not gated — an unknown name is far more likely to be a typo in
# a call site than a real provider whose limits we should be guessing at.
_UNGATED = ProviderLimits(rpm=0, tpm=0)


def parse_overrides(raw: str) -> dict[str, ProviderLimits]:
    """Parse ``PROVIDER_RATE_LIMITS``, e.g. ``"gemini=600,perplexity=30,openai=500/2000000"``.

    ``name=rpm`` or ``name=rpm/tpm``. An unparseable entry is logged and skipped rather than taking
    the process down at import time; a malformed rate limit must not stop the engine from starting.
    """
    out: dict[str, ProviderLimits] = {}
    for chunk in (raw or "").split(","):
        item = chunk.strip()
        if not item:
            continue
        name, _, value = item.partition("=")
        name = name.strip().lower()
        rpm_s, _, tpm_s = value.strip().partition("/")
        try:
            limits = ProviderLimits(rpm=int(rpm_s), tpm=int(tpm_s) if tpm_s else 0)
        except ValueError:
            logger.warning("provider_budget.bad_override", item=item)
            continue
        if not name:
            logger.warning("provider_budget.bad_override", item=item)
            continue
        out[name] = limits
    return out


def effective_limits(raw_overrides: str = "") -> dict[str, ProviderLimits]:
    """Defaults with ``PROVIDER_RATE_LIMITS`` applied on top."""
    merged = dict(DEFAULT_PROVIDER_LIMITS)
    for name, limits in parse_overrides(raw_overrides).items():
        # An override may raise OR lower a cap, and may introduce a provider not in the defaults.
        merged[name] = limits
    return merged


class ProviderBudget:
    """Redis-shared requests-per-minute gate, one window per (provider, model)."""

    def __init__(
        self,
        *,
        redis_client: redis.Redis | None = None,
        limits: dict[str, ProviderLimits] | None = None,
        key_prefix: str = "engine:llm-budget",
    ) -> None:
        self._redis = redis_client
        if limits is None:
            from writer_engine.config import get_settings

            limits = effective_limits(get_settings().provider_rate_limits)
        self._limits = limits
        self._prefix = key_prefix

    def limits_for(self, provider: str) -> ProviderLimits:
        if provider in EXCLUDED_PROVIDERS:
            return _UNGATED
        return self._limits.get(provider, _UNGATED)

    async def _client(self) -> redis.Redis | None:
        if self._redis is not None:
            return self._redis
        try:
            return await _redis_module.get_redis()
        except Exception:
            return None

    async def _usage(self, client: redis.Redis, provider: str, model: str, kind: str) -> int | None:
        """Window usage, or None when Redis could not answer.

        Guarding the COMMAND and not just the connection is the whole point. redis-py connects
        lazily, so an unreachable Redis does not fail when the client is created — it fails on the
        first command. The original version only caught the acquisition failure, so a Redis outage
        made this gate RAISE instead of fail open, and the raise propagated through call_provider
        into embeddings / firecrawl / kieai. Found by running the real retrieval path on a machine
        with no Redis; the test that was supposed to cover it only faked a failing ``get_redis``.
        """
        try:
            return await _window.current(client, self._key(provider, model, kind))
        except Exception as exc:
            logger.warning(
                "provider_budget.unavailable",
                provider=provider,
                model=model,
                error=f"{type(exc).__name__}: {str(exc)[:120]}",
            )
            return None

    def _key(self, provider: str, model: str, kind: str) -> str:
        # Keyed per model as well as per provider: gemini-flash and gemini-pro have different
        # ceilings in every published tier, so one shared window would gate the wrong thing.
        return f"{self._prefix}:{provider}:{model or '_'}:{kind}"

    async def wait_for_capacity(
        self,
        *,
        provider: str,
        model: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        max_wait_s: float = 30.0,
    ) -> bool:
        """Block until this call fits the provider's window. Returns False if it never did.

        Unlike ``AnthropicBudget``, this does NOT raise on exhaustion. The caller's decision is the
        same either way — make the call and let the provider's own 429 handling take over — and a
        raise here would have to be caught at every call site to mean that.
        """
        limits = self.limits_for(provider)
        if limits.rpm <= 0 and limits.tpm <= 0:
            return True
        client = await self._client()
        if client is None:
            return True

        tokens = max(0, input_tokens) + max(0, output_tokens)
        start = time.time()
        deadline = start + max_wait_s
        stalled = False
        while True:
            req_used = await self._usage(client, provider, model, "requests")
            if req_used is None:
                return True  # fail open: a bookkeeping outage must not block the call
            tok_used = 0
            if limits.tpm > 0:
                counted = await self._usage(client, provider, model, "tokens")
                if counted is None:
                    return True
                tok_used = counted
            req_ok = limits.rpm <= 0 or req_used + 1 <= limits.rpm
            tok_ok = limits.tpm <= 0 or tok_used + tokens <= limits.tpm
            if req_ok and tok_ok:
                if stalled:
                    logger.info(
                        "provider_budget.capacity_granted",
                        provider=provider,
                        model=model,
                        waited_s=round(time.time() - start, 1),
                    )
                return True
            if not stalled:
                stalled = True
                logger.info(
                    "provider_budget.stall",
                    provider=provider,
                    model=model,
                    req_used=req_used,
                    req_limit=limits.rpm,
                    tok_used=tok_used,
                    tok_limit=limits.tpm,
                    max_wait_s=max_wait_s,
                )
            if time.time() >= deadline:
                logger.warning(
                    "provider_budget.exhausted",
                    provider=provider,
                    model=model,
                    waited_s=round(time.time() - start, 1),
                    req_used=req_used,
                    req_limit=limits.rpm,
                )
                return False
            await asyncio.sleep(_POLL_INTERVAL_S)

    async def record_usage(
        self,
        *,
        provider: str,
        model: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        """Record one call against the provider's window."""
        limits = self.limits_for(provider)
        if limits.rpm <= 0 and limits.tpm <= 0:
            return
        client = await self._client()
        if client is None:
            return
        token = _window.new_token()
        try:
            await _window.record(client, self._key(provider, model, "requests"), 1, token=token)
            if limits.tpm > 0:
                total = max(0, input_tokens) + max(0, output_tokens)
                await _window.record(client, self._key(provider, model, "tokens"), total, token=token)
        except Exception as exc:
            # Losing a usage record under-counts the window; raising would fail the user's call.
            logger.warning(
                "provider_budget.record_failed",
                provider=provider,
                error=f"{type(exc).__name__}: {str(exc)[:120]}",
            )

    async def snapshot(self, provider: str, model: str) -> dict[str, int]:
        """Current window usage, for /metrics and admin."""
        client = await self._client()
        if client is None:
            return {"requests": 0, "tokens": 0}
        return {
            "requests": await self._usage(client, provider, model, "requests") or 0,
            "tokens": await self._usage(client, provider, model, "tokens") or 0,
        }

    def with_limits(self, **per_provider: ProviderLimits) -> ProviderBudget:
        """Test/ops helper — a copy with some providers' limits replaced."""
        return ProviderBudget(
            redis_client=self._redis,
            limits={**self._limits, **per_provider},
            key_prefix=self._prefix,
        )


class LLMBudget:
    """One object the router can call for any provider.

    Anthropic goes to its per-model token budget (precise, because that provider publishes its
    ceilings in response headers); everything else goes to the per-provider request budget. The
    router should not have to know which is which.
    """

    def __init__(self, *, anthropic: Any | None = None, providers: ProviderBudget | None = None) -> None:
        self._anthropic = anthropic
        self._providers = providers

    async def wait_for_capacity(
        self,
        *,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        max_wait_s: float = 30.0,
    ) -> None:
        if provider == "anthropic":
            if self._anthropic is not None:
                await self._anthropic.wait_for_capacity(
                    model=model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    max_wait_s=max_wait_s,
                )
            return
        if self._providers is not None:
            await self._providers.wait_for_capacity(
                provider=provider,
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                max_wait_s=max_wait_s,
            )

    async def record_usage(self, *, provider: str, model: str, input_tokens: int, output_tokens: int) -> None:
        if provider == "anthropic":
            if self._anthropic is not None:
                await self._anthropic.record_usage(
                    model=model, input_tokens=input_tokens, output_tokens=output_tokens
                )
            return
        if self._providers is not None:
            await self._providers.record_usage(
                provider=provider,
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )


def unlimited(provider: str) -> ProviderLimits:
    """The limits object meaning "not gated" — exported so tests can be explicit about it."""
    return replace(_UNGATED)


__all__ = [
    "DEFAULT_PROVIDER_LIMITS",
    "EXCLUDED_PROVIDERS",
    "LLMBudget",
    "ProviderBudget",
    "ProviderLimits",
    "call_provider",
    "effective_limits",
    "parse_overrides",
    "reset_shared_budget",
    "shared_budget",
    "unlimited",
]


# --- the one call site a non-LLM provider needs --------------------------------------------------
#
# The LLM providers are gated inside LLMRouter, which every LLM call already goes through. Firecrawl
# and KIE.AI have no such choke point — they are raw httpx calls inside step services — so they get
# this helper instead: reserve, retry, and record in one wrapper.

_shared: ProviderBudget | None = None


def shared_budget() -> ProviderBudget:
    """Process-wide budget instance. Cheap to construct; shared so limits are parsed once."""
    global _shared
    if _shared is None:
        _shared = ProviderBudget()
    return _shared


def reset_shared_budget() -> None:
    """Test helper — drop the cached instance so a test can install different limits."""
    global _shared
    _shared = None


async def call_provider(
    provider: str,
    func: Callable[[], Awaitable[T]],
    *,
    model: str = "",
    input_tokens: int = 0,
    output_tokens: int = 0,
    attempts: int = 4,
    max_wait_s: float = 30.0,
    budget: ProviderBudget | None = None,
) -> T:
    """Reserve budget for one call to ``provider``, make it with retries, and record it.

    Token counts are passed here rather than recorded separately by the caller: ``record_usage``
    always counts one request, so a second call to record tokens would count the request twice and
    halve the effective RPM.

    Usage is recorded in a ``finally`` because the provider counted the request whether or not it
    answered — a failed call that is not recorded makes the window under-report, which is how a gate
    quietly stops gating.
    """
    gate = budget or shared_budget()
    await gate.wait_for_capacity(
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        max_wait_s=max_wait_s,
    )
    try:
        return await with_retry(func, provider=provider, model=model, attempts=attempts)
    finally:
        await gate.record_usage(
            provider=provider,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
