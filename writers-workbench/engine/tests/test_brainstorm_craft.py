"""brainstorm_step composes the Follett plot+character craft layer; StoryOutline is tolerant."""

from __future__ import annotations

import pytest
from brainstorm_step.main import _build_story_system, _op_edit_outline, _op_story

from writer_engine.schemas.chapter import StoryOutline


def test_story_system_has_genre_arc_and_plot_seeds() -> None:
    sys = _build_story_system("political-scifi", "Three-Act Structure")
    assert "GENRE: political-scifi" in sys
    assert "STORY ARC: Three-Act Structure" in sys
    assert "dramatic question" in sys.lower()  # plot.dramatic_question
    assert "OUTLINE QUALITY GATE" in sys or "outline quality gate" in sys.lower()  # outline_gate
    assert "off-axis attribute" in sys  # character.broad_strokes_then_twist
    assert "StoryOutline" in sys


def test_story_outline_unwraps_envelope_and_splits_themes() -> None:
    o = StoryOutline.model_validate(
        {"outline": {"title": "X", "themes": "loss, memory, war", "premise": "p"}}
    )
    assert o.title == "X"
    assert o.themes == ["loss", "memory", "war"]


@pytest.mark.asyncio
async def test_op_story_fixture_path() -> None:
    out = await _op_story({"title": "The Accord", "genre": "political-scifi", "story_arc": "Freytag"})
    assert out["outline"]["title"] == "The Accord"
    assert out["outline"]["story_arc_name"] == "Freytag"


@pytest.mark.asyncio
async def test_edit_outline_no_edits_is_noop() -> None:
    base = {"title": "T", "characters": [{"name": "Ana", "role": "lead"}], "chapters": []}
    out = await _op_edit_outline({"outline": base, "edits": []})
    assert out["applied"] == 0
    assert out["outline"] == base
