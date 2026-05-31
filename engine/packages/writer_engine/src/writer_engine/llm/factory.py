"""Convenience factory — build an :class:`LLMRouter` from configured env keys."""

from __future__ import annotations

from writer_engine.config import get_settings

from .router import LLMRouter

_router: LLMRouter | None = None


def get_router(service: str = "writer-engine") -> LLMRouter:
    """Return a singleton router with every adapter we have an API key for. Missing keys → adapter skipped."""
    global _router
    if _router is not None:
        return _router
    router = LLMRouter()
    settings = get_settings()
    if settings.anthropic_api_key:
        from .anthropic_client import AnthropicAdapter

        router.register(AnthropicAdapter(service=service))
    if settings.gemini_api_key:
        from .gemini_client import GeminiAdapter

        router.register(GeminiAdapter(service=service))
    if settings.perplexity_api_key:
        from .perplexity_client import PerplexityAdapter

        router.register(PerplexityAdapter(service=service))
    _router = router
    return router


def reset_router() -> None:
    """Test helper — drop the cached router."""
    global _router
    _router = None
