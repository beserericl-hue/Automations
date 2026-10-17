"""E7 — running the lenses and shaping the findings.

What matters here is not the critique (that is the model's job) but that the report is honest: a
lens that found nothing says so, a lens that broke says so, and none of it leaks into the rubric
that gates ``chapter.repair``.
"""

from __future__ import annotations

from typing import Any

import pytest

from writer_engine.review import runner


class TestFindingCoercion:
    def test_the_documented_shape(self) -> None:
        f = runner.Finding.model_validate(
            {
                "severity": "high",
                "title": "Adverb pile-up",
                "detail": "Cut them.",
                "quote": "she said quietly",
            }
        )
        assert (f.severity, f.title, f.quote) == ("high", "Adverb pile-up", "she said quietly")

    def test_a_bare_string(self) -> None:
        """Models return a plain list of strings often enough to handle it."""
        f = runner.Finding.model_validate("Too many adverbs in paragraph two")
        assert f.title == "Too many adverbs in paragraph two"
        assert f.detail == "Too many adverbs in paragraph two"

    def test_the_problem_fix_pair(self) -> None:
        """Same shape ``DriftReport`` had to absorb (A7)."""
        f = runner.Finding.model_validate({"problem": "Scene stalls", "fix": "Cut the exposition."})
        assert f.title == "Scene stalls"
        assert f.detail == "Cut the exposition."

    def test_an_unknown_severity_becomes_medium(self) -> None:
        assert runner.Finding.model_validate({"severity": "CRITICAL", "title": "x"}).severity == "medium"
        assert runner.Finding.model_validate({"title": "x"}).severity == "medium"

    def test_an_empty_finding_is_not_usable(self) -> None:
        """A model padding the array with ``{}`` must not produce a blank panel row."""
        assert not runner.Finding.model_validate({}).usable
        assert runner.Finding.model_validate({"title": "x"}).usable


class TestLensReportCoercion:
    def test_a_bare_list_is_the_findings(self) -> None:
        report = runner.LensReport.model_validate([{"title": "a"}, {"title": "b"}])
        assert len(report.findings) == 2

    @pytest.mark.parametrize("alias", ["issues", "problems", "results"])
    def test_findings_aliases(self, alias: str) -> None:
        report = runner.LensReport.model_validate({alias: [{"title": "a"}]})
        assert len(report.findings) == 1


class TestCheckRows:
    def test_findings_become_needs_review_rows(self) -> None:
        report = runner.LensReport.model_validate(
            {
                "findings": [
                    {"severity": "high", "title": "Adverbs", "detail": "Cut them.", "quote": "quietly"},
                    {"severity": "low", "title": "Qualifier", "detail": "Drop 'very'."},
                ]
            }
        )
        rows = runner.check_rows("hemingway", report)
        assert [r["status"] for r in rows] == [runner.STATUS_REVIEW] * 2
        assert rows[0]["name"] == "Hemingway (cut): Adverbs"
        assert rows[0]["details"].startswith("[high] Cut them.")
        assert "> quietly" in rows[0]["details"]

    def test_no_findings_is_one_pass_row(self) -> None:
        """Silence and absence have to look different — otherwise the user cannot tell a clean
        chapter from a lens that never ran."""
        report = runner.LensReport.model_validate({"findings": [], "summary": "Tight throughout."})
        rows = runner.check_rows("hemingway", report)
        assert rows == [
            {"name": "Hemingway (cut)", "status": runner.STATUS_PASS, "details": "Tight throughout."}
        ]

    def test_a_failed_lens_is_an_error_row(self) -> None:
        rows = runner.check_rows("hemingway", None, error="ReadTimeout: anthropic")
        assert rows[0]["status"] == runner.STATUS_ERROR
        assert "did not run" in rows[0]["details"]

    def test_padding_findings_are_dropped(self) -> None:
        report = runner.LensReport.model_validate({"findings": [{}, {}]})
        rows = runner.check_rows("mom", report)
        assert [r["status"] for r in rows] == [runner.STATUS_PASS]


def _stub_lenses(monkeypatch: pytest.MonkeyPatch, behaviour: dict[str, Any]) -> list[str]:
    """Replace ``run_lens`` with a per-lens scripted result. Returns the call order."""
    seen: list[str] = []

    async def fake_run_lens(lens: str, draft: str, **_kw: Any) -> tuple[runner.LensReport | None, str]:
        seen.append(lens)
        outcome = behaviour.get(lens, {"findings": []})
        if isinstance(outcome, str):
            return None, outcome
        return runner.LensReport.model_validate(outcome), ""

    monkeypatch.setattr(runner, "run_lens", fake_run_lens)
    return seen


