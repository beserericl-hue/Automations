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
