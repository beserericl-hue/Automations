"""Canon memory between chapters: the research chunk, the prose it must not delete, and staleness.

Three defects, all measured on live DEV projects 2026-10-18:

1. A chapter-by-chapter research study attached 149 cited facts to The Ossuary's outline and
   `build_canon_chunks` never read them — it built `chapter_brief` from beat/arc_notes/bridge only.
   The study was in the product and invisible to the writer.
2. `index_project_canon`'s delete was scoped to (user_id, project_id) with no doc_type filter, so a
   canon reindex destroyed J3's `chapter_prose` index — 1,879 chunks on The Burial Mound.
3. The coverage guard counted prose in `existing`, so on The Burial Mound (2,996 vectors, 1,879 of
   them prose) a canon reindex producing ~1,100 chunks read as a 63% coverage DROP and raised
   RuntimeError. J1's backfill had locked reindexing out of the project it was built for.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

from writer_engine.embeddings import embed as E


class _Query:
    """A query builder whose execute() hands back one canned response."""

    def __init__(self, resp: Any) -> None:
        self._resp = resp

    async def execute(self) -> Any:
        return self._resp


def _outline_with_research():
    return {
        "premise": "A repatriation excavation frames twelve thousand years.",
        "chapters": [
            {
                "chapter_number": 39,
                "title": "OSSUARY IV, STRATUM VIII — Burned palisade post, ca. AD 1500",
                "beat": "Tayac-II watches the second palisade line burn.",
                "bridge_from_prior": "The potter's vessel of ch 38 is fired.",
                "research": {
                    "period": "ca. AD 1500",
                    "facts": [
                        {
                            "fact": "Ossuary 1 lay within the innermost palisade of the village.",
                            "source": "Ferguson & Stewart 1940",
                        },
                        {"fact": "148 hearths were recorded across the site's phases.", "source": "SF 1963"},
                    ],
                    "local_color": ["The dead are inside the wall."],
                    "flags": ["Do not import 17th-century tribute descriptions into a 15th-century scene."],
                },
            },
            {"chapter_number": 40, "title": "Frame: The Developer", "beat": "Marcus reads the filing."},
        ],
    }


class TestResearchChunk:
    def test_a_chapter_with_research_gets_its_own_chunk(self) -> None:
        chunks = E.build_canon_chunks(_outline_with_research(), [])
        research = [c for c in chunks if c["doc_type"] == E.RESEARCH_DOC_TYPE]
        assert len(research) == 1
        assert research[0]["doc_id"] == "ch_39_research"

    def test_the_facts_and_their_sources_are_in_the_content(self) -> None:
        """A fact without its source is unattributable; the writer must be handed both."""
        c = next(
            x
            for x in E.build_canon_chunks(_outline_with_research(), [])
            if x["doc_type"] == E.RESEARCH_DOC_TYPE
        )
        assert "innermost palisade" in c["content"]
        assert "Ferguson & Stewart 1940" in c["content"]
        assert "148 hearths" in c["content"]

    def test_local_colour_and_cautions_are_included(self) -> None:
        """Flags especially: a writer who cannot see them will confidently dramatise something the
        record does not support."""
        c = next(
            x
            for x in E.build_canon_chunks(_outline_with_research(), [])
            if x["doc_type"] == E.RESEARCH_DOC_TYPE
        )
        assert "LOCAL COLOUR: The dead are inside the wall." in c["content"]
        assert "CAUTION:" in c["content"]
        assert "17th-century tribute" in c["content"]

    def test_the_brief_is_not_swamped_by_the_research(self) -> None:
        """Separate doc types, so retrieval can return the plan without the facts and vice versa."""
        chunks = E.build_canon_chunks(_outline_with_research(), [])
        brief = next(c for c in chunks if c["doc_type"] == "chapter_brief" and c["doc_id"] == "ch_39")
        assert "innermost palisade" not in brief["content"]
        assert "Tayac-II watches" in brief["content"]

    def test_a_chapter_without_research_adds_nothing(self) -> None:
        chunks = E.build_canon_chunks(_outline_with_research(), [])
        assert not [c for c in chunks if c["doc_id"] == "ch_40_research"]

    def test_empty_or_malformed_research_adds_nothing(self) -> None:
        for bad in ({}, {"facts": []}, "not a dict", None, {"facts": [{}, {"fact": ""}]}):
            o = {"chapters": [{"chapter_number": 1, "title": "x", "beat": "b", "research": bad}]}
            assert not [c for c in E.build_canon_chunks(o, []) if c["doc_type"] == E.RESEARCH_DOC_TYPE], bad

    def test_facts_are_capped(self) -> None:
        """One richly-researched chapter must not dominate retrieval for the whole book."""
        o = {
            "chapters": [
                {
                    "chapter_number": 1,
                    "title": "x",
                    "beat": "b",
                    "research": {"facts": [{"fact": f"fact {i}", "source": "s"} for i in range(40)]},
                }
            ]
        }
        c = next(x for x in E.build_canon_chunks(o, []) if x["doc_type"] == E.RESEARCH_DOC_TYPE)
        assert c["content"].count("FACT:") == E._MAX_RESEARCH_FACTS


class TestStaleness:
    @staticmethod
    def _iso(dt):
        return dt.isoformat()

    def test_an_outline_newer_than_its_canon_is_stale(self) -> None:
        now = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
        pu = E._parse_ts(self._iso(now))
        ci = E._parse_ts(self._iso(now - timedelta(hours=3)))
        assert pu is not None and ci is not None
        assert pu > ci + timedelta(seconds=E.CANON_STALE_GRACE_S)

    def test_a_reindex_finishing_just_after_the_write_is_not_stale(self) -> None:
        """The grace window exists because the indexer takes time: an outline write at T and a
        reindex completing at T+30s must not read as stale forever."""
        now = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
        pu = E._parse_ts(self._iso(now))
        ci = E._parse_ts(self._iso(now - timedelta(seconds=30)))
        assert pu is not None and ci is not None
        assert not (pu > ci + timedelta(seconds=E.CANON_STALE_GRACE_S))

    def test_unreadable_timestamps_do_not_crash(self) -> None:
        assert E._parse_ts("not a date") is None
        assert E._parse_ts("") is None
        assert E._parse_ts(None) is None

    def test_a_naive_timestamp_is_treated_as_utc(self) -> None:
        got = E._parse_ts("2026-10-18T12:00:00")
        assert got is not None and got.tzinfo is not None


class TestNewestInput:
    """The probe must read the canon's actual INPUTS, because `writing_projects_v2.updated_at` does
    not move. On The Ossuary it still equalled `created_at` (2026-10-17T20:00:47) after eight outline
    versions, the newest at 2026-10-18T12:07 — so a probe trusting that column called the project
    fresh while the index was missing all 96 research chunks and 76 of 77 bible entries."""

    PID = "a1bfb2cf-2949-4d29-80d2-e8b785c6bdae"

    def _db(self, fake, *, project_updated, versions=(), bible=()):
        fake.tables["writing_projects_v2"] = [{"id": self.PID, "updated_at": project_updated}]
        fake.tables["outline_versions_v2"] = [{"project_id": self.PID, "created_at": ts} for ts in versions]
        fake.tables["story_bible_v2"] = [
            {"project_id": self.PID, "updated_at": ts, "created_at": ts, "deleted_at": None} for ts in bible
        ]
        return fake

    def test_the_ossuary_numbers_an_untouched_updated_at_loses_to_the_outline_version(
        self, fake_supabase
    ) -> None:
        db = self._db(
            fake_supabase,
            project_updated="2026-10-17T20:00:47.156739+00:00",
            versions=["2026-10-17T20:54:07+00:00", "2026-10-18T12:07:19.269115+00:00"],
        )
        ts, which = asyncio.run(E._newest_input_ts(db, project_id=self.PID))
        assert which == "outline_versions_v2"
        assert ts is not None and ts.isoformat().startswith("2026-10-18T12:07")

    def test_a_bible_written_after_the_last_outline_write_counts(self, fake_supabase) -> None:
        """Bible entries are the other half of the canon and arrive without an outline write."""
        db = self._db(
            fake_supabase,
            project_updated="2026-10-17T20:00:47+00:00",
            versions=["2026-10-17T20:54:07+00:00"],
            bible=["2026-10-18T12:06:34.458486+00:00"],
        )
        ts, which = asyncio.run(E._newest_input_ts(db, project_id=self.PID))
        assert which == "story_bible_v2"
        assert ts is not None and ts.isoformat().startswith("2026-10-18T12:06")

    def test_project_updated_at_still_wins_when_it_is_the_newest(self, fake_supabase) -> None:
        db = self._db(
            fake_supabase,
            project_updated="2026-10-18T18:00:00+00:00",
            versions=["2026-10-18T12:07:19+00:00"],
        )
        _ts, which = asyncio.run(E._newest_input_ts(db, project_id=self.PID))
        assert which == "project.updated_at"

    def test_a_missing_project_is_reported_not_raised(self, fake_supabase) -> None:
        fake_supabase.tables["writing_projects_v2"] = []
        ts, which = asyncio.run(E._newest_input_ts(fake_supabase, project_id=self.PID))
        assert ts is None and which == "project not found"


class TestOutlineWritesSayTheyHappened:
    def test_persist_outline_bumps_updated_at(self, fake_supabase) -> None:
        from writer_engine.persist_helpers import persist_outline

        fake_supabase.tables["writing_projects_v2"] = [
            {"id": "p1", "outline": {"chapters": []}, "updated_at": "2026-01-01T00:00:00+00:00"}
        ]
        asyncio.run(
            persist_outline(
                fake_supabase,
                project_id="p1",
                user_id="u1",
                outline={"chapters": [{"chapter_number": 1, "title": "t", "beat": "b"}]},
            )
        )
        row = fake_supabase.tables["writing_projects_v2"][0]
        assert row["updated_at"] != "2026-01-01T00:00:00+00:00"
        assert E._parse_ts(row["updated_at"]) is not None

    def test_every_outline_write_in_the_engine_touches_updated_at(self) -> None:
        """A write that changes the canon and leaves `updated_at` alone is invisible to the
        freshness probe's cheapest signal."""
        import pathlib
        import re

        root = pathlib.Path(__file__).resolve().parents[1]
        offenders = []
        for path in list((root / "services").rglob("main.py")) + list((root / "packages").rglob("*.py")):
            if "/tests/" in str(path):
                continue
            for m in re.finditer(r"\.update\(\{[^}]*\"outline\"[^}]*\}\)", path.read_text()):
                if "touch()" not in m.group(0) and "updated_at" not in m.group(0):
                    offenders.append(f"{path.relative_to(root)}: {m.group(0)[:70]}")
        assert not offenders, offenders


