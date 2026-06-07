"""CR-005 — per-chapter telemetry persistence (chapter_qa_v2) + research closure.

Unit-level: exercise persist_chapter_qa against a fake Supabase client so the row mapping (drift,
QA, research/bible usage, stats) is locked without a live DB.
"""

from __future__ import annotations

import asyncio

from writer_engine.persist_helpers import persist_chapter_qa


class _FakeResp:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _FakeInsert:
    def __init__(self, table: _FakeTable, row: dict) -> None:
        self._table = table
        self._row = row

    async def execute(self) -> _FakeResp:
        self._table.inserted.append(self._row)
        return _FakeResp([{"id": "qa-row-1"}])


class _FakeTable:
    def __init__(self, name: str, sink: dict) -> None:
        self.name = name
        self.inserted: list[dict] = sink.setdefault(name, [])

    def insert(self, row: dict) -> _FakeInsert:
        return _FakeInsert(self, row)


class _FakeClient:
    def __init__(self) -> None:
        self.sink: dict = {}

    def table(self, name: str) -> _FakeTable:
        return _FakeTable(name, self.sink)


def test_persist_chapter_qa_writes_full_row() -> None:
    client = _FakeClient()
    telem = {
        "chapter_run_id": "11111111-1111-1111-1111-111111111111",
        "aligned": False,
        "drift_report": {"aligned": False, "story_drift": ["skips the hearing"], "character_drift": []},
        "craft_qa": {"prose_transparent": 0.8, "character_consistency": 0.9},
        "research_used": ["Cord-marked pottery", "Lake Superior copper"],
        "bible_entries_loaded": ["Tayak", "Nora"],
        "word_count": 4200,
        "sub_chapter_count": 5,
        "craft_passes": 1,
        "cache_read_tokens": 342000,
        "cache_write_tokens": 86000,
        "model": "claude-sonnet-4-6",
        "status": "ok",
    }
    row_id = asyncio.run(persist_chapter_qa(
        client, project_id="62cc734f-0000-0000-0000-000000000000", user_id="u1",
        chapter_number=9, telemetry=telem,
    ))
    assert row_id == "qa-row-1"
    rows = client.sink["chapter_qa_v2"]
    assert len(rows) == 1
    r = rows[0]
    assert r["project_id"].startswith("62cc734f") and r["chapter_number"] == 9 and r["user_id"] == "u1"
    assert r["aligned"] is False
    assert r["drift_report"]["story_drift"] == ["skips the hearing"]
    assert r["craft_qa"]["character_consistency"] == 0.9
    assert r["research_used"] == ["Cord-marked pottery", "Lake Superior copper"]
    assert r["bible_entries_loaded"] == ["Tayak", "Nora"]
    assert r["word_count"] == 4200 and r["cache_read_tokens"] == 342000
    assert r["model"] == "claude-sonnet-4-6" and r["status"] == "ok"


def test_persist_chapter_qa_defaults_status_ok() -> None:
    client = _FakeClient()
    asyncio.run(persist_chapter_qa(
        client, project_id="p", user_id="u", chapter_number=1, telemetry={"word_count": 10},
    ))
    assert client.sink["chapter_qa_v2"][0]["status"] == "ok"
    assert client.sink["chapter_qa_v2"][0]["drift_report"] is None


def test_persist_helpers_exposes_chapter_qa() -> None:
    from writer_engine import persist_helpers

    assert hasattr(persist_helpers, "persist_chapter_qa")


def test_bible_junk_filter_rejects_pollution() -> None:
    # the variants/fragments that polluted the bible to ~1000 rows and broke the writer's roster
    from writer_engine.persist_helpers import _is_junk_bible_name as j

    assert j("Tayak's grandmother", "character") is True
    assert j("Kimi's boyfriend", "character") is True
    assert j("The clerk", "character") is True
    assert j("commission chair", "character") is True  # generic lowercase role, no proper name
    assert j("", "character") is True
    # canonical cast + real concepts must pass
    assert j("Marcus Redcloud", "character") is False
    assert j("Nora Moyaone", "character") is False
    assert j("cord-marked pottery", "concept") is False


# --------------------------------------------------------------------------- CR-006 research link

def test_persist_research_links_to_project() -> None:
    from writer_engine.persist_helpers import persist_research

    client = _FakeClient()
    rid = asyncio.run(persist_research(
        client, project_id="62cc734f-c861-4210-bc12-e9ea002fcf66", user_id="u1",
        topic="The Burial Mound — Chapter 9 research", content="copper traded south",
    ))
    assert rid == "qa-row-1"
    # report written AND a project link row written
    assert client.sink["research_reports_v2"][0]["topic"].startswith("The Burial Mound")
    link = client.sink["research_report_projects_v2"][0]
    assert link["report_id"] == "qa-row-1"
    assert link["project_id"] == "62cc734f-c861-4210-bc12-e9ea002fcf66"
    assert link["user_id"] == "u1"


def test_persist_research_no_link_without_project() -> None:
    from writer_engine.persist_helpers import persist_research

    client = _FakeClient()
    asyncio.run(persist_research(
        client, project_id=None, user_id="u1", topic="general research", content="x",
    ))
    assert "research_reports_v2" in client.sink
    assert "research_report_projects_v2" not in client.sink  # no project -> no link
