"""Posts written from a piece of content record which piece (social_posts_v2.source_content_id).

The column existed and nothing filled it, so a post could not be traced back to the chapter or blog
post it was written from. The content page's Generate posts button passes the piece's id.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from media_step import main as M


class _Settings:
    supabase_url = "https://x.supabase.co"
    supabase_service_role_key = "k"


def _capture(monkeypatch: pytest.MonkeyPatch) -> list[list[dict[str, Any]]]:
    inserted: list[list[dict[str, Any]]] = []

    class _Q:
        def insert(self, rows: list[dict[str, Any]]) -> _Q:
            inserted.append(rows)
            return self

        async def execute(self) -> Any:
            return type("R", (), {"data": []})()

    class _C:
        def table(self, _t: str) -> _Q:
            return _Q()

    async def admin() -> _C:
        return _C()

    import writer_engine.supabase.client as sc

    monkeypatch.setattr(sc, "get_supabase_admin", admin)
    monkeypatch.setattr(M, "get_settings", lambda: _Settings())
    return inserted


def test_posts_from_a_piece_name_it(monkeypatch: pytest.MonkeyPatch) -> None:
    inserted = _capture(monkeypatch)
    out = asyncio.run(
        M._persist_social_posts(
            {"user_id": "u1", "project_id": "p1", "source_content_id": "c1"},
            {"twitter": "A post.", "linkedin": "A longer post.", "mastodon": "not stored"},
        )
    )
    assert out == {"persisted": True, "count": 2, "project_id": "p1"}
    assert {(r["platform"], r["source_content_id"]) for r in inserted[0]} == {
        ("twitter", "c1"),
        ("linkedin", "c1"),
    }


def test_posts_about_a_project_leave_it_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    inserted = _capture(monkeypatch)
    asyncio.run(M._persist_social_posts({"user_id": "u1", "project_id": "p1"}, {"twitter": "A post."}))
    assert "source_content_id" not in inserted[0][0]
