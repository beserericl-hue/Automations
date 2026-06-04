"""Outline revision (directive-driven) + chapter rewrite (from feedback) + F1-2 genre/bible schemas."""

from __future__ import annotations

import asyncio

from brainstorm_step.main import OPS as BRAINSTORM_OPS
from brainstorm_step.main import _build_revise_system
from chapter_step.main import OPS as CHAPTER_OPS
from chapter_step.main import (
    _apply_ctx_overrides,
    _briefs_from_payload,
    _build_extract_bible_system,
    _build_genre_eval_system,
    _build_rewrite_system,
    _roster_from_outline,
)

from writer_engine.schemas.chapter import BibleExtract, GenreEval


def test_plan_op_registered() -> None:
    assert "plan" in CHAPTER_OPS  # the explicit outline -> chapter-outline -> narrative middle stage


def test_roster_from_outline() -> None:
    roster = _roster_from_outline({"characters": [
        {"name": "Saya", "role": "Past POV (1693)", "description": "the woman who ran"},
        {"name": "Tayak"},
        {"role": "no name — dropped"},
    ]})
    assert roster[0]["name"] == "Saya" and "1693" in roster[0]["description"]
    assert any(r["name"] == "Tayak" for r in roster)
    assert len(roster) == 2


def test_apply_ctx_overrides_uses_outline_and_derives_roster() -> None:
    base = {"genre_slug": "g", "title": "DB Title", "outline": {"a": 1}, "roster": []}
    ov = _apply_ctx_overrides(dict(base), {
        "title": "The Burial Mound",
        "outline": {"characters": [{"name": "Yanu", "role": "founding ancestor"}], "chapters": []},
    })
    assert ov["title"] == "The Burial Mound"
    assert ov["outline"]["characters"][0]["name"] == "Yanu"
    assert ov["roster"][0]["name"] == "Yanu"  # roster derived from the override outline


def test_briefs_from_payload_parses_dicts_and_strings() -> None:
    briefs = _briefs_from_payload({"sub_chapter_briefs": [
        {"title": "Arrival", "beat": "Saya reaches the river", "pov_character": "Saya"},
        "She buries the pendant",
    ]})
    assert len(briefs) == 2
    assert briefs[0].title == "Arrival" and briefs[0].pov_character == "Saya"
    assert briefs[1].beat == "She buries the pendant"
    assert _briefs_from_payload({}) == []


def test_revise_op_registered() -> None:
    assert "revise-outline" in BRAINSTORM_OPS


def test_revise_system_preserves_and_allows_new() -> None:
    s = _build_revise_system("The Burial Mound")
    assert "TITLE LOCK" in s and "The Burial Mound" in s
    assert "EXISTING character" in s  # preserve existing cast
    assert "add new POV characters" in s  # but may add new ones
    assert "interwoven second timeline" in s  # supports the dual-timeline directive
    assert "arc_point" in s


def test_revise_outline_noops_without_directive() -> None:
    out = asyncio.run(BRAINSTORM_OPS["revise-outline"]({"outline": {"title": "X", "chapters": []}}))
    assert out["revised"] is False


def test_rewrite_op_registered() -> None:
    assert "rewrite" in CHAPTER_OPS


def test_rewrite_needs_text_and_feedback() -> None:
    out = asyncio.run(CHAPTER_OPS["rewrite"]({"content_text": "a chapter", "feedback": ""}))
    assert out["rewritten"] is False
    out2 = asyncio.run(CHAPTER_OPS["rewrite"]({"content_text": "", "feedback": "make it darker"}))
    assert out2["rewritten"] is False


def test_rewrite_system_preserves_pov_and_length() -> None:
    s = _build_rewrite_system("ancient-history")
    assert "FEEDBACK" in s
    assert "POV" in s
    assert "AT LEAST as long" in s
    assert "Confirmed cast" in s  # forbids scaffolding


def test_genre_eval_schema_coerces_0_100_and_wrapper() -> None:
    ev = GenreEval.model_validate({"genre_eval": {"genre_score": 87, "notes": "strong period voice"}})
    assert ev.genre_score == 0.87
    assert ev.notes == ["strong period voice"]


def test_bible_extract_normalizes_types_and_drops_invalid() -> None:
    be = BibleExtract.model_validate({"entries": [
        {"type": "Character", "name": "Tayak", "description": "archaeologist"},
        {"entry_type": "weapon", "name": "atlatl", "description": "spear-thrower"},  # invalid -> concept
        {"description": "no name — dropped"},
    ]})
    assert len(be.entries) == 2
    assert be.entries[0].entry_type == "character"
    assert be.entries[1].entry_type == "concept"


def test_genre_eval_system_mentions_genre() -> None:
    assert "GENRE" in _build_genre_eval_system("ancient-history")
    assert "story-bible" in _build_extract_bible_system()


def test_compact_outline_view_is_lean() -> None:
    from chapter_step.main import _compact_outline_view

    outline = {
        "title": "The Burial Mound", "premise": "dual timeline", "story_arc_name": "The Descent",
        "chapters": [
            {"chapter_number": i, "title": f"Ch{i}", "act": "Act I", "pov_character": "Tayak",
             "beat": "X" * 400}
            for i in range(96)
        ],
    }
    view = _compact_outline_view(outline, 44)
    # focal chapter present in full; the other 95 chapters appear only as a one-line index (no beats)
    assert "THIS CHAPTER" in view and "chapter_number: 44" in view
    assert "FULL CHAPTER INDEX" in view
    # huge: full dump would be ~96*400 chars; the compact view must be far smaller
    assert len(view) < 6000
    assert view.count("X" * 400) == 1  # only the focal chapter's long beat is included
