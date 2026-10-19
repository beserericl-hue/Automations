"""C4 — failures that produced a plausible-looking result and said nothing.

The two that mattered, both found by walking every `except Exception` block and asking what the
caller then believes:

1. **Rate limiting silently switched itself off.** Both budgets' `_client()` swallowed any Redis
   failure and returned None; `acquire()` reads None as "no budget to check" and returns True. So a
   Redis blip removed EVERY provider limit — the engine would hammer providers into 429s, or spend
   without a cap — and nothing in the logs said the guard had gone. Redis died unnoticed for nine
   days in May; this is the same shape one layer down.

2. **A failed scrape produced a thin newsletter.** `except Exception: scraped = []` made a crashing
   scrape step indistinguishable from a story that had no external links, so an edition built from
   headlines alone went out looking normal.

Neither fix changes control flow: a provider call must not fail because Redis is down, and one
story's sources are not worth failing an edition over. They just stop being quiet.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

import pytest

from writer_engine.rate_limit import anthropic_budget, provider_budget


class _Recorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))

    def names(self) -> list[str]:
        return [e for e, _ in self.events]


class TestRateLimitBypassIsAudible:
    @pytest.mark.parametrize("module", [provider_budget, anthropic_budget])
    def test_an_unreachable_redis_is_reported(self, module: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        rec = _Recorder()
        monkeypatch.setattr(module.logger, "warning", rec)
        monkeypatch.setattr(module, "_last_ungated_warning", 0.0)

        async def _boom() -> Any:
            raise ConnectionError("redis down")

        monkeypatch.setattr(module._redis_module, "get_redis", _boom)

        budget = module.ProviderBudget() if module is provider_budget else module.AnthropicBudget()
        assert asyncio.run(budget._client()) is None
        assert "rate_limit.unenforced" in rec.names()
        kw = dict(rec.events[0][1])
        # The log has to say what it MEANS, not just that something failed.
        assert "NOT being applied" in kw["consequence"]
        assert "ConnectionError" in kw["error"]

    def test_the_warning_is_throttled_rather_than_per_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Once per call would be thousands of identical lines a minute, which is its own silence."""
        rec = _Recorder()
        monkeypatch.setattr(provider_budget.logger, "warning", rec)
        monkeypatch.setattr(provider_budget, "_last_ungated_warning", 0.0)

        async def _boom() -> Any:
            raise ConnectionError("redis down")

        monkeypatch.setattr(provider_budget._redis_module, "get_redis", _boom)
        budget = provider_budget.ProviderBudget()

        async def _many() -> None:
            for _ in range(50):
                await budget._client()

        asyncio.run(_many())
        assert rec.names().count("rate_limit.unenforced") == 1

    def test_the_call_still_proceeds_when_redis_is_down(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Deliberate: a provider call must not fail because the limiter cannot be consulted."""
        monkeypatch.setattr(provider_budget.logger, "warning", _Recorder())
        monkeypatch.setattr(provider_budget, "_last_ungated_warning", 0.0)

        async def _boom() -> Any:
            raise ConnectionError("redis down")

        monkeypatch.setattr(provider_budget._redis_module, "get_redis", _boom)
        budget = provider_budget.ProviderBudget()
        ok = asyncio.run(
            budget.wait_for_capacity(provider="anthropic", model="x", input_tokens=10, output_tokens=10)
        )
        assert ok is True


class TestTheSagaReportsADroppedScrape:
    def test_the_handler_logs_before_falling_back_to_no_sources(self) -> None:
        from orchestrator import newsletter_saga

        src = inspect.getsource(newsletter_saga)
        i = src.index("saga.scrape_failed")
        # The log must precede the fallback assignment inside the same block.
        after = src[i : i + 400]
        assert "scraped = []" in after
        assert "urls=len(story.external_source_links" in src
