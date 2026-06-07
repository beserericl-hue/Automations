"""LLM response envelope + multi-provider router stub."""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Protocol


class ProviderNotRegistered(KeyError):
    """Raised when an adapter for the requested provider was never registered on the router.

    Step services catch this specifically to fall back to local fixtures while letting real provider
    errors (rate limits, network, validation) surface unmasked. Subclasses KeyError for back-compat
    with earlier ``except KeyError:`` fallback paths.
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
      * the Redis-shared ``AnthropicBudget`` (``budget``) so ALL instances together stay under the
        account-wide per-minute TPM/RPM — the call WAITS for budget rather than failing on 429.
    Both are optional: with neither set (tests / local), the router is a plain dispatcher.
    """

    def __init__(self, *, budget: object | None = None, max_concurrent: int = 0,
                 budget_max_wait_s: float = 300.0) -> None:
        self._adapters: dict[str, LLMAdapter] = {}
        self._budget = budget
        self._budget_max_wait_s = budget_max_wait_s
        self._sem = asyncio.Semaphore(max_concurrent) if max_concurrent and max_concurrent > 0 else None

    def register(self, adapter: LLMAdapter) -> None:
        self._adapters[adapter.provider] = adapter

    async def _dispatch(
        self, *, provider: str, model: str, prompt: str, system: str | None,
        max_tokens: int, temperature: float, cache_system: bool, stream: bool,
    ) -> LLMResponse:
        # Reserve account-wide budget for Anthropic (queues if the per-minute window is full).
        # Budget exhausted past max_wait or a Redis hiccup -> proceed anyway; the adapter's 429
        # retry/backoff is the final backstop. Never block a job forever here.
        if provider == "anthropic" and self._budget is not None:
            est_in = (len(prompt) + len(system or "")) // 4  # ~4 chars/token
            with contextlib.suppress(Exception):
                await self._budget.wait_for_capacity(
                    model=model, input_tokens=est_in, output_tokens=max_tokens,
                    max_wait_s=self._budget_max_wait_s,
                )
        resp = await self._adapters[provider].complete(
            model=model, system=system, prompt=prompt, max_tokens=max_tokens,
            temperature=temperature, cache_system=cache_system, stream=stream,
        )
        if provider == "anthropic" and self._budget is not None:
            with contextlib.suppress(Exception):
                await self._budget.record_usage(
                    model=resp.model or model, input_tokens=resp.input_tokens,
                    output_tokens=resp.output_tokens,
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
            raise ProviderNotRegistered(f"unknown LLM provider: {provider}")
        kwargs = dict(
            provider=provider, model=model, prompt=prompt, system=system,
            max_tokens=max_tokens, temperature=temperature, cache_system=cache_system, stream=stream,
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
                provider=provider, model=resp.model or model,
                input_tokens=resp.input_tokens, output_tokens=resp.output_tokens,
                cache_read=resp.cache_read_tokens, cache_write=resp.cache_write_tokens,
            )
        except Exception:  # accounting must never break a generation
            pass
        return resp
