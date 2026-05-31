"""AnthropicBudget sliding-window gatekeeper — Tier-4 defaults + exhaustion + no-op fallback."""

from __future__ import annotations

import time

import pytest

from writer_engine.rate_limit import (
    DEFAULT_LIMITS,
    AnthropicBudget,
    BudgetExhausted,
    ModelLimits,
)


@pytest.mark.asyncio
async def test_tier4_defaults_match_probe() -> None:
    """Defaults match the 2026-05-31 anthropic-ratelimit-* header probe (see module docstring)."""
    sonnet = DEFAULT_LIMITS["claude-sonnet-4-6"]
    haiku = DEFAULT_LIMITS["claude-haiku-4-5-20251001"]
    opus = DEFAULT_LIMITS["claude-opus-4-8"]
    assert (sonnet.input_tpm, sonnet.output_tpm, sonnet.rpm) == (450_000, 90_000, 1_000)
    assert (haiku.input_tpm, haiku.output_tpm, haiku.rpm) == (450_000, 90_000, 1_000)
    assert (opus.input_tpm, opus.output_tpm, opus.rpm) == (2_000_000, 200_000, 1_000)


@pytest.mark.asyncio
async def test_unknown_model_uses_conservative_fallback() -> None:
    budget = AnthropicBudget()
    limits = budget.limits_for("some-unknown-model")
    # Half of the smallest Tier-4 model — sized to fail closed.
    assert limits.input_tpm == 225_000
    assert limits.output_tpm == 45_000
    assert limits.rpm == 500


@pytest.mark.asyncio
async def test_noop_when_redis_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """No Redis = no enforcement. Local dev shouldn't be blocked by a missing infra dep."""
    import writer_engine.redis_client.client as rc

    async def _broken() -> object:
        raise RuntimeError("no redis configured in tests")

    monkeypatch.setattr(rc, "get_redis", _broken)
    budget = AnthropicBudget()
    # Should not raise — wait_for_capacity returns immediately, record_usage swallows.
    await budget.wait_for_capacity(
        model="claude-sonnet-4-6", input_tokens=10_000, output_tokens=3_000
    )
    await budget.record_usage(model="claude-sonnet-4-6", input_tokens=10_000, output_tokens=3_000)
    snap = await budget.snapshot("claude-sonnet-4-6")
    assert snap == {"input_tokens": 0, "output_tokens": 0, "requests": 0}


@pytest.mark.asyncio
async def test_records_and_reads_back_within_window(fake_redis) -> None:  # type: ignore[no-untyped-def]
    budget = AnthropicBudget(redis_client=fake_redis)
    await budget.record_usage(
        model="claude-sonnet-4-6", input_tokens=10_000, output_tokens=2_500
    )
    await budget.record_usage(
        model="claude-sonnet-4-6", input_tokens=8_000, output_tokens=2_000
    )
    snap = await budget.snapshot("claude-sonnet-4-6")
    assert snap == {"input_tokens": 18_000, "output_tokens": 4_500, "requests": 2}


@pytest.mark.asyncio
async def test_wait_blocks_when_budget_exhausted(fake_redis) -> None:  # type: ignore[no-untyped-def]
    """Tiny budget → reservation triggers BudgetExhausted instead of HTTP 429."""
    tiny = {
        "claude-sonnet-4-6": ModelLimits(input_tpm=5_000, output_tpm=1_000, rpm=10),
    }
    budget = AnthropicBudget(redis_client=fake_redis, limits=tiny)
    # Burn the input budget exactly.
    await budget.record_usage(
        model="claude-sonnet-4-6", input_tokens=5_000, output_tokens=900
    )
    # Next call would push input over → exhausted within 1s of waiting.
    started = time.time()
    with pytest.raises(BudgetExhausted, match="claude-sonnet-4-6"):
        await budget.wait_for_capacity(
            model="claude-sonnet-4-6",
            input_tokens=1_000,
            output_tokens=100,
            max_wait_s=1.0,
        )
    assert time.time() - started >= 1.0


@pytest.mark.asyncio
async def test_wait_passes_when_under_budget(fake_redis) -> None:  # type: ignore[no-untyped-def]
    budget = AnthropicBudget(redis_client=fake_redis)
    # 100k input is well under Sonnet's 450k TPM ceiling.
    await budget.record_usage(
        model="claude-sonnet-4-6", input_tokens=100_000, output_tokens=10_000
    )
    # Capacity check passes immediately, no exception.
    await budget.wait_for_capacity(
        model="claude-sonnet-4-6",
        input_tokens=8_000,
        output_tokens=3_000,
        max_wait_s=0.1,
    )


@pytest.mark.asyncio
async def test_separate_models_have_separate_budgets(fake_redis) -> None:  # type: ignore[no-untyped-def]
    """Burning Sonnet doesn't affect Haiku — independent keys per model."""
    budget = AnthropicBudget(redis_client=fake_redis)
    await budget.record_usage(
        model="claude-sonnet-4-6", input_tokens=400_000, output_tokens=80_000
    )
    snap_haiku = await budget.snapshot("claude-haiku-4-5-20251001")
    assert snap_haiku["input_tokens"] == 0
    assert snap_haiku["output_tokens"] == 0
