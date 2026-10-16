"""Convenience factory — build an :class:`LLMRouter` from configured env keys."""

from __future__ import annotations

from writer_engine.config import get_settings

from .router import LLMRouter

_router: LLMRouter | None = None


def get_router(service: str = "writer-engine") -> LLMRouter:
    """Return a singleton router with every adapter we have an API key for. Missing keys → adapter skipped.

    Built with the Redis-shared per-provider budgets + a per-instance concurrency cap so multi-user /
    multi-instance load stays under every provider's account rate limit (CR-003 scaling, B8).
    """
    global _router
    if _router is not None:
        return _router
    settings = get_settings()
    from writer_engine.rate_limit import AnthropicBudget, LLMBudget, ProviderBudget

    router = LLMRouter(
        # Anthropic gated on per-model tokens, every other provider on requests per minute (B8).
        # Both are no-ops when REDIS_URL is unset (local / tests).
        budget=LLMBudget(anthropic=AnthropicBudget(), providers=ProviderBudget()),
        max_concurrent=settings.max_concurrent_llm,
        budget_max_wait_s=settings.llm_budget_max_wait_s,
    )
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