class TestProseIsNotCollateral:
    def test_the_canon_reindex_excludes_prose_from_its_delete(self) -> None:
        """Source-level check: both the delete and the coverage count must filter out the prose doc
        type, because the two indexes have different owners and lifecycles."""
        import inspect

        src = inspect.getsource(E.index_project_canon)
        # the delete and the existing-count both narrow away prose
        assert src.count("PROSE_DOC_TYPE") >= 2, "delete and/or coverage count still includes prose"
        assert ".neq(" in src

    def test_the_burial_mound_ratio_would_have_been_refused(self) -> None:
        """The measured numbers: 2,996 vectors, 1,879 of them prose. Counting prose in `existing`
        made a legitimate canon reindex look like a 63% coverage drop."""
        total, prose = 2996, 1879
        canon = total - prose
        assert canon / total < E.MIN_REINDEX_COVERAGE  # the bug
        assert canon / canon >= E.MIN_REINDEX_COVERAGE  # the fix: compare canon to canon


class TestCountsAreNotPageLengths:
    """PostgREST caps a response at 1,000 rows, so `len(rows)` is not a count. The Burial Mound's
    1,117 canon rows read as exactly 1,000 — which makes the coverage guard compare a fresh chunk
    count against a number that plateaued."""

    def test_count_prefers_the_servers_total_over_the_page(self) -> None:
        # the capped page, plus the total the server actually counted
        resp = SimpleNamespace(data=[{"id": n} for n in range(1000)], count=1117)
        assert asyncio.run(E._count(_Query(resp))) == 1117

    def test_count_falls_back_to_the_page_when_none_was_requested(self) -> None:
        resp = SimpleNamespace(data=[{"id": 1}, {"id": 2}], count=None)
        assert asyncio.run(E._count(_Query(resp))) == 2

    def test_both_row_counts_ask_the_server_to_count(self) -> None:
        import inspect

        for fn in (E.index_project_canon, E.canon_staleness):
            src = inspect.getsource(fn)
            assert "count=_EXACT" in src, f"{fn.__name__} still counts by page length"


