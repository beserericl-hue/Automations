"""The judge that decides where one book of a series can end.

A series book has to do two things at its end: settle the story it promised, and hand the reader a
larger question only the next book answers. The planner used to reward the opposite of the first —
it scored a mid-scene stop ("the box is on the table, unlocked") as the best break in the book —
which sells a book that reads as if its last pages were torn out.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from chapter_step import main as M
from pydantic import ValidationError

from writer_engine.schemas.chapter import SeriesEndingJudgement
from writer_engine.volumes import MID_SCENE_CAP, ChapterInfo, series_ending_score


class TestTheReviewerIsAskedTheRightQuestion:
    @staticmethod
    def _system() -> str:
        return M._build_volume_ending_system()

    def test_it_is_about_a_series_book_not_a_good_chapter(self) -> None:
        s = self._system()
        assert "ONE BOOK IN A SERIES" in s
        assert "NOT the question" in s

    def test_it_scores_closing_and_opening_separately(self) -> None:
        s = self._system()
        assert "`closes`" in s and "`opens`" in s
        assert "SETTLE" in s and "LARGER question" in s

    def test_it_names_a_mid_scene_stop_as_a_cut_not_an_ending(self) -> None:
        s = self._system()
        assert "`mid_scene`" in s
        assert "a cut, not an ending" in s
        assert "box on the table" in s

    def test_it_asks_for_what_is_settled_and_what_is_carried(self) -> None:
        s = self._system()
        assert "`resolved`" in s and "`carried`" in s


class TestTheScore:
    def test_both_halves_are_needed(self) -> None:
        assert series_ending_score(0.9, 0.9, False) == pytest.approx(0.9)
        # Settles everything, opens nothing: no reason to buy on.
        assert series_ending_score(1.0, 0.1, False) < 0.35
        # Opens everything, settles nothing: a cliffhanger.
        assert series_ending_score(0.1, 1.0, False) < 0.35

    def test_a_mid_scene_stop_is_capped_however_strong(self) -> None:
        assert series_ending_score(0.95, 0.95, True) == MID_SCENE_CAP

    def test_the_verdict_is_applied_with_the_judges_words(self) -> None:
        info = ChapterInfo(number=30, title="Winifred", words=6000, tail="…")
        M._apply_ending_verdict(
            info,
            SeriesEndingJudgement(
                closes=0.8,
                opens=0.8,
                resolved="Marcus decides to open the box.",
                carried="What the box holds will change the petition.",
                reason="lands the decision and points past it",
            ),
        )
        assert info.judged == pytest.approx(0.8)
        assert info.resolves == "Marcus decides to open the box."
        assert "petition" in info.carries
        assert info.ending_score == pytest.approx(0.8)


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

    def test_the_leading_chapters_reach_the_judge(self) -> None:
        seen: dict[str, str] = {}

        async def fake(router, **k):
            seen["prompt"] = k["prompt"]
            return SeriesEndingJudgement(), None

        with (
            patch.object(M, "complete_structured", fake),
            patch.object(M, "get_router", lambda service=None: object()),
        ):
            asyncio.run(
                M._judge_volume_ending("closing prose", 30, "Winifred", ["28. The box", "29. The lock"])
            )
        assert "28. The box" in seen["prompt"] and "CLOSING pages" in seen["prompt"]


class TestTheSchemaDefaultsAreSafe:
    def test_a_blank_answer_is_neutral_not_perfect(self) -> None:
        j = SeriesEndingJudgement()
        assert series_ending_score(j.closes, j.opens, j.mid_scene) == pytest.approx(0.5)

    def test_scores_are_clamped(self) -> None:
        with pytest.raises(ValidationError):
            SeriesEndingJudgement(closes=1.8)
