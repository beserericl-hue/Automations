"""chapter_step composes the Follett craft layer into write + QA, and degrades to fixtures.

The pure system-prompt builders are the testable seam — they assert the craft layer (prime
directive + genre + arc + the right seeds) is actually present in what the LLM receives, so a
dropped/renamed seed fails CI rather than silently writing craft-blind chapters.
"""

from __future__ import annotations

import pytest
from chapter_step.main import (
    _build_qa_system,
    _build_write_system,
    _op_qa,
    _op_write,
)


def test_write_system_has_prime_genre_arc_and_seeds() -> None:
    sys = _build_write_system(
        genre_slug="post-apocalyptic",
        outline={"story_arc": "Freytag's pyramid"},
        revision=False,
    )
    assert "reader must share in the emotions" in sys  # prime directive
    assert "GENRE: post-apocalyptic" in sys
    assert "STORY ARC: Freytag's pyramid" in sys
    assert "see THROUGH your sentences" in sys  # prose.transparent
    assert "cares MOST about the outcome" in sys  # character.pov_selector
    assert "LOCKED CHARACTERS" not in sys  # not revision


def test_write_system_revision_locks_roster() -> None:
    sys = _build_write_system(genre_slug="scifi-romance", outline={}, revision=True)
    assert "LOCKED CHARACTERS" in sys  # character.locked_roster prepended in revision mode


def test_qa_system_scores_against_guide() -> None:
    sys = _build_qa_system()
    assert "score the chapter" in sys.lower()
    assert "ChapterCraftQa" in sys
    assert "story turn" in sys.lower()  # turn_density seed present
    assert "anachronistic language" in sys  # research.period_language seed present


@pytest.mark.asyncio
async def test_op_write_fixture_path() -> None:
    # No Supabase + no LLM provider in the test env -> deterministic fixture, but the real code path
    # (context load -> craft compose -> generate) is exercised up to the provider call.
    out = await _op_write(
        {
            "project_id": "00000000-0000-4000-8000-000000000001",
            "chapter_number": 3,
            "chapter_run_id": "00000000-0000-4000-8000-0000000000aa",
            "llm_strategy": "sonnet",
        }
    )
    assert out["word_count"] > 0
    assert out["chapter_run_id"] == "00000000-0000-4000-8000-0000000000aa"
    # No provider in tests -> fixture draft, revision loop is skipped.
    assert out["craft_passes"] == 0


def test_low_dims_flags_under_threshold() -> None:
    from chapter_step.main import _low_dims

    from writer_engine.schemas.chapter import ChapterCraftQa

    qa = ChapterCraftQa.model_validate(
        {
            "character_follows_guide": 0.9,
            "outline_follows_guide": 0.7,
            "dialogue_follows_guide": 0.9,
            "prose_transparent": 0.9,
            "story_turn_density": 0.9,
            "no_boring_paragraphs": 0.75,
            "period_language_ok": 0.9,
        }
    )
    assert set(_low_dims(qa)) == {"outline_follows_guide", "no_boring_paragraphs"}


def test_every_qa_dim_has_revision_seeds() -> None:
    # A low score on any guide dimension must map to targeted revision seeds.
    from chapter_step.main import _DIM_TO_SEEDS, QA_DIMS

    assert set(_DIM_TO_SEEDS) == set(QA_DIMS)
    for seeds in _DIM_TO_SEEDS.values():
        assert seeds and all(s.startswith("follett_seeds.") for s in seeds)


@pytest.mark.asyncio
async def test_op_qa_returns_all_guide_dimensions() -> None:
    out = await _op_qa({"chapter_id": "c1", "content_text": "Some chapter prose."})
    scores = out["scores"]
    for dim in (
        "character_follows_guide",
        "outline_follows_guide",
        "dialogue_follows_guide",
        "prose_transparent",
        "story_turn_density",
        "no_boring_paragraphs",
        "period_language_ok",
    ):
        assert dim in scores and 0.0 <= scores[dim] <= 1.0
    assert "findings" in out
