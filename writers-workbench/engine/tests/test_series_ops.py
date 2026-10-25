"""The series ops: book titles, the series pitch, and a revised close for one book.

Each one's output is checked in code against the books, because each has a specific way of going
wrong: a title about a different book, a pitch that names someone who is not in it, an ending
spliced in at a sentence that is not in the chapter.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from chapter_step import main as M

from writer_engine.schemas.chapter import (
    BookEndingDraft,
    SeriesDescription,
    SeriesTitleBook,
    SeriesTitleCandidate,
    SeriesTitles,
)

CH30 = (
    "Marcus carried the box down the bluff. "
    "The light went pewter over the river. "
    "He set it on the table and did not open it. "
    "Winifred watched him from the doorway. "
    "I need to think, he said."
)
ROWS = [
    {
        "id": "c1",
        "chapter_number": 1,
        "title": "The Surface",
        "content_text": "Sylvia arrives at the bluff before dawn. The terrace above the Potomac held four ossuaries.",
    },
    {"id": "c30", "chapter_number": 30, "title": "Winifred", "content_text": CH30},
    {
        "id": "c31",
        "chapter_number": 31,
        "title": "Stratum IV",
        "content_text": "The Susquehannock fort post stood in 1674. Bent-Reed carried the slab.",
    },
]
BOOK1 = {"index": 1, "first_chapter": 1, "last_chapter": 30}
BOOK2 = {"index": 2, "first_chapter": 31, "last_chapter": 31}


@pytest.fixture
def chapters(monkeypatch: pytest.MonkeyPatch) -> None:
    async def rows(_pid: str) -> list[dict]:
        return ROWS

    monkeypatch.setattr(M, "_project_chapter_rows", rows)
    monkeypatch.setattr(M, "get_router", lambda service=None: object())


def answer(monkeypatch: pytest.MonkeyPatch, *results: Any) -> list[str]:
    prompts: list[str] = []
    queue = list(results)

    async def fake(_router: Any, **k: Any) -> tuple[Any, None]:
        prompts.append(k["prompt"])
        return queue.pop(0), None

    monkeypatch.setattr(M, "complete_structured", fake)
    return prompts


class TestTitles:
    def test_keeps_a_title_only_when_its_phrase_is_in_that_book(
        self, chapters: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answer(
            monkeypatch,
            SeriesTitles(
                books=[
                    SeriesTitleBook(
                        index=1,
                        candidates=[
                            SeriesTitleCandidate(
                                title="The Pewter Light",
                                phrase="The light went pewter over the river",
                                why="w",
                            ),
                            SeriesTitleCandidate(
                                title="Bones of the Vatican",
                                phrase="the Vatican archive held them",
                                why="invented",
                            ),
                            SeriesTitleCandidate(
                                title="Book One", phrase="He set it on the table", why="numbered"
                            ),
                            SeriesTitleCandidate(
                                title="The Ossuary", phrase="held four ossuaries above", why="the series name"
                            ),
                        ],
                    ),
                    SeriesTitleBook(
                        index=2,
                        candidates=[
                            # Its phrase is in book ONE, not book two.
                            SeriesTitleCandidate(
                                title="Four Ossuaries",
                                phrase="The terrace above the Potomac held four ossuaries",
                                why="w",
                            ),
                            SeriesTitleCandidate(
                                title="The Fort Post",
                                phrase="The Susquehannock fort post stood in 1674",
                                why="w",
                            ),
                        ],
                    ),
                ]
            ),
        )
        out = asyncio.run(
            M._op_series_titles({"project_id": "p", "series_name": "The Ossuary", "books": [BOOK1, BOOK2]})
        )
        assert out["ok"] is True
        assert [c["title"] for c in out["books"][0]["candidates"]] == ["The Pewter Light"]
        assert [c["title"] for c in out["books"][1]["candidates"]] == ["The Fort Post"]
        assert out["dropped"] == 4

    def test_needs_books(self) -> None:
        assert asyncio.run(M._op_series_titles({"project_id": "p"}))["ok"] is False


DESCRIPTION_BOOKS = [
    {
        "index": 1,
        "title": "The Pewter Light",
        "hook": "Who speaks for the dead?",
        "blurb": "Sylvia Runningwater arrives at a Maryland bluff.",
    },
    {"index": 2, "title": "The Fort Post", "hook": "", "blurb": "Bent-Reed carries the slab."},
]


class TestDescription:
    def test_returns_a_pitch_that_names_only_what_the_books_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(M, "get_router", lambda service=None: object())
        answer(
            monkeypatch,
            SeriesDescription(
                description="On a Maryland bluff, Sylvia Runningwater begins with the dead.",
                tagline="Who speaks for them",
            ),
        )
        out = asyncio.run(
            M._op_series_description({"series_name": "The Ossuary", "books": DESCRIPTION_BOOKS})
        )
        assert out["ok"] is True and "Sylvia" in out["description"]

    def test_sends_an_invented_name_back_once_then_refuses(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(M, "get_router", lambda service=None: object())
        bad = SeriesDescription(
            description="Sylvia meets Father Okonkwo in the archive of the Vatican.", tagline="t"
        )
        prompts = answer(monkeypatch, bad, bad)
        out = asyncio.run(
            M._op_series_description({"series_name": "The Ossuary", "books": DESCRIPTION_BOOKS})
        )
        assert out["ok"] is False and "Okonkwo" in out["reason"]
        assert "Okonkwo" in prompts[1]

    def test_a_corrected_second_draft_is_accepted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(M, "get_router", lambda service=None: object())
        answer(
            monkeypatch,
            SeriesDescription(description="Sylvia meets Father Okonkwo in the archive.", tagline="t"),
            SeriesDescription(description="Sylvia Runningwater arrives at a Maryland bluff.", tagline="t"),
        )
        assert (
            asyncio.run(M._op_series_description({"series_name": "The Ossuary", "books": DESCRIPTION_BOOKS}))[
                "ok"
            ]
            is True
        )


class TestBookEnding:
    def test_splices_at_a_sentence_that_is_in_the_chapter_and_reports_new_names(
        self, chapters: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ending = (
            "He opened it. "
            + "Marcus read the names aloud, one by one, and Winifred wrote them down. " * 30
            + "Esteban Ruiz would want to see this."
        )
        prompts = answer(
            monkeypatch,
            BookEndingDraft(
                replace_from="Winifred watched him from the doorway.",
                new_ending=ending,
                resolved="Marcus opens the box.",
                carried="The names change the petition.",
            ),
        )
        out = asyncio.run(M._op_draft_book_ending({"project_id": "p", "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is True
        assert out["content_id"] == "c30"
        assert out["current_ending"] == "Winifred watched him from the doorway. I need to think, he said."
        assert out["offset"] == CH30.index("Winifred watched")
        assert "Esteban" in out["new_names"] or "Ruiz" in out["new_names"]
        assert "Marcus" not in out["new_names"]
        # The next book's opening is what the new close has to lead into.
        assert "Susquehannock" in prompts[0]

    def test_refuses_a_splice_point_that_is_not_in_the_chapter(
        self, chapters: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answer(monkeypatch, BookEndingDraft(replace_from="He watched the doorway.", new_ending="x " * 400))
        out = asyncio.run(M._op_draft_book_ending({"project_id": "p", "book": BOOK1}))
        assert out["ok"] is False and "not in the chapter" in out["reason"]

    def test_refuses_to_replace_most_of_the_chapter(
        self, chapters: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answer(
            monkeypatch,
            BookEndingDraft(replace_from="Marcus carried the box down the bluff.", new_ending="x " * 400),
        )
        out = asyncio.run(M._op_draft_book_ending({"project_id": "p", "book": BOOK1}))
        assert out["ok"] is False and "rewrite" in out["reason"]
