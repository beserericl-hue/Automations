"""QA depth (character consistency + research gaps) + brainstorm Follett-scale completeness."""

from __future__ import annotations

from brainstorm_step.main import _build_story_system
from chapter_step.main import QA_DIMS, _build_qa_system

from writer_engine.schemas.chapter import ChapterCraftQa

_BASE = {
    "character_follows_guide": 0.9,
    "outline_follows_guide": 0.9,
    "dialogue_follows_guide": 0.9,
    "prose_transparent": 0.9,
    "story_turn_density": 0.9,
    "no_boring_paragraphs": 0.9,
    "period_language_ok": 0.9,
}


def test_qa_has_character_consistency_dimension() -> None:
    assert "character_consistency" in QA_DIMS


def test_qa_accepts_consistency_and_research_gaps() -> None:
    qa = ChapterCraftQa.model_validate(
        {**_BASE, "character_consistency": 0.7, "research_gaps": ["price of a copper pendant", "ossuary rite steps"]}
    )
    assert qa.character_consistency == 0.7
    assert qa.research_gaps == ["price of a copper pendant", "ossuary rite steps"]


def test_qa_consistency_defaults_when_omitted() -> None:
    # A model that omits the new field must NOT fail the whole QA.
    qa = ChapterCraftQa.model_validate(_BASE)
    assert qa.character_consistency == 1.0
    assert qa.research_gaps == []


def test_qa_system_checks_consistency_and_research() -> None:
    s = _build_qa_system()
    assert "character_consistency" in s
    assert "research_gaps" in s
    assert "CHARACTER ROSTER" in s


def test_brainstorm_demands_scale_and_full_cast() -> None:
    s = _build_story_system("ancient-history", "")
    assert "50-70 chapters" in s
    assert "Prologue" in s and "Epilogue" in s
    assert "EVERY main character" in s
