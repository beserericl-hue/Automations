"""I3 — a chapter's opening never saw how the previous chapter actually ended.

`prior_tail` chains sub-chapters INSIDE a chapter and started empty for sub-chapter 1, so the only
cross-chapter link was `bridge_from_prior` — what the outline *planned* the join would be. Across 96
chapters of a detailed outline that held. On a thin outline, or wherever the previous chapter drifted
from its plan, the seam shows: the new chapter opens on an imagined ending.

The fix reuses the mechanism that already works between sub-chapters, one level up.
"""

from __future__ import annotations

import asyncio

import pytest
from chapter_step import main as M


class TestPriorChapterTail:
    def test_it_returns_the_closing_words_of_the_previous_chapter(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = " ".join(f"w{i}" for i in range(2000))

        async def _load(_pid: str, n: int) -> str:
            assert n == 11, "it must read the PREVIOUS chapter, not this one"
            return body

        monkeypatch.setattr(M, "_load_persisted_chapter", _load)
        tail = asyncio.run(M._prior_chapter_tail("p", 12))
        assert len(tail.split()) == M.PRIOR_CHAPTER_TAIL_WORDS
        assert tail.endswith("w1999"), "the END of the chapter is the part that matters"
        assert "w0 " not in tail

    def test_a_short_previous_chapter_is_returned_whole(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def _load(_pid: str, _n: int) -> str:
            return "She closed the drawer and did not open it again."

        monkeypatch.setattr(M, "_load_persisted_chapter", _load)
        assert asyncio.run(M._prior_chapter_tail("p", 5)).endswith("open it again.")

    def test_the_first_chapter_has_no_predecessor(self, monkeypatch: pytest.MonkeyPatch) -> None:
        called = []

        async def _load(_pid: str, n: int) -> str:
            called.append(n)
            return "should not be read"

        monkeypatch.setattr(M, "_load_persisted_chapter", _load)
        assert asyncio.run(M._prior_chapter_tail("p", 0)) == ""
        assert called == [], "chapter 0 must not query for chapter -1"

    def test_an_unwritten_predecessor_yields_nothing_quietly(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The normal case in a concurrent batch: 8 chapters in flight, so N may start before N-1
        finishes. The outline's bridge then carries the join exactly as before."""

        async def _load(_pid: str, _n: int) -> str:
            return ""

        monkeypatch.setattr(M, "_load_persisted_chapter", _load)
        assert asyncio.run(M._prior_chapter_tail("p", 40)) == ""

    def test_a_database_failure_does_not_fail_the_chapter(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def _load(_pid: str, _n: int) -> str:
            raise ConnectionError("supabase down")

        monkeypatch.setattr(M, "_load_persisted_chapter", _load)
        assert asyncio.run(M._prior_chapter_tail("p", 40)) == ""

    def test_the_write_path_seeds_the_sequential_loop_with_it(self) -> None:
        """A helper nothing calls is worth nothing."""
        import inspect

        src = inspect.getsource(M)
        assert "prior_tail = await _prior_chapter_tail(" in src
        # and it must still chain between subs afterwards
        assert 'prior_tail = " ".join(t.split()[-800:])' in src

    def test_it_reuses_the_same_window_as_the_sub_chapter_chain(self) -> None:
        """800 words in both places, so the join across a chapter boundary reads like the joins
        inside one."""
        assert M.PRIOR_CHAPTER_TAIL_WORDS == 800
