"""A repair that is never re-scored is a repair nobody can trust.

THE BUG, as found in the live DEV data rather than by reading code. The book run's repair pass
rewrote chapters 0, 1, 25 and 77 at 20:52 on 2026-10-19. Their Q/A reports are stamped 20:40, 20:41
and 20:44 — generated BEFORE the rewrite and never refreshed. So the Q/A panel showed findings
against prose that had been replaced twelve minutes earlier, under a "5/8 passed" badge that
described a draft the reader could no longer see. The panel was faithful; the stored report was
lying.

Two separate holes produced that, and both are closed here:

1. `_op_repair` rewrote the chapter and persisted it without re-scoring, so `metadata.qa_report`
   kept describing the previous text.
2. Nothing compared the repair against what it replaced. A repair that made the chapter WORSE was
   persisted exactly like one that improved it — and this codebase has already watched that happen:
   six whole-chapter craft revisions came back at 48-80% of the original and had to be rejected by
   hand, and one repair cut chapter 30 from 7,000 words to 2,800 to "align" it.

The fix is not "run Q/A until it passes". At this length the corrective pass is subtractive — that
is measured, not suspected — so an unbounded loop converges on a shorter chapter, not a better one.
It is: score, repair, score again, keep whichever is better, and stamp the report with the text it
actually read.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

import pytest
from chapter_step import main as M

from writer_engine.schemas.chapter import ChapterCraftQa, DriftReport, PassageEdit, PassageFix, RepairCheck

GOOD = dict(
    character_follows_guide=1.0,
    character_consistency=1.0,
    outline_follows_guide=0.92,
    period_language_ok=0.95,
    prose_transparent=0.88,
    dialogue_follows_guide=0.88,
    no_boring_paragraphs=0.85,
    story_turn_density=0.85,
)
POOR = {**GOOD, "no_boring_paragraphs": 0.52, "story_turn_density": 0.41, "prose_transparent": 0.61}


class TestTheStamp:
    """A report has to say what it read, or it cannot be told from a stale one."""

    def test_the_same_text_is_not_stale(self) -> None:
        r = M._build_qa_report(GOOD, [], None, "the prose")
        assert M.qa_report_is_stale(r, "the prose") is False

    def test_changed_text_is_stale(self) -> None:
        r = M._build_qa_report(GOOD, [], None, "the prose")
        assert M.qa_report_is_stale(r, "the prose, rewritten") is True

    def test_an_unstamped_report_reads_stale(self) -> None:
        """Every report written before this change — including the four in the live DEV data — has no
        stamp. Reporting them "current" would be the dangerous direction."""
        assert M.qa_report_is_stale({"generated_at": "2026-10-19T20:40:11Z", "checks": []}, "x") is True

    def test_the_stamp_records_length_too(self) -> None:
        r = M._build_qa_report(GOOD, [], None, "one two three")
        assert r["scored_words"] == 3

    def test_the_report_carries_the_mean_it_scored(self) -> None:
        r = M._build_qa_report(GOOD, [], None, "prose")
        assert r["craft_mean"] == pytest.approx(sum(GOOD.values()) / 8, abs=1e-3)

    def test_no_stamp_when_no_text_was_given(self) -> None:
        """Callers that genuinely have no text must not get a fingerprint of the empty string, which
        would match every other empty-string report."""
        assert "scored_sha256" not in M._build_qa_report(GOOD, [], None)


class TestCraftMean:
    def test_it_averages_the_eight_dimensions(self) -> None:
        assert M.craft_mean(GOOD) == pytest.approx(sum(GOOD.values()) / 8)

    def test_an_unassessable_dimension_is_skipped_not_counted_as_zero(self) -> None:
        """K7: three dimensions were once scored blind as 0.0 and dragged every mean down with them.
        A dimension the model could not assess must not be read as a failing grade."""
        partial = {**GOOD, "outline_follows_guide": None}
        assert M.craft_mean(partial) == pytest.approx(
            sum(v for k, v in GOOD.items() if k != "outline_follows_guide") / 7
        )

    def test_nothing_to_average_is_none_not_zero(self) -> None:
        assert M.craft_mean({}) is None
        assert M.craft_mean(None) is None

    def test_findings_do_not_leak_into_the_vector(self) -> None:
        qa = ChapterCraftQa(**GOOD, findings=[{"dimension": "x", "fix": "y"}], research_gaps=["g"])
        assert set(M._dimension_scores(qa)) == set(M.CRAFT_DIMENSIONS)


def _run_repair(
    before: dict,
    after: dict,
    *,
    corrected: bool = True,
    drift: DriftReport | None = None,
    check: RepairCheck | None | str = "clean",
    **payload: Any,
) -> dict:
    """Drive _op_repair with a scripted scorer: `before` for the original text, `after` for the
    repaired one. `drift` is what the pre-repair scan finds; `check` is the before/after judgement
    ("clean" = resolved everything, introduced nothing; None = could not be read)."""
    calls: list[str] = []

    async def fake_score(text: str, period: str, roster_text: str = "", beat: str = "") -> Any:
        calls.append(text)
        return ChapterCraftQa(**(after if text == "REPAIRED" else before))

    async def fake_correct(text: str, **kw: Any) -> tuple[str, Any, int]:
        persisted["path"] = "whole-chapter"
        return ("REPAIRED" if corrected else text, None, 1 if corrected else 0)

    edits = [{"paragraph": 1, "before": "ORIGINAL", "after": "REPAIRED", "fixes": "f"}]

    async def fake_passages(text: str, **kw: Any) -> tuple[str, Any, int, list, list]:
        persisted["path"] = "passages"
        if not corrected:
            return text, None, 0, [], []
        return "REPAIRED", None, 1, edits, ["a wrong finding: the chapter is right"]

    async def fake_ctx(pid: str, pl: dict) -> dict:
        return {"genre_slug": "g", "title": "t", "outline": {"chapters": []}, "roster": []}

    persisted: dict[str, Any] = {}

    async def fake_detect(text: str, **kw: Any) -> DriftReport | None:
        return drift

    async def fake_verify(before_t: str, after_t: str, **kw: Any) -> RepairCheck | None:
        persisted["verified"] = (before_t, after_t)
        persisted["verified_changes"] = kw.get("changes")
        if check == "clean":
            d = drift or DriftReport()
            return RepairCheck(resolved=[*d.story_drift, *d.character_drift])
        return check  # type: ignore[return-value]

    async def fake_record(pl: dict, record: dict, d: DriftReport | None) -> None:
        persisted["last_repair"] = record
        persisted["drift"] = d

    async def fake_persist_qa(pl: dict, scores: dict, findings: list, nc: Any, text: str) -> dict:
        persisted.update({"scores": scores, "text": text})
        return {"ok": True}

    async def fake_persist_chapter(pl: dict, ctx: dict, out: Any, model: str = "") -> dict:
        persisted["chapter_text"] = out.content_text
        return {"persisted": True}

    body = {
        "project_id": "11111111-2222-3333-4444-555555555555",
        "chapter_number": 3,
        "content_text": "ORIGINAL",
        "persist": True,
        **payload,
    }
    with (
        patch.object(M, "_score_chapter", fake_score),
        patch.object(M, "_drift_correct_pass", fake_correct),
        patch.object(M, "_passage_repair_pass", fake_passages),
        patch.object(M, "_load_context", fake_ctx),
        patch.object(M, "_persist_qa_artifacts", fake_persist_qa),
        patch.object(M, "_persist_chapter_if_requested", fake_persist_chapter),
        patch.object(M, "_detect_drift", fake_detect),
        patch.object(M, "_verify_repair", fake_verify),
        patch.object(M, "_record_repair", fake_record),
    ):
        out = asyncio.run(M._op_repair(body))
    out["_persisted"] = persisted
    out["_scored"] = calls
    return out


class TestTheRepairIsVerified:
    def test_an_improvement_is_kept(self) -> None:
        out = _run_repair(POOR, GOOD)
        assert out["rolled_back"] is False
        assert out["repaired"] is True
        assert out["content_text"] == "REPAIRED"
        assert out["craft_mean_after"] > out["craft_mean_before"]
        assert "kept" in out["verdict"]

    def test_a_regression_is_rolled_back_and_the_original_survives(self) -> None:
        """The measured failure: the corrective pass is subtractive at this length, so a repair can
        come back worse. Before this it was persisted anyway."""
        out = _run_repair(GOOD, POOR)
        assert out["rolled_back"] is True
        assert out["content_text"] == "ORIGINAL"
        # The stored chapter already IS the original: a rollback writes no new version of it.
        assert "chapter_text" not in out["_persisted"]
        assert "ROLLED BACK" in out["verdict"]

    def test_a_rolled_back_repair_does_not_claim_to_have_repaired(self) -> None:
        """`repaired: true` on a discarded rewrite is how a caller counts a fix that never shipped."""
        assert _run_repair(GOOD, POOR)["repaired"] is False

    def test_noise_does_not_trigger_a_rollback(self) -> None:
        """Re-scoring the same chapter moves the mean by about +/-0.09. A tolerance of zero would
        discard good repairs that happened to be scored on a bad day."""
        barely_worse = {**GOOD, "dialogue_follows_guide": GOOD["dialogue_follows_guide"] - 0.05}
        out = _run_repair(GOOD, barely_worse)
        assert out["rolled_back"] is False

    def test_a_real_drop_does_trigger_one(self) -> None:
        much_worse = {**GOOD, "no_boring_paragraphs": 0.3, "story_turn_density": 0.3}
        assert _run_repair(GOOD, much_worse)["rolled_back"] is True

    def test_the_scores_are_measured_on_both_texts(self) -> None:
        out = _run_repair(POOR, GOOD)
        assert out["_scored"] == ["ORIGINAL", "REPAIRED"]

    def test_a_pass_that_changed_nothing_is_not_scored_twice(self) -> None:
        """No rewrite, no second scoring call to pay for."""
        out = _run_repair(GOOD, GOOD, corrected=False)
        assert out["_scored"] == ["ORIGINAL"]
        assert out["rolled_back"] is False


class TestTheReportMatchesWhatIsStored:
    def test_the_persisted_report_describes_the_repaired_text(self) -> None:
        """The actual bug: chapters 0/1/25/77 kept a report describing prose that had been replaced."""
        out = _run_repair(POOR, GOOD)
        assert out["_persisted"]["text"] == "REPAIRED"
        assert out["_persisted"]["scores"]["story_turn_density"] == GOOD["story_turn_density"]

    def test_after_a_rollback_the_report_describes_the_ORIGINAL_text(self) -> None:
        """A rollback that left the repaired scores stored would be the same bug pointing the other
        way: a report describing text that was thrown away."""
        out = _run_repair(GOOD, POOR)
        assert out["_persisted"]["text"] == "ORIGINAL"
        assert out["_persisted"]["scores"]["story_turn_density"] == GOOD["story_turn_density"]

    def test_the_stored_report_is_not_stale_against_the_stored_text(self) -> None:
        out = _run_repair(POOR, GOOD)
        report = M._build_qa_report(out["_persisted"]["scores"], [], None, out["_persisted"]["text"])
        assert M.qa_report_is_stale(report, out["content_text"]) is False


# --- OSSUARY I ch80: a repair that fixed one thing and broke another was kept ---------------------

ELEANOR = "Eleanor Voss: the chapter calls her Dorothy's great-niece; the beat says niece."
TYPEWRITER = "Renata Voss: a typewriter on her desk is anachronistic for 2011."
DRIFTED = DriftReport(aligned=False, character_drift=[ELEANOR, TYPEWRITER])


class TestARepairMustNotMakeThingsWorse:
    def test_a_repair_that_introduces_a_contradiction_is_rolled_back(self) -> None:
        """The real case: the typewriter was fixed, the craft score held, and the repair also wrote
        "Renata was Dorothy's great-niece as well, one generation younger than Eleanor". Kept before."""
        check = RepairCheck(
            resolved=[TYPEWRITER],
            unresolved=[ELEANOR],
            introduced=["Calls Eleanor and Renata both great-nieces yet a generation apart."],
        )
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, check=check)
        assert out["rolled_back"] is True
        assert out["repaired"] is False
        assert out["content_text"] == "ORIGINAL"
        assert "chapter_text" not in out["_persisted"]
        assert "generation apart" in out["verdict"]

    def test_the_rollback_is_recorded_with_its_reason(self) -> None:
        check = RepairCheck(introduced=["Drops the E.M.V. initials and the donor file."])
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, check=check)
        rec = out["_persisted"]["last_repair"]
        assert rec["kept"] is False
        assert rec["introduced"] == ["Drops the E.M.V. initials and the donor file."]

    def test_after_a_rollback_the_stored_drift_describes_the_original(self) -> None:
        """Not the re-scan of the text that was thrown away."""
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, check=RepairCheck(introduced=["x"]))
        assert out["_persisted"]["drift"] == DRIFTED

    def test_a_repair_that_fixes_nothing_it_was_given_is_rolled_back(self) -> None:
        check = RepairCheck(unresolved=[ELEANOR, TYPEWRITER])
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, check=check)
        assert out["rolled_back"] is True
        assert "fixed none" in out["verdict"]

    def test_a_repair_that_cannot_be_verified_is_not_kept(self) -> None:
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, check=None)
        assert out["rolled_back"] is True
        assert "could not be verified" in out["verdict"]

    def test_a_repair_that_fixes_some_and_breaks_nothing_is_kept(self) -> None:
        check = RepairCheck(resolved=[TYPEWRITER], unresolved=[ELEANOR])
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, check=check)
        assert out["rolled_back"] is False
        assert out["content_text"] == "REPAIRED"
        assert out["_persisted"]["last_repair"]["unresolved"] == [ELEANOR]

    def test_an_author_directed_rewrite_is_kept_even_when_no_drift_moved(self) -> None:
        """Rewrite-with-research uses the same op; the author asked for the research, not a drift fix."""
        check = RepairCheck(unresolved=[ELEANOR, TYPEWRITER])
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, check=check, research_focus="1952 Smithsonian loans")
        assert out["rolled_back"] is False

    def test_the_check_reads_both_texts(self) -> None:
        out = _run_repair(GOOD, GOOD, drift=DRIFTED)
        assert out["_persisted"]["verified"] == ("ORIGINAL", "REPAIRED")

    def test_a_rejected_repair_is_not_paid_for_with_a_second_score(self) -> None:
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, check=RepairCheck(introduced=["x"]))
        assert out["_scored"] == ["ORIGINAL"]


class TestTheRule:
    def test_introduced_beats_resolved(self) -> None:
        keep, why = M.judge_repair(
            RepairCheck(resolved=["a"], introduced=["b"]), drift=DRIFTED, author_directed=False
        )
        assert keep is False and "b" in why

    def test_a_line_edit_with_no_drift_is_kept(self) -> None:
        keep, _ = M.judge_repair(RepairCheck(), drift=DriftReport(), author_directed=False)
        assert keep is True


class TestTheCorrectionPromptGuardsFacts:
    def test_it_forbids_reconciling_genealogy(self) -> None:
        system = M._build_correct_system("ancient-history")
        assert "Never add a sentence of genealogy" in system
        assert "ONE way everywhere" in system


# --- Fix drift edits passages, it does not rewrite the chapter ------------------------------------
#
# The two real ch80 runs that were rolled back (2026-10-29) were whole-chapter rewrites: asked about
# one relationship, they also dropped "Stratum XIII, ca. 750 BCE", Priya's name and "two thousand
# years". A paragraph no edit names cannot lose anything, because it is never handed back to a model.

CH80 = (
    "Stratum XIII, ca. 750 BCE. The tag was in Dorothy's hand.\n\n"
    "Eleanor was the niece of Renata's great aunt Dorothy. Renata was the next generation over.\n\n"
    "---\n\n"
    "Priya set the box down. Two thousand years, she said.\n\n"
    "Renata typed the letter on *the old Remington*."
)


def _edit(n: int, text: str, insert: bool = False) -> PassageEdit:
    return PassageEdit(paragraph=n, text=text, insert_after=insert, fixes="f")


class TestApplyPassageEdits:
    def test_paragraphs_no_edit_names_are_kept_byte_for_byte(self) -> None:
        out, changes = M.apply_passage_edits(
            CH80, [_edit(2, "Eleanor was Dorothy's great-niece, as Renata was.")]
        )
        assert out == CH80.replace(
            "Eleanor was the niece of Renata's great aunt Dorothy. Renata was the next generation over.",
            "Eleanor was Dorothy's great-niece, as Renata was.",
        )
        for kept in (
            "Stratum XIII, ca. 750 BCE",
            "Priya",
            "Two thousand years",
            "*the old Remington*",
            "\n\n---\n\n",
        ):
            assert kept in out
        assert changes == [
            {
                "paragraph": 2,
                "before": "Eleanor was the niece of Renata's great aunt Dorothy. Renata was the next generation over.",
                "after": "Eleanor was Dorothy's great-niece, as Renata was.",
                "fixes": "f",
            }
        ]

    def test_no_edits_is_the_same_text(self) -> None:
        assert M.apply_passage_edits(CH80, []) == (CH80, [])

    def test_scene_breaks_are_not_numbered(self) -> None:
        """Paragraph 3 is Priya's, not the `---` separator, so a fix can never edit a scene break."""
        out, _ = M.apply_passage_edits(
            CH80, [_edit(3, "Priya set the crate down. Two thousand years, she said.")]
        )
        assert "crate" in out and "\n\n---\n\n" in out

    def test_an_edit_to_a_paragraph_that_does_not_exist_is_dropped(self) -> None:
        assert M.apply_passage_edits(CH80, [_edit(0, "x"), _edit(99, "x")]) == (CH80, [])

    def test_an_empty_or_unchanged_edit_is_dropped(self) -> None:
        same = "Stratum XIII, ca. 750 BCE. The tag was in Dorothy's hand."
        assert M.apply_passage_edits(CH80, [_edit(1, "   "), _edit(1, same)]) == (CH80, [])

    def test_a_paragraph_is_replaced_once(self) -> None:
        out, changes = M.apply_passage_edits(CH80, [_edit(1, "first"), _edit(1, "second")])
        assert out.startswith("first\n\n") and "second" not in out
        assert len(changes) == 1

    def test_insert_after_adds_a_paragraph_and_keeps_the_one_before(self) -> None:
        out, changes = M.apply_passage_edits(CH80, [_edit(1, "A restored beat.", insert=True)])
        assert out.startswith(
            "Stratum XIII, ca. 750 BCE. The tag was in Dorothy's hand.\n\nA restored beat.\n\nEleanor"
        )
        assert changes[0]["before"] == ""

    def test_dashes_are_cleaned_in_the_edit_only(self) -> None:
        text = "Keep this — as the author wrote it.\n\nFix this."
        out, _ = M.apply_passage_edits(text, [_edit(2, "Fixed — now.")])
        assert out == "Keep this — as the author wrote it.\n\nFixed, now."


