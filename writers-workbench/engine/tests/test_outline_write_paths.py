"""Item 7 — the engine's outline writes go through the schema.

The write paths: ``persist_outline`` (brainstorm), library ``revert`` (see test_versions_lifecycle),
and chapter_step's chapter-plan, QA-drift, volume-plan and marketing writes. These check the two
behaviours that matter on each: a legacy-shaped project is normalised on write, and an outline the
schema rejects writes nothing.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from writer_engine import persist_helpers as ph
from writer_engine.outline_schema import OutlineValidationError

N8N_SHAPED = {
    "title": "The Clockwork Rebellion",
    "premise": "p",
    "themes": [],
    "characters": [],
    "chapters": [
        {"number": 1, "title": "One", "brief": "b1", "research_topics": []},
        {"number": 2, "title": "Two", "brief": "b2", "research_topics": []},
    ],
}


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch, fake_supabase: Any) -> Any:
    import writer_engine.config as config
    import writer_engine.supabase.client as sc

    monkeypatch.setattr(
        config,
        "get_settings",
        lambda: SimpleNamespace(supabase_url="http://x", supabase_service_role_key="k"),
    )

    async def _admin() -> Any:
        return fake_supabase

    monkeypatch.setattr(sc, "get_supabase_admin", _admin)
    return fake_supabase


@pytest.mark.asyncio
async def test_persist_outline_rejects_an_unknown_shape_and_writes_nothing(fake_supabase: Any) -> None:
    fake_supabase.tables["writing_projects_v2"] = [
        {"id": "p1", "outline": {"chapters": [{"chapter_number": 1}]}}
    ]
    with pytest.raises(OutlineValidationError, match="chapters\\[0\\] has no chapter number"):
        await ph.persist_outline(
            fake_supabase, project_id="p1", user_id="u1", outline={"chapters": [{"title": "x"}]}
        )
    assert fake_supabase.count("outline_versions_v2") == 0  # not even the snapshot
    assert fake_supabase.tables["writing_projects_v2"][0]["outline"] == {"chapters": [{"chapter_number": 1}]}


@pytest.mark.asyncio
async def test_persist_outline_normalises_a_legacy_shape(fake_supabase: Any) -> None:
    fake_supabase.tables["writing_projects_v2"] = [{"id": "p1", "outline": None}]
    await ph.persist_outline(fake_supabase, project_id="p1", user_id="u1", outline=N8N_SHAPED)
    saved = fake_supabase.tables["writing_projects_v2"][0]["outline"]
    assert [c["chapter_number"] for c in saved["chapters"]] == [1, 2]
    assert saved["chapters"][0]["beat"] == "b1" and "brief" not in saved["chapters"][0]


@pytest.mark.asyncio
async def test_a_chapter_plan_persists_on_an_n8n_shaped_project(wired: Any) -> None:
    """Before item 7 the plan writer matched on str(chapter_number) only, so an n8n-shaped project
    (``number``) answered "chapter 2 not in outline" and the plan was lost."""
    from chapter_step import main as ch

    wired.tables["writing_projects_v2"] = [{"id": "p1", "user_id": "u1", "outline": dict(N8N_SHAPED)}]
    out = await ch._persist_chapter_outline("p1", 2, [{"number": 1, "brief": "s"}], "arc", "book arc")
    assert out == {"persisted": True, "chapter_number": 2}
    saved = wired.tables["writing_projects_v2"][0]["outline"]
    assert saved["chapters"][1]["chapter_number"] == 2
    assert saved["chapters"][1]["chapter_outline"]["sub_chapters"] == [{"number": 1, "brief": "s"}]
    assert "number" not in saved["chapters"][0]  # the whole outline was normalised on write
    # the snapshot keeps the outline exactly as it was, legacy keys and all — that is the undo path
    snap = wired.tables["outline_versions_v2"][0]["outline"]
    assert snap["chapters"][0]["number"] == 1


@pytest.mark.asyncio
async def test_a_chapter_plan_refuses_an_outline_the_schema_rejects(wired: Any) -> None:
    from chapter_step import main as ch

    bad = {"chapters": [{"chapter_number": 1}, {"chapter_number": 1}]}
    wired.tables["writing_projects_v2"] = [{"id": "p1", "user_id": "u1", "outline": bad}]
    out = await ch._persist_chapter_outline("p1", 1, [], "", "")
    assert out is not None and out["persisted"] is False
    assert "repeats chapter number 1" in out["reason"]
    assert wired.count("outline_versions_v2") == 0
