"""B9 — the TPM lever: which model drafts and which model fixes.

Throughput on the heavy queue is bounded by *account-wide* Anthropic output TPM, and that budget is
per model family: the Burial Mound run sat at Sonnet's ~90k output TPM (≈5 chapters/min) with
Haiku's entire budget unused beside it. `hybrid-draft-polish` moves the bulk of the output tokens —
five sub-chapters of 2-3k words — onto Haiku and keeps Sonnet for the short corrective passes.

It was in the public schema and in the inventory as the named lever, and it did nothing: the
resolver was a two-entry dict for haiku/sonnet, so every hybrid request fell through to Sonnet for
everything.
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace

from chapter_step.main import ModelPlan, _polish_model, model_plan

CHEAP = "claude-haiku-4-5-20251001"
STRONG = "claude-sonnet-4-6"


def _settings(default_strategy: str = "sonnet") -> SimpleNamespace:
    return SimpleNamespace(model_cheap=CHEAP, model_default=STRONG, chapter_llm_strategy=default_strategy)


class TestResolver:
    def test_the_hybrid_lever_actually_splits_the_pools(self) -> None:
        assert model_plan("hybrid-draft-polish", _settings()) == ModelPlan(CHEAP, STRONG)

    def test_hybrid_smart_resolves_to_the_same_split(self) -> None:
        """Equally unimplemented, and plainly meant the same thing."""
        assert model_plan("hybrid-smart", _settings()) == ModelPlan(CHEAP, STRONG)

    def test_the_explicit_strategies_are_unchanged(self) -> None:
        assert model_plan("sonnet", _settings()) == ModelPlan(STRONG, STRONG)
        assert model_plan("haiku", _settings()) == ModelPlan(CHEAP, CHEAP)

    def test_tier_default_is_sonnet_until_the_env_says_otherwise(self) -> None:
        """The baseline is what was load-tested. Turning the lever on is a deliberate act."""
        assert model_plan("tier-default", _settings()) == ModelPlan(STRONG, STRONG)
        assert model_plan("", _settings()) == ModelPlan(STRONG, STRONG)

    def test_the_lever_can_be_pulled_account_wide_without_a_deploy(self) -> None:
        plan = model_plan("tier-default", _settings("hybrid-draft-polish"))
        assert plan == ModelPlan(CHEAP, STRONG)

    def test_an_explicit_request_still_wins_over_the_account_default(self) -> None:
        assert model_plan("sonnet", _settings("hybrid-draft-polish")) == ModelPlan(STRONG, STRONG)

    def test_an_unknown_strategy_falls_back_loudly(self) -> None:
        """It used to fall back silently, which is how a cost lever gets reported as enabled while
        nothing changed."""
        assert model_plan("hybrid-nonsense", _settings()) == ModelPlan(STRONG, STRONG)

    def test_a_broken_env_default_does_not_break_a_write(self) -> None:
        assert model_plan("tier-default", _settings("nonsense")) == ModelPlan(STRONG, STRONG)
        assert model_plan("tier-default", SimpleNamespace(model_cheap=CHEAP, model_default=STRONG)) == (
            ModelPlan(STRONG, STRONG)
        )


class TestCorrectiveOps:
    def test_the_corrective_ops_take_the_polish_model(self) -> None:
        assert _polish_model({"llm_strategy": "hybrid-draft-polish"}, _settings()) == STRONG

    def test_haiku_stays_haiku_everywhere(self) -> None:
        """No behaviour change for the explicit strategies — only the hybrids gain meaning."""
        assert _polish_model({"llm_strategy": "haiku"}, _settings()) == CHEAP

    def test_a_missing_strategy_is_the_account_default(self) -> None:
        assert _polish_model({}, _settings("hybrid-draft-polish")) == STRONG


class TestTheWritePathUsesBothSlots:
    """The split only pays if the DRAFT calls take the cheap model and the corrective passes take
    the strong one. A plan resolved and then ignored is the bug this replaced."""

    @staticmethod
    def _write_source() -> str:
        from chapter_step import main as M

        src = inspect.getsource(M)
        start = src.index("plan = model_plan(req.llm_strategy, settings)")
        return src[start : src.index('result["persist"] = await _persist_chapter_if_requested', start)]

    def test_the_sub_chapter_fan_out_drafts_on_the_draft_model(self) -> None:
        src = self._write_source()
        assert "model = plan.draft" in src
        # every _write_subchapter call passes `model=model`, i.e. the draft slot
        assert "model=plan.polish" in src  # and the corrective passes do not

    def test_the_plan_and_the_drift_correction_take_the_polish_model(self) -> None:
        src = self._write_source()
        assert "_plan_subchapters(ctx, req, n_sub, plan.polish)" in src
        assert src.count("model=plan.polish") >= 2  # drift correction + craft revision

    def test_no_two_entry_strategy_dict_survives(self) -> None:
        """The original bug, pinned: six more copies of the same dict were sitting in the other ops
        and each one would have re-introduced the silent fallthrough."""
        from chapter_step import main as M

        assert '{"haiku": settings.model_cheap, "sonnet": settings.model_default}' not in inspect.getsource(M)
