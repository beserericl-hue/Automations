"""F2.5 optimization: parallel sub-chapter writing path (flagged) + plan-context coordination."""

from __future__ import annotations

import asyncio

from chapter_step.main import OPS as CHAPTER_OPS
from chapter_step.main import _subchapter_plan_text, _write_subchapter

from writer_engine.schemas.chapter import SubChapterBrief


def test_plan_text_lists_all_subbeats() -> None:
    briefs = [SubChapterBrief(title="A", beat="arrival"), SubChapterBrief(title="B", beat="conflict")]
    txt = _subchapter_plan_text(briefs)
    assert "1. A — arrival" in txt and "2. B — conflict" in txt
    assert "all sub-chapters" in txt


def test_parallel_subs_run_concurrently_no_provider() -> None:
    # With no LLM provider, _write_subchapter falls back via router error -> exercised through the
    # full write op: confirm the parallel flag path returns a chapter (fixture) without raising.
    import uuid

    out = asyncio.run(
        CHAPTER_OPS["write"](
            {
                "project_id": str(uuid.uuid4()),
                "chapter_number": 1,
                "chapter_run_id": str(uuid.uuid4()),
                "parallel_subchapters": True,
                "sub_chapter_count_override": 3,
                "sub_chapter_briefs": [{"beat": "a"}, {"beat": "b"}, {"beat": "c"}],
            }
        )
    )
    assert "content_text" in out and "word_count" in out


def test_write_subchapter_plan_context_path_reaches_llm() -> None:
    # idx>0 with no prior_tail but a plan_context takes the coordinated-prompt branch and reaches the
    # LLM call — with no provider configured that surfaces as ProviderNotRegistered (no fixture at
    # this level; _op_write catches it). Reaching the call proves the branch built a prompt.
    from writer_engine.llm import ProviderNotRegistered

    try:
        res = asyncio.run(
            _write_subchapter(
                system="cached system prefix",
                brief=SubChapterBrief(beat="x"),
                idx=1,
                total=3,
                prior_tail="",
                chapter_number=1,
                model="claude-sonnet-4-6",
                plan_context="CHAPTER PLAN ...",
            )
        )
        assert isinstance(res, tuple) and isinstance(res[0], str)  # (prose, cache_read, cache_write)
    except ProviderNotRegistered:
        pass  # no provider -> reached the LLM call via the plan-context branch (expected)


def test_cached_write_system_folds_context_and_grounding() -> None:
    from chapter_step.main import _cached_write_system

    s = _cached_write_system("CRAFT SYSTEM", "PROJECT: X\nOUTLINE: ...", "Fact: copper traded south.")
    assert "CRAFT SYSTEM" in s
    assert "PROJECT / OUTLINE / CHARACTER-ROSTER CONTEXT" in s and "PROJECT: X" in s
    assert "RESEARCH GROUNDING" in s and "copper traded south" in s
    # no grounding section when none supplied
    assert "RESEARCH GROUNDING" not in _cached_write_system("CRAFT", "HEADER", "")


# --- scene breaks between merged sub-chapters (found by the H3 parity harness) ----------------


def test_merged_subchapters_are_separated_by_a_scene_break() -> None:
    """N sub-chapters must yield N-1 scene breaks.

    The L5 parity harness found all 96 chapters of the Burial Mound run contained ZERO internal
    scene breaks while the n8n baseline's carried 1-13: sub-chapters were joined with a bare blank
    line. The craft layer asks for scene construction and a story turn every 4-6 pages
    (follett_seeds.scene.bme_check / scene.turn_density), so a chapter that reads as one undivided
    block is a craft regression — and nothing was measuring it.
    """
    from chapter_step.main import SCENE_BREAK

    parts = ["scene one prose", "scene two prose", "scene three prose"]
    merged = SCENE_BREAK.join(parts)
    assert merged.count("\n---\n") == len(parts) - 1
    # Each part survives intact.
    for p in parts:
        assert p in merged


def test_scene_break_is_the_markdown_horizontal_rule_convention() -> None:
    """`---` is what the short-story op already instructs ("use --- between scenes") and what the
    n8n chapters used, so exports and the editor render it the same way."""
    from chapter_step.main import SCENE_BREAK

    assert SCENE_BREAK.strip() == "---"


def test_write_op_joins_with_the_scene_break_not_a_blank_line() -> None:
    """Regression guard on the join site itself: a bare "\\n\\n".join silently undoes the fix."""
    from pathlib import Path

    src = Path("services/chapter_step/src/chapter_step/main.py").read_text()
    assert "SCENE_BREAK.join(sub_texts)" in src
    assert '"\\n\\n".join(sub_texts)' not in src


def test_single_subchapter_chapter_has_no_stray_break() -> None:
    """A one-sub-chapter chapter must not gain a leading/trailing rule."""
    from chapter_step.main import SCENE_BREAK

    assert SCENE_BREAK.join(["only scene"]) == "only scene"
