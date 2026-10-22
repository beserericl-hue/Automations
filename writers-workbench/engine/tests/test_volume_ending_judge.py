"""The judge that decides where a volume can end.

The distinction this exists to enforce: "is this a good chapter" and "can a volume end here" are
different questions, and conflating them is how a trilogy's first volume closes on its most
spectacular scene and still gives the reader no reason to buy the second.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from chapter_step import main as M

from writer_engine.schemas.chapter import VolumeEndingJudgement


class TestTheReviewerIsAskedTheRightQuestion:
    @staticmethod
    def _system() -> str:
        return M._build_volume_ending_system()

    def test_it_separates_a_good_chapter_from_a_good_ending(self) -> None:
        s = self._system()
        assert "NOT the question" in s
        assert "best in the book and the worst possible place to stop" in s

    def test_it_names_what_scores_high(self) -> None:
        s = self._system()
        for signal in ("not answered", "has not yet been paid", "arriving", "already in motion"):
            assert signal in s

    def test_it_names_what_scores_low(self) -> None:
        s = self._system()
        for signal in ("resolution", "farewell", "at peace", "time-skip"):
            assert signal in s

    def test_it_asks_for_the_resolves_flag(self) -> None:
        """The flag is what catches a strong chapter that is nonetheless the wrong break."""
        assert "resolves" in self._system()


class TestResolutionDemotesAStrongChapter:
    """A chapter can read as a 0.9 and still tie everything off. When it does, it must not be
    chosen as a volume break — that is the single most expensive mistake this planner can make."""

    @staticmethod
    def _run(verdict: VolumeEndingJudgement):
        from writer_engine.volumes import ChapterInfo

        info = ChapterInfo(number=30, title="t", words=6000, tail="…closing pages…")

        async def fake_judge(tail: str, n: int, title: str):
            return verdict

        # Mirrors the demotion in _op_plan_volumes.
        async def apply() -> None:
            v = await fake_judge(info.tail, info.number, info.title)
            info.cliffhanger = min(v.cliffhanger, 0.25) if v.resolves else v.cliffhanger
            info.cliffhanger_reason = v.reason or v.unresolved

        asyncio.run(apply())
        return info

    def test_a_resolving_chapter_is_demoted_however_strong(self) -> None:
        info = self._run(VolumeEndingJudgement(cliffhanger=0.9, resolves=True, reason="ties off"))
        assert info.cliffhanger <= 0.25

    def test_an_open_chapter_keeps_its_score(self) -> None:
        info = self._run(
            VolumeEndingJudgement(cliffhanger=0.88, resolves=False, reason="she is still out there")
        )
        assert info.cliffhanger == 0.88

    def test_the_reason_is_carried_through_for_the_author_to_read(self) -> None:
        info = self._run(VolumeEndingJudgement(cliffhanger=0.8, unresolved="the bundle is still missing"))
        assert "bundle" in info.cliffhanger_reason


class TestTheJudgeDegrades:
    def test_empty_text_is_not_judged(self) -> None:
        assert asyncio.run(M._judge_volume_ending("", 1, "t")) is None

    def test_an_unparseable_answer_returns_none_rather_than_a_guess(self) -> None:
        async def boom(*a, **k):
            raise ValueError("not JSON")

        with (
            patch.object(M, "complete_structured", boom),
            patch.object(M, "get_router", lambda service=None: object()),
        ):
            assert asyncio.run(M._judge_volume_ending("some prose", 4, "t")) is None


class TestTheSchemaDefaultsAreSafe:
    def test_a_missing_score_is_neutral_not_perfect(self) -> None:
        """A blank answer must not nominate a chapter as the best break in the book."""
        assert VolumeEndingJudgement().cliffhanger == 0.5

    def test_scores_are_clamped(self) -> None:
        import pytest
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            VolumeEndingJudgement(cliffhanger=1.8)
