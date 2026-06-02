"""research_step composes the Follett research craft layer + tolerant ResearchPlan parsing."""

from __future__ import annotations

import pytest
from research_step.main import (
    _build_derive_user,
    _build_query_prompt,
    _derive_system,
    _op_run,
    _synthesis_system,
)

from writer_engine.schemas.chapter import ResearchPlan


def test_derive_user_fills_topic_genre_setting() -> None:
    out = _build_derive_user("the Spinning Mule", "historical-time-travel", "1820s Lancashire")
    assert "the Spinning Mule" in out
    assert "historical-time-travel" in out
    assert "1820s Lancashire" in out
    assert "scene-generating" in out or "scene idea" in out  # Sal test framing


def test_query_prompt_shapes_period_place() -> None:
    out = _build_query_prompt("price of porter", "1820s", "England")
    assert "price of porter" in out
    assert "1820s" in out and "England" in out
    assert "misconception" in out.lower()  # perplexity_query seed present


def test_derive_and_synthesis_systems_have_craft() -> None:
    assert "ResearchPlan" in _derive_system()
    assert "scene seed" in _synthesis_system().lower()
    assert "Sal" in _synthesis_system() or "potatoes" in _synthesis_system()


def test_research_plan_tolerates_string_list() -> None:
    plan = ResearchPlan.model_validate(["What did they eat?", "How did the looms work?"])
    assert [q.question for q in plan.questions] == ["What did they eat?", "How did the looms work?"]


def test_research_plan_tolerates_questions_envelope() -> None:
    plan = ResearchPlan.model_validate({"questions": [{"question": "Q1", "category": "daily_life"}]})
    assert plan.questions[0].category == "daily_life"


@pytest.mark.asyncio
async def test_op_run_fixture_path() -> None:
    # No provider -> stub derive + stub answers, but the orchestration (derive->query->synthesize) runs.
    out = await _op_run({"topic": "medieval cathedral building", "period": "12th century"})
    row = out["row"]
    assert row["topic"] == "medieval cathedral building"
    assert len(row["questions"]) >= 1
    assert out["qa"] and "question" in out["qa"][0]
