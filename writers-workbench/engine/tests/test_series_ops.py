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


class TestMarketingKnowsItIsASeriesBook:
    def test_a_titled_series_book_is_sold_on_its_own(self) -> None:
        note = M._series_book_note(
            {"index": 2, "total": 3, "series_name": "The Ossuary", "book_title": "The Arithmetic of Release"}
        )
        assert '"The Arithmetic of Release", BOOK 2 of 3 in the series The Ossuary' in note
        assert "has not read the earlier books" in note

    def test_without_a_series_it_is_still_a_volume(self) -> None:
        assert M._series_book_note({"index": 2, "total": 3}).startswith("This is VOLUME 2 of 3.")


ROSTER = [
    {
        "name": "Marcus Tayac",
        "description": "Piscataway Historic Preservation Officer, drives the repatriation effort.",
    },
    {"name": "Sylvia Runningwater", "description": "Dine contract archaeologist and ceramicist."},
]


class TestMarketingKeepsTheCastStraight:
    def test_catches_a_job_given_to_the_wrong_person(self) -> None:
        text = "Archaeologist Marcus Tayac has spent years trying to bring the dead home."
        assert M._role_mismatches(text, ROSTER) == [
            "Marcus Tayac is called an archaeologist, which the cast list does not say"
        ]

    def test_catches_an_appositive(self) -> None:
        assert M._role_mismatches("Marcus Tayac, a museum curator, signs.", ROSTER)

    def test_leaves_correct_roles_and_other_peoples_jobs_alone(self) -> None:
        text = (
            "Sylvia Runningwater, a contract archaeologist, maps the bluff while Marcus, the tribe's "
            "preservation officer, fights the petition."
        )
        assert M._role_mismatches(text, ROSTER) == []

    def test_the_cast_reaches_the_copywriter(self) -> None:
        block = M._cast_block(ROSTER)
        assert "never give one person another's job" in block and "Marcus Tayac: Piscataway" in block


class TestMarketingGetsTheDatesFromTheRecord:
    """Book 1's copy said "excavated in the 1930s" for a dig the bible records as 1935-1951."""

    def _bible(self, monkeypatch: pytest.MonkeyPatch, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        calls: list[dict[str, Any]] = []

        class _Q:
            def __init__(self) -> None:
                self.f: dict[str, Any] = {}

            def select(self, *_a: Any) -> _Q:
                return self

            def eq(self, k: str, v: Any) -> _Q:
                self.f[k] = v
                return self

            def is_(self, *_a: Any) -> _Q:
                return self

            def limit(self, *_a: Any) -> _Q:
                return self

            async def execute(self) -> Any:
                calls.append(self.f)
                return type("R", (), {"data": rows})()

        class _C:
            def table(self, _t: str) -> _Q:
                return _Q()

        async def admin() -> _C:
            return _C()

        import writer_engine.supabase.client as sc

        monkeypatch.setattr(sc, "get_supabase_admin", admin)
        return calls

    def test_events_the_book_mentions_win_over_older_ones(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Oldest-first handed over 25 events ending in 1680; the 1935-1951 dig never made it."""
        monkeypatch.setattr(M, "CANON_DATE_LIMIT", 2)
        calls = self._bible(
            monkeypatch,
            [
                {"name": "The Paleoindian crossing", "description": "Around 1100 BC, a hunter."},
                {"name": "1608 Smith's voyage", "description": "Smith maps the Potomac."},
                {"name": "1935\u20131951 Excavation of 18PR8", "description": "Sixteen-year excavation."},
                {"name": "The burning of the longhouse", "description": "No date given."},
            ],
        )
        lines, evidence = asyncio.run(
            M._load_canon_dates("p1", book_text="Four ossuaries, excavated between 1935 and 1951.")
        )
        assert calls[0] == {"project_id": "p1", "entry_type": "event"}
        # The on-page event is kept, the slot left goes to the oldest, and the list reads in order.
        assert [ln.split(":")[0] for ln in lines] == [
            "- The Paleoindian crossing",
            "- 1935\u20131951 Excavation of 18PR8",
        ]
        assert "1608 Smith" in evidence  # every dated event is evidence, even one not handed over
        block = M._canon_dates_block(lines)
        assert block.startswith("THE RECORD") and "1935\u20131951" in block

    def test_book_ones_invented_span_and_squeezed_decades_are_caught(self) -> None:
        book = "Four ossuaries, excavated between 1935 and 1951. The deed was signed in 1942. In 1668 the boundary."
        copy = (
            "Dorothy Voss excavated them in the 1930s and 1940s. The colonial record arrives in 1668. "
            "The 344-year span Marcus tracks begins there. Under 1,200 characters."
        )
        assert M._unsupported_numbers(copy, book) == [
            '"1930s" is not in the book or the record',
            '"1940s" is not in the book or the record',
            '"344" is not in the book or the record',
        ]
        assert M._unsupported_numbers("Excavated between 1935 and 1951, a sixteen-year dig.", book) == []

    def test_an_unreadable_bible_is_not_a_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import writer_engine.supabase.client as sc

        async def boom() -> Any:
            raise RuntimeError("supabase down")

        monkeypatch.setattr(sc, "get_supabase_admin", boom)
        assert asyncio.run(M._load_canon_dates("p1")) == ([], "")
        assert M._canon_dates_block([]) == ""

    def test_the_copywriter_is_told_a_span_stays_a_span_and_to_use_no_dashes(self) -> None:
        system = M._build_marketing_system("ancient-history", "", True)
        assert "A span stays a span" in system and "1935 to 1951" in system
        assert "No dashes of any kind" in system
        # Book 1's copy sold a Book 3 scene (Winifred at the 1935 dig, chapter 76) taken from the record.
        assert "a scene from a later book is a promise this one does not keep" in system
