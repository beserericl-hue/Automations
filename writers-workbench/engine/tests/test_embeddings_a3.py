"""A3 — the embeddings path targets tables and functions that actually exist.

The inventory recorded A3 as "code exists, flag off": enable ENABLE_PYTHON_EMBEDDINGS and go. That
was wrong. Probed against DEV Supabase on 2026-10-16:

* `writing_documents` — the table this module read and wrote — **does not exist** in either project.
  The real table is `writing_embeddings_v2` (384 rows on DEV, populated by n8n
  `Sub - Embed Project Data`).
* No vector-match function exists under `match_writing_documents` or any related name, even when
  probed with the exact parameter names the code sent. n8n did its search through the Supabase
  Vector Store node's own SQL, so no stored function was ever created.

So turning the flag on would have 404'd on every call. These tests pin the corrections; the missing
function ships as migration 027.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from writer_engine.config import EngineSettings, get_settings
from writer_engine.embeddings import embed as embed_mod


def test_module_targets_the_table_that_exists() -> None:
    assert embed_mod.EMBEDDINGS_TABLE == "writing_embeddings_v2"


def test_no_reference_to_the_nonexistent_table_remains() -> None:
    src = Path(embed_mod.__file__).read_text()
    # Allowed in prose explaining the bug; must not appear in a table() call.
    assert 'table("writing_documents")' not in src
    assert '.eq("project_title"' not in src, "the real scoping column is project_id"


def test_match_rpc_default_matches_the_migration() -> None:
    """A default naming a function that does not exist is how A3 stayed silently broken."""
    default = EngineSettings.model_fields["embedding_match_rpc"].default
    assert default == "match_writing_embeddings_v2"
    migration = Path(__file__).resolve().parents[2] / "migrations/027_engine_embedding_match.sql"
    assert migration.exists(), "the match function must ship as a reviewed migration"
    assert default in migration.read_text()


def test_migration_is_additive_only() -> None:
    """Governance: migrations >= 008 may add functions but must not touch a base table."""
    sql = (Path(__file__).resolve().parents[2] / "migrations/027_engine_embedding_match.sql").read_text()
    upper = sql.upper()
    assert "CREATE OR REPLACE FUNCTION" in upper
    for base in ("USERS_V2", "WRITING_PROJECTS_V2", "PUBLISHED_CONTENT_V2", "STORY_BIBLE_V2"):
        assert f"ALTER TABLE {base}" not in upper
        assert f"DROP TABLE {base}" not in upper


def test_re_embed_project_takes_project_id_not_title() -> None:
    import inspect

    params = inspect.signature(embed_mod.re_embed_project).parameters
    assert "project_id" in params
    assert "project_title" not in params


def test_match_takes_project_id_not_title() -> None:
    import inspect

    params = inspect.signature(embed_mod.match_project_canon).parameters
    assert "project_id" in params
    assert "project_title" not in params


# --- graceful degradation ---------------------------------------------------------------------


async def test_disabled_flag_makes_both_entry_points_noop() -> None:
    """The flag is still OFF by default, so neither path may touch the network."""
    assert embed_mod.embeddings_enabled() is False
    assert await embed_mod.match_project_canon(query="q", user_id="+1") == []
    assert await embed_mod.re_embed_project(user_id="+1", project_id="p") == 0


async def test_missing_rpc_degrades_instead_of_failing_a_chapter_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Until migration 027 is applied the RPC 404s. Retrieval must return [] — a chapter write that
    cannot ground itself should still produce a chapter, not error."""
    monkeypatch.setenv("ENABLE_PYTHON_EMBEDDINGS", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    get_settings.cache_clear()

    async def _fake_embed(texts: list[str]) -> list[list[float]]:
        return [[0.0] * 8 for _ in texts]

    class _Boom:
        def rpc(self, *_a: object, **_k: object) -> _Boom:
            return self

        async def execute(self) -> object:
            raise RuntimeError("PGRST202 function not found")

    async def _client() -> _Boom:
        return _Boom()

    monkeypatch.setattr(embed_mod, "embed_texts", _fake_embed)
    import writer_engine.supabase.client as sb

    monkeypatch.setattr(sb, "get_supabase_admin", _client)
    try:
        assert await embed_mod.match_project_canon(query="q", user_id="+1") == []
    finally:
        get_settings.cache_clear()


# --- the producer: build_canon_chunks (A3b) ----------------------------------------------------
#
# Nothing wrote writing_embeddings_v2 — re_embed_project only refreshed vectors on rows that already
# existed. So retrieval had nothing to find for any project n8n had not already indexed, and once
# n8n is switched off (E1) no new project would get canon at all.


def _outline() -> dict:
    return {
        "premise": "A drowned city remembers its dead.",
        "story_arc_name": "Fichtean Curve",
        "story_arc_prompt": "Rising crises, late climax.",
        "dramatic_question": "Will the archive survive?",
        "characters": [
            {"name": "Nora", "role": "Protagonist", "description": "A quilter who keeps records."},
            {"name": "Tayak", "role": "", "description": "An archaeologist."},
            {"name": "", "description": "nameless, must be skipped"},
        ],
        "chapters": [
            {"number": 0, "title": "The Permit", "summary": "Bureaucracy bites."},
            {"number": 1, "title": "The River", "beat": "A flood exposes the mound."},
            {"number": 2, "title": "Empty"},  # no body -> skipped
        ],
    }


def _bible() -> list[dict]:
    return [
        {
            "id": "row-1",
            "entry_type": "world_rule",
            "name": "Burial Practices",
            "description": "Ossuary reuse.",
        },
        {"id": "row-2", "entry_type": "character", "name": "Blackwood", "description": "A creator."},
        {"id": "row-3", "entry_type": "place", "name": "", "description": "nameless, skipped"},
    ]


def test_chunks_cover_every_canon_source() -> None:
    chunks = embed_mod.build_canon_chunks(_outline(), _bible())
    by_type: dict[str, int] = {}
    for c in chunks:
        by_type[c["doc_type"]] = by_type.get(c["doc_type"], 0) + 1
    assert by_type["premise"] == 1
    assert by_type["book_arc"] == 1
    assert by_type["character"] == 2, "the nameless character must be skipped"
    assert by_type["chapter_brief"] == 2, "the body-less chapter must be skipped"
    assert by_type["bible_entry"] == 2, "the nameless bible row must be skipped"


def test_chunk_ids_and_titles_match_the_n8n_conventions() -> None:
    """Engine-indexed and n8n-indexed projects must stay queryable by the same retrieval."""
    chunks = {(c["doc_type"], c["doc_id"]): c for c in embed_mod.build_canon_chunks(_outline(), _bible())}
    assert chunks[("premise", "premise")]["doc_title"] == "Book Premise"
    assert chunks[("book_arc", "book_arc")]["doc_title"] == "Book Story Arc: Fichtean Curve"
    assert chunks[("chapter_brief", "ch_1")]["doc_title"] == "Ch 1 — The River"
    assert chunks[("character", "Nora")]["doc_title"] == "Nora (Protagonist)"
    assert chunks[("character", "Tayak")]["doc_title"] == "Tayak", "no empty parens for a roleless character"
    assert chunks[("bible_entry", "row-1")]["doc_title"] == "[world_rule] Burial Practices"


def test_no_empty_content_chunks() -> None:
    """An empty chunk would embed whitespace and pollute retrieval with a meaningless vector."""
    for c in embed_mod.build_canon_chunks(_outline(), _bible()):
        assert c["content"].strip()


def test_chunking_is_pure_and_tolerates_garbage() -> None:
    assert embed_mod.build_canon_chunks({}, []) == []
    assert embed_mod.build_canon_chunks({"characters": ["not a dict"], "chapters": [None]}, []) == []


async def test_index_noops_when_disabled() -> None:
    assert await embed_mod.index_project_canon(user_id="+1", project_id="p") == 0


async def test_index_embeds_before_deleting(monkeypatch: pytest.MonkeyPatch) -> None:
    """A provider failure must leave existing canon intact rather than wiping the project."""
    monkeypatch.setenv("ENABLE_PYTHON_EMBEDDINGS", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    get_settings.cache_clear()
    calls: list[str] = []

    class _Q:
        def __init__(self, table: str) -> None:
            self._t = table

        def select(self, *_a: object, **_k: object) -> _Q:
            return self

        def eq(self, *_a: object, **_k: object) -> _Q:
            return self

        def is_(self, *_a: object, **_k: object) -> _Q:
            return self

        def neq(self, *_a: object, **_k: object) -> _Q:
            # The canon reindex narrows away chapter_prose on both the coverage count and the
            # delete, so the two indexes cannot clear each other's rows.
            return self

        def limit(self, *_a: object) -> _Q:
            return self

        def order(self, *_a: object, **_k: object) -> _Q:
            return self

        def delete(self) -> _Q:
            calls.append(f"delete:{self._t}")
            return self

        def insert(self, *_a: object) -> _Q:
            calls.append(f"insert:{self._t}")
            return self

        async def execute(self) -> object:
            class R:
                data = [{"outline": _outline()}] if self._t == "writing_projects_v2" else _bible()

            return R()

    class _Client:
        def table(self, name: str) -> _Q:
            return _Q(name)

    async def _client() -> _Client:
        return _Client()

    async def _boom(texts: list[str]) -> list[list[float]]:
        calls.append("embed")
        raise RuntimeError("openai down")

    import writer_engine.supabase.client as sb

    monkeypatch.setattr(sb, "get_supabase_admin", _client)
    monkeypatch.setattr(embed_mod, "embed_texts", _boom)
    try:
        with pytest.raises(RuntimeError):
            await embed_mod.index_project_canon(user_id="+1", project_id="p")
        assert "embed" in calls
        assert not any(c.startswith("delete:") for c in calls), "deleted canon despite a failed embed"
    finally:
        get_settings.cache_clear()


# --- sub_chapter coverage + the reindex guard --------------------------------------------------


def test_sub_chapters_are_chunked() -> None:
    """sub_chapter is the LARGEST doc_type n8n produced (126 of 169 rows on one DEV project).

    The first version of build_canon_chunks omitted it, which would have made the delete-then-insert
    reindex destroy ~75% of a project's canon.
    """
    outline = {
        "premise": "p",
        "chapters": [
            {
                "number": 14,
                "title": "The Override",
                "summary": "s",
                "chapter_outline": {
                    "sub_chapters": [
                        {
                            "number": 1,
                            "title": "The Override",
                            "brief": "Cogwheel is paralysed by a control key.",
                            "arc_beat": "Step 1 - Comfort Zone",
                            "setting": "A London street",
                            "characters": ["Cogwheel", "Blackwood"],
                            "emotional_tone": "Horror",
                        },
                        {"number": 2, "title": "Carriage", "brief": "Taken away."},
                        {"number": None, "brief": "no number -> skipped"},
                    ]
                },
            }
        ],
    }
    chunks = {c["doc_id"]: c for c in embed_mod.build_canon_chunks(outline, [])}
    assert "ch14_sc1" in chunks, "sub_chapter chunks must be produced"
    assert "ch14_sc2" in chunks
    assert len([k for k in chunks if k.startswith("ch14_sc")]) == 2, "numberless sub must be skipped"

    first = chunks["ch14_sc1"]
    assert first["doc_type"] == "sub_chapter"
    # n8n's title convention, so engine- and n8n-indexed rows stay queryable together.
    assert first["doc_title"] == "Ch14 Sub1: The Override"
    for expected in ("Sub-chapter 1 of Chapter 14", "Brief:", "Arc beat:", "Setting:", "Characters:"):
        assert expected in first["content"], expected


def test_sub_chapter_content_omits_absent_fields() -> None:
    """A sparse sub-chapter must not embed dangling 'Setting:' labels with no value."""
    outline = {
        "chapters": [
            {
                "number": 1,
                "title": "T",
                "summary": "s",
                "chapter_outline": {"sub_chapters": [{"number": 1, "title": "A", "brief": "b"}]},
            }
        ]
    }
    body = {c["doc_id"]: c for c in embed_mod.build_canon_chunks(outline, [])}["ch1_sc1"]["content"]
    assert "Setting:" not in body
    assert "Emotional tone:" not in body
    assert "Brief: b" in body


def test_reindex_coverage_guard_threshold_is_set() -> None:
    assert 0 < embed_mod.MIN_REINDEX_COVERAGE < 1


async def test_reindex_refuses_a_large_coverage_drop(monkeypatch: pytest.MonkeyPatch) -> None:
    """The guard that makes delete-then-insert safe: a chunker that stops producing a doc_type must
    not be able to wipe that canon silently."""
    monkeypatch.setenv("ENABLE_PYTHON_EMBEDDINGS", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    get_settings.cache_clear()
    deleted: list[str] = []

    class _Q:
        def __init__(self, t: str) -> None:
            self._t = t

        def select(self, *_a: object, **_k: object) -> _Q:
            return self

        def eq(self, *_a: object, **_k: object) -> _Q:
            return self

        def is_(self, *_a: object, **_k: object) -> _Q:
            return self

        def neq(self, *_a: object, **_k: object) -> _Q:
            # The canon reindex narrows away chapter_prose on both the coverage count and the
            # delete, so the two indexes cannot clear each other's rows.
            return self

        def limit(self, *_a: object) -> _Q:
            return self

        def order(self, *_a: object, **_k: object) -> _Q:
            return self

        def delete(self) -> _Q:
            deleted.append(self._t)
            return self

        def insert(self, *_a: object) -> _Q:
            return self

        async def execute(self) -> object:
            t = self._t

            class R:
                # One tiny outline -> 1 chunk, against 100 existing rows.
                data = (
                    [{"outline": {"premise": "only a premise"}}]
                    if t == "writing_projects_v2"
                    else ([{"id": f"r{i}"} for i in range(100)] if t == "writing_embeddings_v2" else [])
                )

            return R()

    class _Client:
        def table(self, name: str) -> _Q:
            return _Q(name)

    async def _client() -> _Client:
        return _Client()

    async def _embed(texts: list[str]) -> list[list[float]]:
        return [[0.0] * 4 for _ in texts]

    import writer_engine.supabase.client as sb

    monkeypatch.setattr(sb, "get_supabase_admin", _client)
    monkeypatch.setattr(embed_mod, "embed_texts", _embed)
    try:
        with pytest.raises(RuntimeError, match="refusing to reindex"):
            await embed_mod.index_project_canon(user_id="+1", project_id="p")
        assert "writing_embeddings_v2" not in deleted, "canon was deleted despite the guard"
    finally:
        get_settings.cache_clear()
