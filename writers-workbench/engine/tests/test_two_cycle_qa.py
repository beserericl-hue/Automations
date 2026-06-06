"""Two-cycle QA: drift detection (cycle 1) + drift correction/research-fill (cycle 2)."""

from __future__ import annotations

from chapter_step.main import (
    _arc_summary,
    _build_correct_system,
    _build_drift_system,
    _chapter_outline_beat,
    _facts_topics,
    _strip_scaffolding,
)

from writer_engine.schemas.chapter import DriftReport, WriteChapterResponse


def test_drift_report_defaults_aligned_when_no_drift() -> None:
    d = DriftReport.model_validate({"research_gaps": ["price of a copper pendant"]})
    assert d.aligned is True
    assert d.story_drift == [] and d.character_drift == []
    assert d.research_gaps == ["price of a copper pendant"]


def test_drift_report_not_aligned_with_drift() -> None:
    d = DriftReport.model_validate(
        {"story_drift": ["chapter skips the hearing beat"], "character_drift": ["Tayak renamed 'Tara'"]}
    )
    assert d.aligned is False
    assert d.story_drift and d.character_drift


def test_drift_report_tolerates_wrapper_and_dict_entries() -> None:
    d = DriftReport.model_validate(
        {"drift_report": {"story_drift": [{"issue": "missing midpoint reversal"}],
                          "character_drift": "Nora's age changed"}}
    )
    assert d.story_drift == ["missing midpoint reversal"]
    assert d.character_drift == ["Nora's age changed"]
    assert d.aligned is False


def test_drift_report_flattens_item_dicts() -> None:
    # the exact shape the live detector returned: [{"item": "..."}]
    d = DriftReport.model_validate(
        {"character_drift": [{"item": "Okafor is named chair, then Delgado is chair, then Okafor returns as a delegate"}]}
    )
    assert d.character_drift == ["Okafor is named chair, then Delgado is chair, then Okafor returns as a delegate"]
    assert d.aligned is False


def test_drift_system_checks_all_three_axes() -> None:
    s = _build_drift_system()
    assert "story_drift" in s and "character_drift" in s and "research_gaps" in s
    assert "QA cycle 1" in s
    assert "DETECT" in s  # cycle 1 detects, does not rewrite


def test_correct_system_is_drift_only_and_no_shrink() -> None:
    s = _build_correct_system("ancient-history")
    assert "QA cycle 2" in s
    assert "STORY DRIFT" in s and "CHARACTER DRIFT" in s
    assert "AT LEAST as long" in s  # must not condense
    assert "Confirmed cast" in s and "Validation" in s  # forbids printing scaffolding


def test_facts_topics_extracts_labels() -> None:
    facts = (
        "- **Cord-marked pottery**: diagnostic of Moyaone-phase assemblages in the tidewater.\n"
        "- **Lake Superior copper**: traded south along the river paths; isotopically distinct.\n"
        "**Chenopodium**: a cultivated starchy seed in the Eastern Agricultural Complex.\n"
        "Some trailing prose with no bullet."
    )
    topics = _facts_topics(facts)
    assert "Cord-marked pottery" in topics
    assert "Lake Superior copper" in topics
    assert "Chenopodium" in topics


def test_strip_scaffolding_removes_confirmed_cast_and_headings() -> None:
    # the exact leak observed in run 3's chapter 0 correction output
    leaked = (
        "**Confirmed cast:**\n\n"
        "*(No locked characters established yet — this is the opening chapter. All characters "
        "introduced here become the founding roster.)*\n\n"
        "---\n\n"
        "## Chapter 0 — Full Revised Draft\n\n"
        "### Sub-chapter 1\n\n"
        "The folding chair had a loose leg, and every time the man shifted his weight the row trembled."
    )
    out = _strip_scaffolding(leaked)
    assert out.startswith("The folding chair")
    assert "Confirmed cast" not in out and "Full Revised Draft" not in out


def test_strip_scaffolding_removes_pov_preamble() -> None:
    leaked = (
        "**POV CHARACTER:** Dr. Tayak Moyaone. Her emotional stake is highest because the hearing "
        "decides whether her community gains legal existence.\n\n"
        "The committee room smelled of burnt coffee and floor polish."
    )
    out = _strip_scaffolding(leaked)
    assert out.startswith("The committee room")


def test_strip_scaffolding_keeps_clean_prose() -> None:
    clean = "She knelt at the edge of the trench.\n\nThe copper caught the light."
    assert _strip_scaffolding(clean) == clean


def test_chapter_outline_beat_matches_by_number() -> None:
    outline = {"chapters": [
        {"chapter_number": 0, "title": "Prologue", "beat": "the mound is consecrated"},
        {"chapter_number": 1, "title": "The Notice", "act": "Act I", "beat": "Tayak gets the condemnation notice"},
    ]}
    beat = _chapter_outline_beat(outline, 1)
    assert "The Notice" in beat and "Act I" in beat and "condemnation" in beat


def test_arc_summary_uses_arc_and_premise() -> None:
    outline = {"story_arc_name": "The Mound", "premise": "a layered excavation"}
    s = _arc_summary(outline)
    assert "The Mound" in s and "layered excavation" in s


def test_response_carries_two_cycle_telemetry() -> None:
    from uuid import uuid4

    r = WriteChapterResponse(
        chapter_id=uuid4(), chapter_run_id=uuid4(), content_text="x", word_count=1,
        sub_chapter_count=5, craft_passes=1,
        drift_report={"aligned": False, "story_drift": ["s"], "character_drift": [], "research_gaps": ["g"]},
        research_gaps_filled=["g"],
        sub_chapter_briefs=[{"title": "t", "beat": "b", "pov_character": "Tayak"}],
    )
    dumped = r.model_dump(mode="json")
    assert dumped["drift_report"]["story_drift"] == ["s"]
    assert dumped["research_gaps_filled"] == ["g"]
    assert dumped["sub_chapter_briefs"][0]["pov_character"] == "Tayak"


def test_drift_system_allows_minor_scene_characters() -> None:
    s = _build_drift_system()
    # the tuning: new minor / walk-on characters are NOT drift
    assert "minor / walk-on" in s or "walk-on" in s
    assert "council members at a council meeting" in s
    assert "NOT drift" in s
