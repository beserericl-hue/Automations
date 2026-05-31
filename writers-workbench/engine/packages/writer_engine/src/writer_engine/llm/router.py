"""LLM response envelope + multi-provider router stub."""

from __future__ import annotations

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
    ) -> LLMResponse: ...


class LLMRouter:
    """Dispatch a call to the right adapter by provider name. Lazy adapter construction."""

    def __init__(self) -> None:
        self._adapters: dict[str, LLMAdapter] = {}

    def register(self, adapter: LLMAdapter) -> None:
        self._adapters[adapter.provider] = adapter

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
    ) -> LLMResponse:
        if provider not in self._adapters:
            raise ProviderNotRegistered(f"unknown LLM provider: {provider}")
        return await self._adapters[provider].complete(
            model=model,
            system=system,
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            cache_system=cache_system,
        )
