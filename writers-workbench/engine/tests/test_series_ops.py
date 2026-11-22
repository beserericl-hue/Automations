"""The series ops: book titles, the series pitch, and a revised close for one book.

Each one's output is checked in code against the books, because each has a specific way of going
wrong: a title about a different book, a pitch that names someone who is not in it, an ending
spliced in at a sentence that is not in the chapter.
"""

from __future__ import annotations

import asyncio
import types
from typing import Any

import pytest
from chapter_step import main as M

from writer_engine.schemas.chapter import (
    BookEndingDraft,
    CodaPlan,
    ContinuityFindings,
    RecapDraft,
    SeriesDescription,
    SeriesTitleBook,
    SeriesTitleCandidate,
    SeriesTitles,
    UnsupportedClaims,
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

    def test_a_decade_is_checked_against_the_record_not_loose_dialogue(self) -> None:
        """Book 3: dialogue said "the 1930s excavation", so "in the 1930s and 1940s" slipped through."""
        book = "He knew the 1930s excavation, the 1940s transfer. Excavated between 1935 and 1951."
        record = "1935\u20131951 Excavation of 18PR8 Sixteen-year excavation. 1942 Deed of Gift Transfer"
        assert M._unsupported_numbers("She dug in the 1930s and 1940s.", book, record=record) == [
            '"1930s" is not in the book or the record',
            '"1940s" is not in the book or the record',
        ]
        # Without a record the chapters are the only evidence, as before.
        assert M._unsupported_numbers("She dug in the 1930s and 1940s.", book) == []

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


FRAME_OUTLINE = {
    "story_arc_name": "The Stratigraphic Ascent",
    "premise": "A repatriation dig on a Potomac bluff.",
    "dramatic_question": "Can the bones go home?",
    "chapters": [
        {
            "chapter_number": 1,
            "title": "The Surface",
            "act": "The Surface",
            "beat": "Sylvia arrives.",
            "period": "2011",
        },
        {
            "chapter_number": 30,
            "title": "Winifred",
            "act": "The Surface",
            "beat": "Marcus and Renata read the journal.",
            "period": "2011",
        },
        {
            "chapter_number": 31,
            "title": "Stratum IV",
            "act": "Stratum IV",
            "beat": "The fort post stands.",
            "period": "1674",
        },
    ],
}
PROJECT = "11111111-1111-1111-1111-111111111111"
CODA_TEXT = " ".join(["Renata set the stapler down and read the plot twice."] * 70)


@pytest.fixture
def pipeline(chapters: None, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    async def load(_pid: str, _payload: Any = None) -> dict[str, Any]:
        return {
            "title": "The Ossuary",
            "genre_slug": "post-apocalyptic",
            "outline": FRAME_OUTLINE,
            "roster": [{"name": "Marcus", "description": "tribal member"}],
        }

    async def research(beat: str, *, period: str, title: str, focus: str = "") -> tuple[str, list[str]]:
        seen["research_beat"] = beat
        return "Inadvertent discoveries must be reported.", ["discovery notice"]

    async def canon(_ctx: Any, beat: str, *, user_id: Any) -> str:
        seen["canon_beat"] = beat
        return ""

    async def write(**k: Any) -> tuple[str, int, int]:
        seen["write_brief"] = k["brief"]
        seen["write_system"] = k["system"]
        return seen.get("text", CODA_TEXT), 0, 0

    async def drift(text: str, *, ctx: Any, req: Any, **_k: Any) -> tuple[str, None, int]:
        seen["drift_chapter"] = req.chapter_number
        seen["drift_beat"] = M._chapter_outline_beat(ctx["outline"], req.chapter_number)
        return text, None, 0

    async def score(*_a: Any, **_k: Any) -> None:
        return None

    monkeypatch.setattr(M, "_load_context", load)
    monkeypatch.setattr(M, "_chapter_research", research)
    monkeypatch.setattr(M, "_canon_grounding", canon)
    monkeypatch.setattr(M, "_write_subchapter", write)
    monkeypatch.setattr(M, "_drift_correct_pass", drift)
    monkeypatch.setattr(M, "_score_chapter", score)
    return seen


CLEAN = ContinuityFindings(problems=[])
PLAN = CodaPlan(
    title="The Plot Under the Binder",
    beat="Renata finds the survey plot Marcus has held back.",
    pov_character="Renata Voss",
    characters=["Renata Voss"],
    story_turn="She understands what Marcus has not said.",
    hook="Someone will lift the binder who is not her.",
    resolved="The secret is no longer Marcus's alone.",
    carried="What Renata will do with it.",
    outline_beat="Closing scene: Renata finds the held survey plot.",
    next_bridge="Renata brings Marcus the journal.",
    research_questions=["What must a discovery notice trigger?"],
)


class TestBookCoda:
    def test_plans_researches_writes_and_checks_the_scene_against_its_own_beat(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        prompts = answer(monkeypatch, PLAN, CLEAN)
        out = asyncio.run(
            M._op_draft_book_coda(
                {
                    "project_id": PROJECT,
                    "user_id": "u",
                    "book": BOOK1,
                    "next_book": BOOK2,
                    "direction": "season finale",
                }
            )
        )
        assert out["ok"] is True
        assert out["content_id"] == "c30" and out["words"] >= M.BOOK_CODA_MIN_WORDS
        assert out["hook"] == "Someone will lift the binder who is not her."
        assert out["outline_beat"].startswith("Closing scene") and out["next_bridge"]
        # Planned from the arc guide and the author's direction, with the next book's opening to lead into.
        assert "season finale" in prompts[0] and "Susquehannock" in prompts[0]
        assert "STRATIGRAPHIC" in prompts[0].upper()
        # Researched on exactly what the plan was unsure of, and the study was folded into the writer's system.
        assert "discovery notice" in out["research_topics"]
        assert "What must a discovery notice trigger?" in pipeline["research_beat"]
        assert "Inadvertent discoveries" in pipeline["write_system"]
        # Written as a section of the book, checked for drift against the scene's own planned beat.
        assert pipeline["write_brief"].pov_character == "Renata Voss"
        assert "Someone will lift the binder" in pipeline["write_brief"].beat
        assert pipeline["drift_chapter"] == M.CODA_VIRTUAL_CHAPTER
        assert "Renata finds the survey plot" in pipeline["drift_beat"]

    def test_refuses_a_scene_outside_the_length_a_closing_scene_can_be(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pipeline["text"] = "Too short."
        answer(monkeypatch, PLAN, CLEAN)
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is False and "words" in out["reason"]

    def test_refuses_a_plan_with_no_hook(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answer(monkeypatch, CodaPlan(beat="A scene.", hook=""))
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is False and "hook" in out["reason"]

    def test_reports_a_name_that_is_not_in_the_book(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pipeline["text"] = CODA_TEXT + " Esteban Ruiz looked up from the desk."
        answer(monkeypatch, PLAN, CLEAN)
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is True and any(n in ("Esteban", "Ruiz", "Esteban Ruiz") for n in out["new_names"])


RECAP_BOOK = {"index": 2, "first_chapter": 31, "last_chapter": 31}
RECAP_TEXT = " ".join(["Sylvia walks the bluff above the Potomac and Marcus holds the report."] * 14)


class TestBookRecap:
    def test_a_supported_recap_is_returned(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        prompts = answer(monkeypatch, RecapDraft(text=RECAP_TEXT), UnsupportedClaims(claims=[]))
        out = asyncio.run(
            M._op_draft_book_recap(
                {
                    "project_id": PROJECT,
                    "book": RECAP_BOOK,
                    "previous_books": [BOOK1],
                    "series_name": "The Ossuary",
                }
            )
        )
        assert out["ok"] is True and out["chapter_number"] == 31 and out["content_id"] == "c31"
        assert "SOURCE" in prompts[0] and "Sylvia arrives" in prompts[0]
        # The book it precedes is not shown to the writer: nothing in it can leak into the recap.
        assert "Susquehannock" not in prompts[0]

    def test_an_unsupported_claim_is_sent_back_once_and_the_corrected_recap_accepted(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        prompts = answer(
            monkeypatch,
            RecapDraft(text=RECAP_TEXT),
            UnsupportedClaims(claims=["Marcus burns the report"]),
            RecapDraft(text=RECAP_TEXT),
            UnsupportedClaims(claims=[]),
        )
        out = asyncio.run(
            M._op_draft_book_recap({"project_id": PROJECT, "book": RECAP_BOOK, "previous_books": [BOOK1]})
        )
        assert out["ok"] is True
        assert "Marcus burns the report" in prompts[2]

    def test_a_name_that_is_not_in_the_earlier_books_is_refused_twice(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        bad = RecapDraft(text=RECAP_TEXT + " Esteban Ruiz arrives with a letter.")
        answer(monkeypatch, bad, bad, bad)
        out = asyncio.run(
            M._op_draft_book_recap({"project_id": PROJECT, "book": RECAP_BOOK, "previous_books": [BOOK1]})
        )
        assert out["ok"] is False and "Ruiz" in out["reason"] and "three times" in out["reason"]

    def test_needs_an_earlier_book(self, pipeline: dict[str, Any]) -> None:
        out = asyncio.run(
            M._op_draft_book_recap({"project_id": PROJECT, "book": RECAP_BOOK, "previous_books": []})
        )
        assert out["ok"] is False


class TestSeriesPiecesAreKept:
    def test_a_coda_is_kept_on_the_project_for_the_author_when_asked(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stored: list[tuple[str, Any, dict[str, Any]]] = []

        async def keep(_pid: str, bucket: str, index: Any, draft: dict[str, Any]) -> None:
            stored.append((bucket, index, draft))

        monkeypatch.setattr(M, "_store_series_piece", keep)
        answer(monkeypatch, PLAN, CLEAN)
        out = asyncio.run(
            M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2, "persist": True})
        )
        assert out["ok"] is True
        assert [(b, i) for b, i, _ in stored] == [("codas", 1)]
        # What is kept is what the author is shown, and it carries the hash of the chapter it was written for.
        assert stored[0][2]["text"] == out["text"] and len(stored[0][2]["base_hash"]) == 64

    def test_nothing_is_kept_unless_asked(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def keep(*_a: Any, **_k: Any) -> None:
            raise AssertionError("must not store")

        monkeypatch.setattr(M, "_store_series_piece", keep)
        answer(monkeypatch, PLAN, CLEAN)
        assert asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1}))["ok"] is True

    def test_a_recap_is_kept_under_the_book_it_opens(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stored: list[tuple[str, Any]] = []

        async def keep(_pid: str, bucket: str, index: Any, _draft: dict[str, Any]) -> None:
            stored.append((bucket, index))

        monkeypatch.setattr(M, "_store_series_piece", keep)
        answer(monkeypatch, RecapDraft(text=RECAP_TEXT), UnsupportedClaims(claims=[]))
        out = asyncio.run(
            M._op_draft_book_recap(
                {"project_id": PROJECT, "book": RECAP_BOOK, "previous_books": [BOOK1], "persist": True}
            )
        )
        assert out["ok"] is True and stored == [("recaps", 2)]


class TestQaFindingsOnThePieces:
    def test_a_scene_of_the_wrong_length_is_written_again_with_the_count_told_to_the_writer(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        beats: list[str] = []
        texts = ["Too short.", CODA_TEXT]

        async def write(**k: Any) -> tuple[str, int, int]:
            beats.append(k["brief"].beat)
            return texts.pop(0), 0, 0

        monkeypatch.setattr(M, "_write_subchapter", write)
        answer(monkeypatch, PLAN, CLEAN)
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is True and len(beats) == 2
        assert "Your last draft was 2 words" in beats[1]

    def test_the_outline_keeps_the_scenes_plan_not_the_instructions_for_writing_it(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answer(monkeypatch, PLAN, CLEAN)
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["brief"]["beat"] == PLAN.beat
        assert "words" not in out["brief"]["beat"] and "hook" not in out["brief"]["beat"]
        # The writer is told the hook and the length.
        assert (
            "Someone will lift the binder" in pipeline["write_brief"].beat
            and "450 to 1500 words" in pipeline["write_brief"].beat
        )

    def test_a_failure_anywhere_in_the_run_is_a_reason_the_author_can_read_and_is_kept(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        kept: list[tuple[str, Any, dict[str, Any]]] = []

        async def keep(_pid: str, bucket: str, index: Any, draft: dict[str, Any]) -> bool:
            kept.append((bucket, index, draft))
            return True

        async def broken(*_a: Any, **_k: Any) -> Any:
            raise ValueError("malformed drift json")

        monkeypatch.setattr(M, "_store_series_piece", keep)
        monkeypatch.setattr(M, "_drift_correct_pass", broken)
        answer(monkeypatch, PLAN, CLEAN)
        out = asyncio.run(
            M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2, "persist": True})
        )
        assert (
            out["ok"] is False and "ValueError" in out["reason"] and "malformed drift json" in out["reason"]
        )
        assert kept == [("codas", 1, {"failed": out["reason"]})]

    def test_a_piece_already_in_the_book_is_never_replaced_by_a_new_draft(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        written: list[dict[str, Any]] = []

        class Table:
            def __init__(self, applied: bool) -> None:
                self.applied = applied

            def select(self, *_a: Any) -> Table:
                return self

            def update(self, row: dict[str, Any]) -> Table:
                written.append(row)
                return self

            def eq(self, *_a: Any) -> Table:
                return self

            def limit(self, *_a: Any) -> Table:
                return self

            async def execute(self) -> Any:
                return types.SimpleNamespace(
                    data=[
                        {"outline": {"_series": {"codas": {"1": {"applied_at": "x", "text": "in the book"}}}}}
                    ]
                )

        class Client:
            def table(self, _n: str) -> Table:
                return Table(True)

        async def client() -> Client:
            return Client()

        import writer_engine.supabase.client as sc

        monkeypatch.setattr(sc, "get_supabase_admin", client)
        assert (
            asyncio.run(M._store_series_piece(PROJECT, "codas", 1, {"text": "new", "research": "big"}))
            is False
        )
        assert written == []

    def test_the_kept_draft_leaves_out_the_research_text_but_keeps_its_topics(self) -> None:
        stored: dict[str, Any] = {}

        class Table:
            def select(self, *_a: Any) -> Table:
                return self

            def update(self, row: dict[str, Any]) -> Table:
                stored.update(row["outline"]["_series"]["codas"]["1"])
                return self

            def eq(self, *_a: Any) -> Table:
                return self

            def limit(self, *_a: Any) -> Table:
                return self

            async def execute(self) -> Any:
                return types.SimpleNamespace(data=[{"outline": {}}])

        class Client:
            def table(self, _n: str) -> Table:
                return Table()

        async def client() -> Client:
            return Client()

        import writer_engine.supabase.client as sc

        original = sc.get_supabase_admin
        sc.get_supabase_admin = client  # type: ignore[assignment]
        try:
            assert asyncio.run(
                M._store_series_piece(
                    PROJECT, "codas", 1, {"text": "t", "research": "big " * 1000, "research_topics": ["a"]}
                )
            )
        finally:
            sc.get_supabase_admin = original  # type: ignore[assignment]
        assert "research" not in stored and stored["research_topics"] == ["a"] and stored["drafted_at"]

    def test_what_the_planner_read_the_ending_as_settling_reaches_the_scene_plan(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        prompts = answer(monkeypatch, PLAN, CLEAN)
        asyncio.run(
            M._op_draft_book_coda(
                {
                    "project_id": PROJECT,
                    "book": BOOK1,
                    "next_book": BOOK2,
                    "resolves": "the ring is placed",
                    "carries": "who saw it",
                }
            )
        )
        assert "the ring is placed" in prompts[0] and "who saw it" in prompts[0]

    def test_a_next_book_with_no_text_yet_is_not_treated_as_the_last_book(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        prompts = answer(monkeypatch, PLAN, CLEAN)
        unwritten = {"index": 2, "first_chapter": 90, "last_chapter": 99}
        out = asyncio.run(
            M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": unwritten})
        )
        assert out["ok"] is True
        assert "not written yet" in prompts[0] and "This is the last book" not in prompts[0]


class TestFoundByARealRun:
    def test_the_plan_instructions_name_every_field_the_engine_reads(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A real run came back "no scene or no hook": the model was told "match CodaPlan" without being told the keys.
        systems: list[str] = []

        async def fake(_router: Any, **k: Any) -> tuple[Any, None]:
            systems.append(k["system"])
            return PLAN, None

        monkeypatch.setattr(M, "complete_structured", fake)
        asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        for key in CodaPlan.model_fields:
            assert key in systems[0], f"the plan instructions never name `{key}`"

    def test_a_plan_with_no_hook_says_which_part_was_missing(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answer(monkeypatch, CodaPlan(beat="A scene.", hook=""))
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is False and out["reason"] == "the plan came back with no hook"


class TestContinuityAgainstTheBooksAround:
    def test_a_scene_that_contradicts_the_next_book_is_written_again_with_the_problems_told_to_the_writer(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        beats: list[str] = []

        async def write(**k: Any) -> tuple[str, int, int]:
            beats.append(k["brief"].beat)
            return CODA_TEXT, 0, 0

        monkeypatch.setattr(M, "_write_subchapter", write)
        prompts = answer(
            monkeypatch,
            PLAN,
            ContinuityFindings(problems=["texts 'page 211' but the next book opens on page forty-one"]),
            CLEAN,
        )
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is True and len(beats) == 2
        assert "page 211" in beats[1] and "inventing nothing that is plot" in beats[1]
        # The check reads the scene against the next book's opening, not just the cast and the arc.
        assert "Susquehannock" in prompts[1] and CODA_TEXT[:40] in prompts[1]

    def test_a_scene_that_keeps_contradicting_is_kept_for_the_author_with_the_problems(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        bad = ContinuityFindings(problems=["invents a provenance card that appears nowhere in the book"])
        answer(monkeypatch, PLAN, bad, bad, bad)
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is True and any("provenance card" in p for p in out["problems"])

    def test_the_planner_is_told_to_invent_no_plot(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        systems: list[str] = []

        async def fake(_router: Any, **k: Any) -> tuple[Any, None]:
            systems.append(k["system"])
            return (PLAN if len(systems) == 1 else CLEAN), None

        monkeypatch.setattr(M, "complete_structured", fake)
        asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert "Invent nothing that is plot" in systems[0]
        assert "ContinuityFindings" in systems[1]


class TestRecapKnowsTheCast:
    def test_the_recap_and_its_checker_are_given_the_cast_so_relationships_are_not_guessed(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        prompts = answer(monkeypatch, RecapDraft(text=RECAP_TEXT), UnsupportedClaims(claims=[]))
        asyncio.run(
            M._op_draft_book_recap({"project_id": PROJECT, "book": RECAP_BOOK, "previous_books": [BOOK1]})
        )
        assert "THE CAST" in prompts[0] and "Marcus" in prompts[0]
        assert "THE CAST" in prompts[1]  # the claim check reads against it too


class TestContinuityCheckReach:
    """Each of these is a way the check failed on the real book, now pinned."""

    @staticmethod
    def _rows_with_a_deep_fact() -> list[dict[str, Any]]:
        deep = (
            "Filler sentence about nothing at all. " * 300
            + "The 1692 treaty named the Piscataway as a people."
        )
        return [
            *ROWS[:2],
            {"id": "c31", "chapter_number": 31, "title": "Stratum IV", "content_text": deep},
        ]

    def test_a_fact_far_into_the_next_chapter_reaches_the_check(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The real miss: a treaty at character 7,292 of chapter 60, behind a 3,500-character window.
        rows = self._rows_with_a_deep_fact()
        assert rows[2]["content_text"].index("1692") > 8000

        async def get_rows(_pid: str) -> list[dict]:
            return rows

        monkeypatch.setattr(M, "_project_chapter_rows", get_rows)
        prompts = answer(monkeypatch, PLAN, CLEAN)
        asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert "The 1692 treaty named the Piscataway" in prompts[1]

    def test_the_whole_next_book_is_seen_in_outline_not_just_its_frame_thread(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        wide = {
            **FRAME_OUTLINE,
            "chapters": [
                *FRAME_OUTLINE["chapters"],
                {
                    "chapter_number": 32,
                    "title": "Stratum V",
                    "act": "Stratum V",
                    "beat": "The reservation stone is set.",
                },
            ],
        }

        async def load(_pid: str, _payload: Any = None) -> dict[str, Any]:
            return {"title": "The Ossuary", "genre_slug": "post-apocalyptic", "outline": wide, "roster": []}

        monkeypatch.setattr(M, "_load_context", load)
        prompts = answer(monkeypatch, PLAN, CLEAN)
        asyncio.run(
            M._op_draft_book_coda(
                {
                    "project_id": PROJECT,
                    "book": BOOK1,
                    "next_book": {"index": 2, "first_chapter": 31, "last_chapter": 32},
                }
            )
        )
        assert "The reservation stone is set." in prompts[1] and "The fort post stands." in prompts[1]

    def test_names_found_nowhere_in_the_book_and_the_retrieved_canon_go_to_the_judge(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pipeline["text"] = CODA_TEXT + " Governor Lyonell Copley read the Articles aloud."

        async def canon(_ctx: Any, beat: str, *, user_id: Any) -> str:
            return "CANON: Winifred kept a cedar box under her bed."

        monkeypatch.setattr(M, "_canon_grounding", canon)
        prompts = answer(monkeypatch, PLAN, CLEAN)
        asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert "NOT FOUND ANYWHERE IN THE BOOK" in prompts[1] and "Lyonell" in prompts[1]
        assert "cedar box under her bed" in prompts[1]

    def test_an_inconsistency_already_in_the_book_is_reported_not_held_against_the_scene(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The real blocker: a surname spelled two ways in the manuscript stopped every scene that mentioned her.
        found = ContinuityFindings(
            problems=[],
            existing_inconsistencies=["the lawyer is 'Okafor' in chapter 5 and 'Okonkwo' in chapter 25"],
        )
        answer(monkeypatch, PLAN, found)
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is True
        assert out["existing_inconsistencies"] == [
            "the lawyer is 'Okafor' in chapter 5 and 'Okonkwo' in chapter 25"
        ]

    def test_the_judge_is_told_to_sort_the_two_kinds_of_problem(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        systems: list[str] = []

        async def fake(_router: Any, **k: Any) -> tuple[Any, None]:
            systems.append(k["system"])
            return (PLAN if len(systems) == 1 else CLEAN), None

        monkeypatch.setattr(M, "complete_structured", fake)
        asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert "existing_inconsistencies" in systems[1] and "Do NOT put in `problems`" in systems[1]
        assert "invention" in systems[1].lower() or "inventions" in systems[1].lower()


class TestPreEmption:
    def test_the_judge_is_told_a_scene_that_plays_the_next_books_events_is_a_problem(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Two real misses: a scene that showed Marcus learning from the journal what chapter 30 first shows, and one that
        # had Sylvia file the report that chapter 85 first shows. The check called the second "consistent with the outline".
        systems: list[str] = []

        async def fake(_router: Any, **k: Any) -> tuple[Any, None]:
            systems.append(k["system"])
            return (PLAN if len(systems) == 1 else CLEAN), None

        monkeypatch.setattr(M, "complete_structured", fake)
        asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert "PRE-EMPTION" in systems[1] and "never an `existing_inconsistencies` item" in systems[1]
        # The planner is told the same thing before anything is written.
        assert "Do not enact, reveal, show or resolve any event" in systems[0]

    def test_a_pre_empting_scene_is_sent_back_and_the_writer_is_told_why(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        beats: list[str] = []

        async def write(**k: Any) -> tuple[str, int, int]:
            beats.append(k["brief"].beat)
            return CODA_TEXT, 0, 0

        monkeypatch.setattr(M, "_write_subchapter", write)
        answer(
            monkeypatch,
            PLAN,
            ContinuityFindings(problems=["pre-empts chapter 85: Sylvia files the hydrology report here"]),
            CLEAN,
        )
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is True and "pre-empts chapter 85" in beats[1]


class TestTheWriterStaysInsideTheBeat:
    def test_the_writer_is_told_no_backstory_or_history_because_it_collides_with_other_chapters(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Real runs padded scenes with Winifred's marriage and with the 1996 and 2004 hearings, which later chapters show.
        answer(monkeypatch, PLAN, CLEAN)
        asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        beat = pipeline["write_brief"].beat
        assert "Stay inside this beat" in beat and "No backstory, flashback, memory" in beat
        assert "aim for the low end" in beat


class TestANearMissIsKeptForTheAuthor:
    def test_a_scene_the_check_still_objects_to_is_kept_with_its_problems_not_thrown_away(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stored: list[tuple[str, Any, dict[str, Any]]] = []

        async def keep(_pid: str, bucket: str, index: Any, draft: dict[str, Any]) -> bool:
            stored.append((bucket, index, draft))
            return True

        monkeypatch.setattr(M, "_store_series_piece", keep)
        bad = ContinuityFindings(
            problems=["the original journal is not in a sub-basement; chapter 30 has it on a desk"]
        )
        answer(monkeypatch, PLAN, bad, bad, bad)
        out = asyncio.run(
            M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2, "persist": True})
        )
        assert out["ok"] is True and out["problems"] == [
            "the original journal is not in a sub-basement; chapter 30 has it on a desk"
        ]
        assert out["text"] and stored[0][2]["problems"] == out["problems"]

    def test_a_scene_of_the_wrong_length_is_still_refused_outright(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pipeline["text"] = "Too short."
        answer(monkeypatch, PLAN)
        out = asyncio.run(M._op_draft_book_coda({"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2}))
        assert out["ok"] is False


class TestCheckingTheAuthorsEdit:
    def test_the_check_runs_on_the_text_as_edited_and_clears_the_problems_when_there_are_none(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        patches: list[dict[str, Any]] = []

        async def update(_pid: str, bucket: str, index: Any, patch: dict[str, Any]) -> bool:
            assert (bucket, index) == ("codas", 1)
            patches.append(patch)
            return True

        monkeypatch.setattr(M, "_update_series_piece", update)
        prompts = answer(monkeypatch, CLEAN)
        out = asyncio.run(
            M._op_check_book_coda(
                {
                    "project_id": PROJECT,
                    "book": BOOK1,
                    "next_book": BOOK2,
                    "text": "The author's own edited scene.",
                    "persist": True,
                }
            )
        )
        assert out["ok"] is True and out["problems"] == []
        assert "The author's own edited scene." in prompts[0]
        assert (
            patches[0]["needs_check"] is False and patches[0]["problems"] == [] and patches[0]["checked_at"]
        )

    def test_a_problem_found_in_an_edit_is_reported_and_kept(
        self, pipeline: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        patches: list[dict[str, Any]] = []

        async def update(_pid: str, _bucket: str, _index: Any, patch: dict[str, Any]) -> bool:
            patches.append(patch)
            return True

        monkeypatch.setattr(M, "_update_series_piece", update)
        answer(monkeypatch, ContinuityFindings(problems=["still names a page"]))
        out = asyncio.run(
            M._op_check_book_coda(
                {"project_id": PROJECT, "book": BOOK1, "next_book": BOOK2, "text": "Edited.", "persist": True}
            )
        )
        assert out["problems"] == ["still names a page"] and patches[0]["problems"] == ["still names a page"]

    def test_the_check_needs_a_text(self, pipeline: dict[str, Any]) -> None:
        out = asyncio.run(M._op_check_book_coda({"project_id": PROJECT, "book": BOOK1, "text": ""}))
        assert out["ok"] is False


class TestSuggestPassageFix:
    PASSAGE = (
        "The room smelled of burned coffee. The folding chairs scraped against the linoleum as the "
        "last observers filed out. Marcus nodded back."
    )

    def run(self, **extra: Any) -> dict:
        return asyncio.run(M._op_suggest_passage_fix({"passage": self.PASSAGE, "problem": "flat", **extra}))

    def test_returns_a_rewrite_of_about_the_same_length(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(M, "get_router", lambda service=None: object())
        prompts = answer(
            monkeypatch,
            types.SimpleNamespace(
                text="Marcus breathed in burned coffee. Chairs scraped the linoleum as the last observers left. "
                "He nodded back."
            ),
        )
        out = self.run(before="She spoke.", after="He left.")
        assert out["ok"] is True
        assert "burned coffee" in out["text"]
        assert "She spoke." in prompts[0] and "He left." in prompts[0]

    def test_refuses_a_rewrite_that_is_far_from_the_length_and_says_why(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(M, "get_router", lambda service=None: object())
        answer(
            monkeypatch,
            types.SimpleNamespace(text="Marcus nodded."),
            types.SimpleNamespace(text="Marcus nodded."),
        )
        out = self.run()
        assert out["ok"] is False
        assert "length" in out["reason"]

    def test_strips_em_dashes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(M, "get_router", lambda service=None: object())
        answer(
            monkeypatch,
            types.SimpleNamespace(
                text="Marcus breathed in burned coffee — stale. Chairs scraped the linoleum as the last "
                "observers left. He nodded back."
            ),
        )
        assert "—" not in self.run()["text"]

    def test_empty_passage_is_refused(self) -> None:
        out = asyncio.run(M._op_suggest_passage_fix({"passage": "  "}))
        assert out["ok"] is False


class TestRecommendCliffhangers:
    def _setup(self, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, dict]]:
        kept: list[tuple[str, str, dict]] = []

        async def store(project_id: str, bucket: str, index: Any, draft: dict) -> bool:
            kept.append((bucket, str(index), draft))
            return True

        monkeypatch.setattr(M, "_store_series_piece", store)
        return kept

    @staticmethod
    def _judge(monkeypatch: pytest.MonkeyPatch, bad: str = "Quill") -> list[str]:
        seen: list[str] = []

        async def fake(_router: Any, _model: str, **k: Any) -> tuple[list[str], list[str]]:
            seen.append(k["text"])
            return ([f"the next book already shows {bad} later"] if bad in k["text"] else []), []

        monkeypatch.setattr(M, "_coda_continuity", fake)
        return seen

    @staticmethod
    def _opt(t: str, s: str) -> Any:
        return types.SimpleNamespace(title=t, hook=f"{t} hook", scene=s, uses="ch 1", avoid="ch 31")

    def _run(self) -> dict:
        return asyncio.run(
            M._op_recommend_cliffhangers(
                {
                    "project_id": "p",
                    "book": {"index": 1, "first_chapter": 0, "last_chapter": 30},
                    "next_book": {"index": 2, "first_chapter": 31, "last_chapter": 61},
                    "persist": True,
                }
            )
        )

    def test_reads_every_candidate_against_the_next_book_and_offers_the_clean_ones_first(
        self, chapters: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        kept = self._setup(monkeypatch)
        seen = self._judge(monkeypatch)
        prompts = answer(
            monkeypatch,
            types.SimpleNamespace(
                options=[
                    self._opt("A danger", "Zebediah Quill arrives at the gate."),
                    self._opt("A decision", "Marcus stands at the door \u2014 and does not knock."),
                    self._opt("A fact", "Renata reads a line she did not expect."),
                    self._opt("A call", "Sylvia lets the phone ring."),
                ]
            ),
        )
        out = self._run()
        assert out["ok"] is True
        assert [o["title"] for o in out["options"]] == ["A decision", "A fact", "A call"]
        assert all(o["problems"] == [] for o in out["options"])
        assert len(seen) == 4  # every candidate was judged, including the one that failed
        assert "\u2014" not in out["options"][0]["scene"]
        assert kept and kept[0][0] == "cliffhangers" and kept[0][1] == "1"
        assert "THE NEXT BOOK" in prompts[0]

    def test_shows_a_flagged_option_with_its_problem_when_none_is_clean(
        self, chapters: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._setup(monkeypatch)
        self._judge(monkeypatch)
        answer(
            monkeypatch,
            types.SimpleNamespace(options=[self._opt("A danger", "Zebediah Quill arrives at the gate.")]),
        )
        out = self._run()
        assert out["ok"] is True
        assert out["options"][0]["problems"] == ["the next book already shows Quill later"]
        assert "Quill" in " ".join(out["options"][0]["new_names"])

    def test_refuses_when_the_engine_returns_nothing_usable(
        self, chapters: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._setup(monkeypatch)
        answer(
            monkeypatch,
            types.SimpleNamespace(
                options=[types.SimpleNamespace(title="x", hook="", scene="", uses="", avoid="")]
            ),
        )
        assert self._run()["ok"] is False
