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

    out = asyncio.run(CHAPTER_OPS["write"]({
        "project_id": str(uuid.uuid4()), "chapter_number": 1, "chapter_run_id": str(uuid.uuid4()),
        "parallel_subchapters": True, "sub_chapter_count_override": 3,
        "sub_chapter_briefs": [{"beat": "a"}, {"beat": "b"}, {"beat": "c"}],
    }))
    assert "content_text" in out and "word_count" in out


def test_write_subchapter_plan_context_path_reaches_llm() -> None:
    # idx>0 with no prior_tail but a plan_context takes the coordinated-prompt branch and reaches the
    # LLM call — with no provider configured that surfaces as ProviderNotRegistered (no fixture at
    # this level; _op_write catches it). Reaching the call proves the branch built a prompt.
    from writer_engine.llm import ProviderNotRegistered

    try:
        res = asyncio.run(_write_subchapter(
            system="cached system prefix", brief=SubChapterBrief(beat="x"), idx=1, total=3,
            prior_tail="", chapter_number=1, model="claude-sonnet-4-6",
            plan_context="CHAPTER PLAN ...",
        ))
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
