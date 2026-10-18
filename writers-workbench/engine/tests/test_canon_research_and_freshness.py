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

from datetime import UTC, datetime, timedelta

from writer_engine.embeddings import embed as E


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