class TestTheWriterUsesTheStoredStudy:
    """Making the facts retrievable is not the same as making them reach the chapter. A vector
    search over 96 research chunks is not guaranteed to return THIS chapter's facts — on The Ossuary
    the query "palisade post molds" returned chapters 26, 31, 47 and 61. The stored study is
    addressed by chapter number instead."""

    @staticmethod
    def _stored():
        from chapter_step.main import _stored_research

        return _stored_research

    def test_the_chapters_own_facts_and_sources_are_handed_over(self) -> None:
        text, topics, n = self._stored()(_outline_with_research(), 39)
        assert "innermost palisade" in text
        assert "Ferguson & Stewart 1940" in text
        assert "SOURCES:" in text
        assert topics, "no topic labels, so QA cannot report what was grounded"
        assert n == 2

    def test_cautions_survive_into_the_prompt(self) -> None:
        text, _topics, _n = self._stored()(_outline_with_research(), 39)
        assert "**Caution**" in text
        assert "17th-century tribute" in text

    def test_a_chapter_without_a_study_hands_over_nothing(self) -> None:
        assert self._stored()(_outline_with_research(), 40) == ("", [], 0)

    def test_a_one_fact_study_is_still_handed_over(self) -> None:
        """Measured on The Ossuary: **52 of 96** chapters carry exactly one fact. Discarding it to
        make a Perplexity call would lose the only cited material those chapters have — the caller
        tops it up instead, which is what the returned count is for."""
        from chapter_step.main import _MIN_STORED_FACTS

        o = {"chapters": [{"chapter_number": 1, "research": {"facts": [{"fact": "one", "source": "s"}]}}]}
        text, _topics, n = self._stored()(o, 1)
        assert "one" in text
        assert n == 1
        assert n < _MIN_STORED_FACTS  # so the caller tops it up

    def test_malformed_research_does_not_raise(self) -> None:
        for bad in (None, "text", [], {"facts": "not a list"}, {"facts": [None, 3]}, {"facts": []}):
            o = {"chapters": [{"chapter_number": 1, "research": bad}]}
            assert self._stored()(o, 1) == ("", [], 0), bad

    def test_a_thin_study_is_topped_up_not_replaced(self) -> None:
        """Source-level: the write path must keep the stored block when it also runs the live pass,
        and label the two so the model can tell cited material from a live search."""
        import inspect

        from chapter_step import main as M

        src = inspect.getsource(M)
        i_stored = src.index("stored, stored_topics, n_facts = _stored_research(")
        i_live = src.index("live, live_topics = await _chapter_research(")
        assert i_stored < i_live, "the live research pass still runs first"
        assert "FROM THIS PROJECT'S CHAPTER-BY-CHAPTER STUDY (cited):" in src
        assert "ADDITIONAL PERIOD RESEARCH:" in src

    def test_a_sufficient_study_skips_the_live_pass(self) -> None:
        import inspect

        from chapter_step import main as M

        src = inspect.getsource(M)
        assert "if stored and n_facts >= _MIN_STORED_FACTS:" in src


