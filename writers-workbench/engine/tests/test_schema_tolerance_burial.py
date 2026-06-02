"""Schema tolerances found on the live Burial Mound engine run.

The research derive LLM returns category in arbitrary casing ("PROFESSION / ROLE"); the chapter QA
LLM sometimes double-wraps the object ({"chapter_craft_qa": {"scores": {...}}}). Both must coerce.
"""

from __future__ import annotations

from writer_engine.schemas.chapter import ChapterCraftQa, ResearchPlan

_DIMS = {
    "character_follows_guide": 0.9,
    "outline_follows_guide": 0.8,
    "dialogue_follows_guide": 0.8,
    "prose_transparent": 0.9,
    "story_turn_density": 0.8,
    "no_boring_paragraphs": 0.8,
    "period_language_ok": 0.9,
}


def test_research_category_casing_normalised() -> None:
    p = ResearchPlan.model_validate(
        {"questions": [
            {"question": "Q1", "category": "PROFESSION / ROLE"},
            {"question": "Q2", "category": "Daily Life"},
            {"question": "Q3", "category": "FRAMEWORK"},
        ]}
    )
    assert [q.category for q in p.questions] == ["profession_role", "daily_life", "framework"]


def test_qa_double_envelope_unwrapped() -> None:
    qa = ChapterCraftQa.model_validate({"chapter_craft_qa": {"scores": _DIMS}})
    assert qa.character_follows_guide == 0.9
    assert qa.period_language_ok == 0.9


def test_qa_single_wrapper_key_unwrapped() -> None:
    qa = ChapterCraftQa.model_validate({"qa": _DIMS})
    assert qa.no_boring_paragraphs == 0.8
