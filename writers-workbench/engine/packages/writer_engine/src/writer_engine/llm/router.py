"""LLM response envelope + multi-provider router stub."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Protocol

from writer_engine.telemetry.logging import get_logger

logger = get_logger("llm.router")


class ProviderNotRegistered(KeyError):
    """Raised when an adapter for the requested provider was never registered on the router.

    Step services catch this specifically to fall back to local fixtures while letting real provider
    errors (rate limits, network, validation) surface unmasked. Subclasses KeyError for back-compat
    with earlier ``except KeyError:`` fallback paths.

    Only raised when fixture fallback is ENABLED — see :class:`ProviderNotConfigured`.
    """


class ProviderNotConfigured(RuntimeError):
    """A provider has no adapter AND fixture fallback is disabled for this environment (A1).

    Deliberately **not** a subclass of :class:`ProviderNotRegistered` (nor of ``KeyError``): the ~23
    ``except ProviderNotRegistered:`` fallback handlers across the step services must NOT catch it.
    Raising a different type is what turns "key missing" from a silent placeholder result into a
    ``StepOutput(status=ERROR)`` at every one of those sites at once, without editing each one — and
    without any site being able to opt itself back into faking success.
    """


@dataclass(frozen=True)
class LLMResponse:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    model: str = ""
    provider: str = ""
    citations: tuple[str, ...] = ()


class TokenBudget(Protocol):
    """The slice of ``rate_limit.LLMBudget`` the router depends on.

    Declared as a Protocol rather than typing ``budget`` as ``object`` so the two calls below are
    type-checked. ``provider`` is part of the shape (B8): the router gates EVERY provider, and which
    gate applies — Anthropic's per-model token budget or the per-provider request budget — is the
    budget's business, not the router's.
    """

    async def wait_for_capacity(
        self, *, provider: str, model: str, input_tokens: int, output_tokens: int, max_wait_s: float
    ) -> None: ...

    async def record_usage(
        self, *, provider: str, model: str, input_tokens: int, output_tokens: int
    ) -> None: ...


class LLMAdapter(Protocol):
    provider: str

    async def complete(
        self,
        *,
        model: str,
        system: str | None,
        prompt: str,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        cache_system: bool = True,
        stream: bool = False,
    ) -> LLMResponse: ...


class LLMRouter:
    """Dispatch a call to the right adapter by provider name. Lazy adapter construction.

    Scaling (CR-003): the router is the single choke point for every LLM call, so it enforces two
    limits here:
      * a per-INSTANCE concurrency semaphore (``max_concurrent``) so one engine instance handling ~10
        users never oversubscribes;
      * the Redis-shared ``LLMBudget`` (``budget``) so ALL instances together stay under each
        provider's account-wide per-minute limit — the call WAITS for budget rather than failing on
        429. Anthropic is gated on tokens (it publishes its ceilings in response headers); every
        other provider is gated on requests per minute (B8).
    Both are optional: with neither set (tests / local), the router is a plain dispatcher.
    """

    def __init__(
        self,
        *,
        budget: TokenBudget | None = None,
        max_concurrent: int = 0,
        budget_max_wait_s: float = 300.0,
    ) -> None:
        self._adapters: dict[str, LLMAdapter] = {}
        self._budget = budget
        self._budget_max_wait_s = budget_max_wait_s
        self._sem = asyncio.Semaphore(max_concurrent) if max_concurrent and max_concurrent > 0 else None

    def register(self, adapter: LLMAdapter) -> None:
        self._adapters[adapter.provider] = adapter

    async def _dispatch(
        self,
        *,
        provider: str,
        model: str,
        prompt: str,
        system: str | None,
        max_tokens: int,
        temperature: float,
        cache_system: bool,
        stream: bool,
    ) -> LLMResponse:
        # Reserve account-wide budget (queues if the provider's per-minute window is full).
        # Budget exhausted past max_wait or a Redis hiccup -> proceed anyway; the adapter's 429
        # retry/backoff is the final backstop. Never block a job forever here.
        if self._budget is not None:
            est_in = (len(prompt) + len(system or "")) // 4  # ~4 chars/token
            try:
                await self._budget.wait_for_capacity(
                    provider=provider,
                    model=model,
                    input_tokens=est_in,
                    output_tokens=max_tokens,
                    max_wait_s=self._budget_max_wait_s,
                )
            except Exception as exc:
                # Logged, not swallowed: a suppressed TypeError here (a budget whose signature has
                # drifted) would silently disable rate limiting across the whole engine, and the
                # first symptom would be a wall of 429s under load.
                logger.warning(
                    "router.budget_wait_failed",
                    provider=provider,
                    model=model,
                    error=f"{type(exc).__name__}: {str(exc)[:160]}",
                )
        resp = await self._adapters[provider].complete(
            model=model,
            system=system,
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            cache_system=cache_system,
            stream=stream,
        )
        if self._budget is not None:
            try:
                await self._budget.record_usage(
                    provider=provider,
                    model=resp.model or model,
                    input_tokens=resp.input_tokens,
                    output_tokens=resp.output_tokens,
                )
            except Exception as exc:
                logger.warning(
                    "router.budget_record_failed",
                    provider=provider,
                    error=f"{type(exc).__name__}: {str(exc)[:160]}",
                )
        return resp

    async def complete(
        self,
        *,
        provider: str,
        model: str,
        prompt: str,
        system: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        cache_system: bool = True,
        stream: bool = False,
    ) -> LLMResponse:
        if provider not in self._adapters:
            # A1: a provider with no adapter almost always means its API key is absent or mistyped
            # in this environment. Unless fixtures are explicitly enabled, refuse with a type the
            # step services' fixture handlers do not catch, so the step reports an error instead of
            # persisting and emailing placeholder content as real work.
            from writer_engine.fixtures import fixture_fallback_allowed

            msg = (
                f"LLM provider '{provider}' has no registered adapter — its API key is most likely "
                f"unset for this environment"
            )
            if not fixture_fallback_allowed():
                raise ProviderNotConfigured(
                    f"{msg}. Fixture fallback is disabled (ALLOW_FIXTURE_FALLBACK is not set), so "
                    f"this call will not be replaced with placeholder content."
                )
            raise ProviderNotRegistered(msg)
        # Annotated dict[str, Any]: inferred as dict[str, float | int | str | None], which makes the
        # **splat below a type error on every parameter without catching anything real.
        kwargs: dict[str, Any] = dict(
            provider=provider,
            model=model,
            prompt=prompt,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
            cache_system=cache_system,
            stream=stream,
        )
        if self._sem is not None:
            async with self._sem:
                resp = await self._dispatch(**kwargs)
        else:
            resp = await self._dispatch(**kwargs)
        # CR-007: record token usage for billing (best-effort; no-op when no accounting context set).
        try:
            from writer_engine.telemetry import token_accounting

            token_accounting.record(
                provider=provider,
                model=resp.model or model,
                input_tokens=resp.input_tokens,
                output_tokens=resp.output_tokens,
                cache_read=resp.cache_read_tokens,
                cache_write=resp.cache_write_tokens,
            )
        except Exception:  # accounting must never break a generation
            pass
        return resp