class TestFixDriftUsesPassages:
    def test_fix_drift_edits_passages(self) -> None:
        out = _run_repair(GOOD, GOOD, drift=DRIFTED)
        assert out["_persisted"]["path"] == "passages"
        assert out["content_text"] == "REPAIRED"

    def test_an_author_directed_rewrite_still_revises_the_whole_chapter(self) -> None:
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, style_directives="Fix these Q/A findings")
        assert out["_persisted"]["path"] == "whole-chapter"

    def test_the_check_reads_the_edited_paragraphs(self) -> None:
        out = _run_repair(GOOD, GOOD, drift=DRIFTED)
        assert out["_persisted"]["verified_changes"] == [
            {"paragraph": 1, "before": "ORIGINAL", "after": "REPAIRED", "fixes": "f"}
        ]

    def test_the_record_shows_what_changed_and_what_was_skipped(self) -> None:
        out = _run_repair(GOOD, GOOD, drift=DRIFTED)
        rec = out["_persisted"]["last_repair"]
        assert rec["changes"][0]["after"] == "REPAIRED"
        assert rec["skipped"] == ["a wrong finding: the chapter is right"]

    def test_a_rolled_back_fix_still_shows_what_it_would_have_changed(self) -> None:
        out = _run_repair(GOOD, GOOD, drift=DRIFTED, check=RepairCheck(introduced=["x"]))
        assert out["_persisted"]["last_repair"]["changes"]
        assert out["content_text"] == "ORIGINAL"


