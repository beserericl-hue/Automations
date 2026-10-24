"""A project_id the router read out of a sentence is not trusted.

The project buttons send "write Chapter 1 of E2E Plan 1792860711965" through the chat router, and the
router put the title's number in project_id. The resolver only looked a title up when project_id was
empty, so the junk id went to validation and every such write failed. A non-UUID id is now dropped
and the title resolved instead.
"""

from __future__ import annotations

import asyncio

import pytest
from chapter_step import main as M


def test_is_uuid() -> None:
    assert M._is_uuid("dd10c1c3-e025-4cd7-854d-21db32a2e4da")
    for bad in ("1792860711965", "1984", "", "E2E Plan"):
        assert not M._is_uuid(bad)


def test_a_non_uuid_project_id_falls_back_to_the_title(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, str] = {}

    async def fake_resolve(_client: object, *, user_id: str, title: str, genre_slug: str, create: bool):
        seen["title"] = title
        return "dd10c1c3-e025-4cd7-854d-21db32a2e4da", {"id": "row"}

    async def fake_admin() -> object:
        return object()

    class S:
        supabase_url = "https://x.supabase.co"
        supabase_service_role_key = "k"

    import writer_engine.config as cfg
    import writer_engine.persist_helpers as ph
    import writer_engine.supabase.client as sc

    monkeypatch.setattr(cfg, "get_settings", lambda: S())
    monkeypatch.setattr(ph, "resolve_or_create_project", fake_resolve)
    monkeypatch.setattr(sc, "get_supabase_admin", fake_admin)

    payload = {"project_id": "1792860711965", "project_title": "E2E Plan 1792860711965", "user_id": "u"}
    asyncio.run(M._resolve_project_for_payload(payload, create=False))
    assert payload["project_id"] == "dd10c1c3-e025-4cd7-854d-21db32a2e4da"
    assert seen["title"] == "E2E Plan 1792860711965"


def test_a_real_project_id_is_kept_without_a_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    pid = "dd10c1c3-e025-4cd7-854d-21db32a2e4da"
    payload = {"project_id": pid, "project_title": "The Last Signal"}
    assert asyncio.run(M._resolve_project_for_payload(payload, create=False)) is None
    assert payload["project_id"] == pid