class TestTheStoredBlockDoesNotRepeatItself:
    """Seen in a live chapter write: with no explicit `topic`, the formatter synthesised one from the
    fact's first sentence and then printed the whole fact after it —

        - **Clovis and post-Clovis point production ran a staged sequence: select **: Clovis and
          post-Clovis point production ran a staged sequence: select blank, percussion-thin...

    paying input tokens to say everything twice, in the block that goes into every sub-chapter's
    cached prompt."""

    def test_a_fact_with_no_topic_appears_once(self) -> None:
        from chapter_step.main import _stored_research

        fact = "Clovis point production ran a staged sequence: select blank, percussion-thin, then flute."
        o = {
            "chapters": [
                {
                    "chapter_number": 1,
                    "research": {
                        "facts": [
                            {"fact": fact, "source": "Bradley 2010"},
                            {"fact": "Chert was heat-treated before flaking.", "source": "SF 1963"},
                        ]
                    },
                }
            ]
        }
        text, _topics, n = _stored_research(o, 1)
        assert n == 2
        assert text.count("staged sequence") == 1, text
        assert "Bradley 2010" in text

    def test_an_explicit_topic_is_still_used_as_the_lead(self) -> None:
        from chapter_step.main import _stored_research

        o = {
            "chapters": [
                {
                    "chapter_number": 1,
                    "research": {
                        "facts": [
                            {
                                "topic": "Point production",
                                "fact": "Staged: blank, thin, flute.",
                                "source": "B",
                            },
                            {"fact": "Chert was heat-treated.", "source": "S"},
                        ]
                    },
                }
            ]
        }
        text, _topics, _n = _stored_research(o, 1)
        assert "- **Point production**: Staged" in text
        assert text.count("Staged: blank") == 1