class TestReviewDraft:
    @pytest.mark.asyncio
    async def test_the_default_lens_runs(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = _stub_lenses(monkeypatch, {})
        report = await runner.review_draft("Some prose.")
        assert seen == ["guardrails"]
        assert report["lenses"] == ["guardrails"]
        assert report["finding_count"] == 0

    @pytest.mark.asyncio
    async def test_findings_are_counted_and_shaped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _stub_lenses(
            monkeypatch,
            {
                "hemingway": {"findings": [{"title": "Adverbs", "detail": "Cut."}], "summary": "Bloated."},
                "mom": {"findings": [], "summary": "Followed it fine."},
            },
        )
        report = await runner.review_draft("Some prose.", requested=["hemingway", "mom"])
        assert report["finding_count"] == 1
        assert report["summaries"] == {"hemingway": "Bloated.", "mom": "Followed it fine."}
        assert {c["status"] for c in report["checks"]} == {runner.STATUS_REVIEW, runner.STATUS_PASS}
        assert report["errors"] == {}

    @pytest.mark.asyncio
    async def test_one_broken_lens_does_not_lose_the_others(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _stub_lenses(
            monkeypatch,
            {
                "hemingway": "RateLimitError: 429",
                "mom": {"findings": [{"title": "Lost me", "detail": "Who is Mara?"}]},
            },
        )
        report = await runner.review_draft("Some prose.", requested=["hemingway", "mom"])
        assert report["errors"] == {"hemingway": "RateLimitError: 429"}
        assert report["finding_count"] == 1
        # The failure is visible as a row, not inferred from a missing one.
        assert any(c["status"] == runner.STATUS_ERROR for c in report["checks"])

    @pytest.mark.asyncio
    async def test_an_empty_draft_errors_without_calling_a_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen = _stub_lenses(monkeypatch, {})
        report = await runner.review_draft("   ")
        assert seen == []
        assert report["checks"][0]["status"] == runner.STATUS_ERROR
        assert report["errors"] == {"_draft": "empty"}

    @pytest.mark.asyncio
    async def test_a_panel_runs_members_then_synthesizes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = _stub_lenses(monkeypatch, {"hemingway": {"findings": [{"title": "Adverbs"}]}})
        synth_called: list[str] = []

        async def fake_synthesize(
            orchestrator: str, reports: dict[str, runner.LensReport], **_kw: Any
        ) -> tuple[runner.LensReport | None, str]:
            synth_called.append(orchestrator)
            # The synthesis must see the member reports, not the draft.
            assert "hemingway" in reports
            return runner.LensReport.model_validate(
                {"findings": [{"title": "Fix structure first", "detail": "Then cut."}], "summary": "Agreed."}
            ), ""

        monkeypatch.setattr(runner, "synthesize", fake_synthesize)
        report = await runner.review_draft("Some prose.", requested=["panel"])
        assert seen == list(runner.lens_mod.MULTI_LENS_MEMBERS["panel"])
        assert synth_called == ["panel"]
        assert any(c["name"].startswith("Review panel") for c in report["checks"])

    @pytest.mark.asyncio
    async def test_a_failed_synthesis_keeps_the_member_findings(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub_lenses(monkeypatch, {"hemingway": {"findings": [{"title": "Adverbs"}]}})

        async def failing_synthesize(*_a: Any, **_k: Any) -> tuple[runner.LensReport | None, str]:
            return None, "ReadTimeout"

        monkeypatch.setattr(runner, "synthesize", failing_synthesize)
        report = await runner.review_draft("Some prose.", requested=["panel"])
        assert report["errors"] == {"panel": "ReadTimeout"}
        assert report["finding_count"] >= 1

    @pytest.mark.asyncio
    async def test_the_draft_is_truncated_not_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, int] = {}

        async def fake_run_lens(lens: str, draft: str, **_kw: Any) -> tuple[runner.LensReport | None, str]:
            captured["len"] = len(draft)
            return runner.LensReport(), ""

        monkeypatch.setattr(runner, "run_lens", fake_run_lens)
        await runner.review_draft("x" * (runner.MAX_DRAFT_CHARS * 2))
        # review_draft hands the whole draft to run_lens; the cap is applied when building the prompt.
        assert captured["len"] == runner.MAX_DRAFT_CHARS * 2
        block = runner._draft_block("x" * (runner.MAX_DRAFT_CHARS * 2))
        assert block.count("x") == runner.MAX_DRAFT_CHARS


class TestSynthesisGuard:
    @pytest.mark.asyncio
    async def test_a_non_orchestrator_is_refused(self) -> None:
        report, error = await runner.synthesize("hemingway", {})
        assert report is None and "not an orchestrator" in error

    @pytest.mark.asyncio
    async def test_nothing_to_synthesize_is_reported(self) -> None:
        report, error = await runner.synthesize("panel", {})
        assert report is None and "no member lens" in error


class TestTruncationGuards:
    """The `guardrails` lens failed on a real chapter with a JSON truncation at 4,096 output tokens.

    Its prompt is 19,347 characters — five times the next largest lens — and it asks for findings
    across three severity tiers plus watch-items plus a summary. So the default lens, the one that
    gates publication, could not run on the drafts it most needs to. Third truncation-class failure
    of the same day (the story outline at 32,768, the ingestion relevance verdict at 1,024), so the
    remedy is the same: more room AND a bound on the thing that grows.
    """

    def test_the_contract_caps_the_findings(self) -> None:
        assert f"at most {runner.MAX_FINDINGS} findings" in runner._OUTPUT_CONTRACT
        assert runner.MAX_FINDINGS <= 20  # more than an author acts on in one pass

    def test_the_contract_explains_why_brevity_matters(self) -> None:
        """A bare "be brief" is ignored; naming the consequence is not."""
        assert "truncated" in runner._OUTPUT_CONTRACT

    def test_the_ceiling_is_above_what_truncated(self) -> None:
        assert runner.LENS_MAX_TOKENS > 4096

    def test_the_largest_lens_prompt_fits_well_inside_the_input_budget(self) -> None:
        """The guardrails prompt plus a full-length draft must still be a sane request."""
        from writer_engine.review import lenses

        largest = max(len(lenses.lens_prompt(n)) for n in lenses.SINGLE_LENSES)
        assert largest > 15_000, "guardrails is expected to be the big one"
        # prompt + draft cap, in characters, well under a 200k-token context
        assert (largest + runner.MAX_DRAFT_CHARS) < 200_000