def _passage_pass(drift: DriftReport | None, fix: PassageFix | None) -> tuple:
    calls: dict[str, int] = {"fix": 0, "research": 0}

    async def fake_fix(text: str, **kw: Any) -> PassageFix | None:
        calls["fix"] += 1
        return fix

    async def fake_research(beat: str, **kw: Any) -> tuple[str, list]:
        calls["research"] += 1
        return "facts", []

    async def fake_detect(text: str, **kw: Any) -> DriftReport:
        return DriftReport(aligned=True)

    req = M.WriteChapterRequest.model_validate(
        {
            "project_id": "11111111-2222-3333-4444-555555555555",
            "chapter_number": 80,
            "chapter_run_id": "99999999-2222-3333-4444-555555555555",
        }
    )
    ctx = {"genre_slug": "g", "title": "t", "outline": {}, "roster": []}
    with (
        patch.object(M, "_fix_passages", fake_fix),
        patch.object(M, "_chapter_research", fake_research),
        patch.object(M, "_detect_drift", fake_detect),
    ):
        out = asyncio.run(
            M._passage_repair_pass(
                CH80, ctx=ctx, req=req, roster_text="", period="", model="m", drift=drift, beat="b"
            )
        )
    return out, calls


class TestThePassagePass:
    def test_no_drift_means_no_model_call_and_no_change(self) -> None:
        (text, _d, passes, changes, _s), calls = _passage_pass(DriftReport(aligned=True), PassageFix())
        assert (text, passes, changes) == (CH80, 0, [])
        assert calls == {"fix": 0, "research": 0}

    def test_an_unread_scan_changes_nothing(self) -> None:
        (text, _d, passes, _c, _s), calls = _passage_pass(None, PassageFix())
        assert text == CH80 and passes == 0 and calls["fix"] == 0

    def test_an_unusable_answer_changes_nothing(self) -> None:
        (text, _d, passes, _c, _s), _ = _passage_pass(DRIFTED, None)
        assert text == CH80 and passes == 0

    def test_a_fix_that_skips_every_finding_changes_nothing(self) -> None:
        fix = PassageFix(skipped=[f"{ELEANOR} The chapter is right."])
        (text, _d, passes, _c, skipped), _ = _passage_pass(DRIFTED, fix)
        assert text == CH80 and passes == 0 and skipped == fix.skipped

    def test_edits_are_applied_and_the_result_is_rescanned(self) -> None:
        fix = PassageFix(edits=[_edit(4, "Renata wrote the letter by hand.")])
        (text, drift, passes, changes, _s), _ = _passage_pass(DRIFTED, fix)
        assert passes == 1 and "by hand" in text and "Stratum XIII" in text
        assert drift is not None and drift.aligned is True
        assert len(changes) == 1

    def test_research_is_fetched_only_for_research_gaps(self) -> None:
        _, calls = _passage_pass(DRIFTED, PassageFix())
        assert calls["research"] == 0
        _, calls = _passage_pass(DriftReport(aligned=False, research_gaps=["1952 loan forms"]), PassageFix())
        assert calls["research"] == 1


class TestThePassagePromptIsScoped:
    def test_it_forbids_touching_other_paragraphs(self) -> None:
        system = M._build_passage_fix_system("ancient-history")
        assert "No line editing" in system
        assert "copy every other sentence of that" in system

    def test_a_wrong_finding_is_skipped_not_obeyed(self) -> None:
        assert "SKIP it" in M._build_passage_fix_system("ancient-history")
