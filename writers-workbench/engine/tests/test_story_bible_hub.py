"""Chat/Eve story-bible writes: ``story_bible.add`` / ``story_bible.update`` through the hub.

Before this, the hub catalog routed only ``story_bible.list`` and the step had add + list, so "add
Mara Voss to the story bible" and "update Mara in the story bible" had nowhere to go. These tests pin:

* the router: add / update / rename / append phrasings → the right op and params, deterministically
  (a description full of other rules' trigger words must not start a research run);
* the step against a fake PostgREST: canonical vocabulary, variant resolution, soft-delete
  semantics, duplicate-safe renames, and project ownership.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
import story_bible_step.main as sb

from writer_engine.hub import build_dispatch_plan, route_message
from writer_engine.hub.catalog import lookup
from writer_engine.hub.schemas import HubDecision, HubRequest
from writer_engine.llm.router import LLMRouter
from writer_engine.persist_helpers import normalize_entry_type

USER = "+14105914612"
OTHER = "+19995550000"


def _route(message: str, **ctx: Any) -> HubDecision:
    req = HubRequest(message=message, user_id=USER, context=ctx)
    return asyncio.run(route_message(req, llm_router=LLMRouter()))


# --------------------------------------------------------------------------- router


@pytest.mark.parametrize(
    ("message", "op", "expect"),
    [
        (
            'Add a character named Mara Voss to the story bible for "The Last Signal": a salvage pilot '
            "with a prosthetic arm",
            "add",
            {
                "name": "Mara Voss",
                "entry_type": "character",
                "project_title": "The Last Signal",
                "description": "a salvage pilot with a prosthetic arm",
            },
        ),
        (
            "Add Ironhold to the story bible as a place: a fortress carved into the Ceres ice",
            "add",
            {
                "name": "Ironhold",
                "entry_type": "place",
                "description": "a fortress carved into the Ceres ice",
            },
        ),
        (
            "Update Mara Voss in the story bible: she is now captain of the Wren",
            "update",
            {"name": "Mara Voss", "description": "she is now captain of the Wren"},
        ),
        (
            'Update the character Mara Voss in the story bible for "The Last Signal": captain of the Wren',
            "update",
            {"name": "Mara Voss", "entry_type": "character", "project_title": "The Last Signal"},
        ),
        (
            "Rename Osei to Osei Asante in the story bible",
            "update",
            {"name": "Osei", "new_name": "Osei Asante"},
        ),
        (
            "Add to Mara Voss's description in the story bible: lost her arm at Ceres",
            "update",
            {"name": "Mara Voss", "mode": "append", "description": "lost her arm at Ceres"},
        ),
    ],
)
def test_bible_writes_route_deterministically(message: str, op: str, expect: dict[str, Any]) -> None:
    d = _route(message)
    assert (d.tool, d.op, d.kind) == ("story_bible", op, "info")
    for key, val in expect.items():
        assert d.params.get(key) == val, (key, d.params)


def test_description_trigger_words_do_not_hijack_the_route() -> None:
    """The description is free text: 'research' / 'write a newsletter' in it must not start those."""
    d = _route(
        "Add a character named Dr. Lena Ortiz to the story bible: she runs research on the "
        "signal and wants to write a newsletter about it"
    )
    assert (d.tool, d.op) == ("story_bible", "add")
    assert d.params["name"] == "Dr. Lena Ortiz"


def test_bible_read_still_reads_and_edit_words_do_not() -> None:
    assert (_route("Show me the story bible for The Seed Vault").op) == "list"
    # 'change' used to slip past the G3 write-guard and come back as a LIST of the bible.
    d = _route("Change Mara Voss in the story bible: older now")
    assert (d.tool, d.op) == ("story_bible", "update")


def test_catalog_has_the_write_ops_as_info() -> None:
    assert lookup("story_bible", "add").kind == "info"
    assert lookup("story_bible", "update").kind == "info"
    assert lookup(None, "update_bible_entry").name == "story_bible.update"


def test_bible_write_inherits_the_conversation_project_but_new_books_do_not() -> None:
    ctx = {"project_id": "p1", "project_title": "The Last Signal"}
    req = HubRequest(message="x", user_id=USER, context=ctx)
    add = build_dispatch_plan(
        HubDecision(kind="info", tool="story_bible", op="add", params={"name": "Mara"}), req
    )
    assert add.action == "call_sync" and add.body["project_id"] == "p1"
    # A brand-new book must never be handed the last book's id (it would revise that outline).
    new = build_dispatch_plan(
        HubDecision(kind="task", tool="brainstorm", op="story", params={"title": "Other"}), req
    )
    assert "project_id" not in new.body
    # A different title named in the message wins; the remembered id does not ride along with it.
    named = build_dispatch_plan(
        HubDecision(
            kind="info", tool="story_bible", op="add", params={"name": "M", "project_title": "Other"}
        ),
        req,
    )
    assert named.body["project_title"] == "Other" and "project_id" not in named.body


def test_entry_type_vocabulary() -> None:
    assert normalize_entry_type("Character") == "character"
    assert normalize_entry_type("location") == "place"
    assert normalize_entry_type("item") == "object"
    assert normalize_entry_type("faction") == "concept"
    assert normalize_entry_type("timeline") == "event"
    assert normalize_entry_type("vibe") is None


# --------------------------------------------------------------------------- step


@pytest.fixture
def db(fake_supabase: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    fake_supabase.tables["writing_projects_v2"] = [
        {"id": "p1", "title": "The Last Signal", "user_id": USER, "outline": {"x": 1}},
        {"id": "p2", "title": "Someone Else's Book", "user_id": OTHER, "outline": {"x": 1}},
    ]
    fake_supabase.tables["story_bible_v2"] = [
        {
            "id": "e1",
            "project_id": "p1",
            "user_id": USER,
            "entry_type": "character",
            "name": "Osei Asante",
            "description": "Harbour pilot on the Wren",
            "deleted_at": None,
        },
        {
            "id": "e2",
            "project_id": "p1",
            "user_id": USER,
            "entry_type": "place",
            "name": "Ironhold",
            "description": "A fortress",
            "deleted_at": None,
        },
        {
            "id": "e3",
            "project_id": "p1",
            "user_id": USER,
            "entry_type": "character",
            "name": "Kell Dray",
            "description": "Cut from the book",
            "deleted_at": "2026-10-01T00:00:00+00:00",
        },
    ]

    async def _client() -> Any:
        return fake_supabase

    monkeypatch.setattr(sb, "_supabase_or_none", _client)
    return fake_supabase


def _live(db: Any, name: str) -> list[dict[str, Any]]:
    return [r for r in db.tables["story_bible_v2"] if r["name"] == name and not r.get("deleted_at")]


@pytest.mark.asyncio
async def test_add_by_title_with_flat_params_and_synonym_type(db: Any) -> None:
    out = await sb._op_add(
        {
            "user_id": USER,
            "project_title": "The Last Signal",
            "name": "The Wren Dock",
            "entry_type": "location",
            "description": "Where the salvage tugs berth",
        }
    )
    assert out["saved"] is True and out["project_id"] == "p1"
    rows = _live(db, "The Wren Dock")
    assert len(rows) == 1 and rows[0]["entry_type"] == "place" and rows[0]["user_id"] == USER
    assert "Added The Wren Dock (place)" in out["message"]


@pytest.mark.asyncio
async def test_add_existing_without_description_does_not_blank_it(db: Any) -> None:
    out = await sb._op_add({"user_id": USER, "project_id": "p1", "name": "Ironhold", "entry_type": "place"})
    assert out["saved"] is False and "already in the story bible" in out["message"]
    assert _live(db, "Ironhold")[0]["description"] == "A fortress"


@pytest.mark.asyncio
async def test_add_first_name_lands_on_the_full_name(db: Any) -> None:
    out = await sb._op_add(
        {
            "user_id": USER,
            "project_id": "p1",
            "name": "Osei",
            "entry_type": "character",
            "description": "Harbour pilot on the Wren, born on Ceres",
        }
    )
    assert out["saved"] is True and out["entry"]["name"] == "Osei Asante"
    assert _live(db, "Osei") == [] and len(_live(db, "Osei Asante")) == 1


@pytest.mark.asyncio
async def test_add_refuses_a_type_outside_the_vocabulary(db: Any) -> None:
    out = await sb._op_add({"user_id": USER, "project_id": "p1", "name": "Rain", "entry_type": "vibe"})
    assert out["saved"] is False and out["reason"] == "entry_type"


@pytest.mark.asyncio
async def test_update_replaces_description_and_stamps_updated_at(db: Any) -> None:
    out = await sb._op_update(
        {
            "user_id": USER,
            "project_title": "The Last Signal",
            "name": "Ironhold",
            "description": "A ruined fortress",
        }
    )
    assert out["saved"] is True and out["changed"] == ["description"]
    row = _live(db, "Ironhold")[0]
    assert row["description"] == "A ruined fortress" and row["updated_at"]


@pytest.mark.asyncio
async def test_update_append_keeps_the_old_description(db: Any) -> None:
    await sb._op_update(
        {
            "user_id": USER,
            "project_id": "p1",
            "name": "ironhold",
            "description": "Fell in year 3",
            "mode": "append",
        }
    )
    assert _live(db, "Ironhold")[0]["description"] == "A fortress\n\nFell in year 3"


@pytest.mark.asyncio
async def test_update_finds_a_character_by_first_name(db: Any) -> None:
    out = await sb._op_update(
        {"user_id": USER, "project_id": "p1", "name": "Osei", "description": "Now captain"}
    )
    assert out["saved"] is True and out["entry"]["name"] == "Osei Asante"


@pytest.mark.asyncio
async def test_rename_and_refuse_a_duplicate_rename(db: Any) -> None:
    ok = await sb._op_update(
        {"user_id": USER, "project_id": "p1", "name": "Ironhold", "new_name": "Ironhold Keep"}
    )
    assert ok["saved"] is True and len(_live(db, "Ironhold Keep")) == 1 and _live(db, "Ironhold") == []
    db.tables["story_bible_v2"].append(
        {
            "id": "e4",
            "project_id": "p1",
            "user_id": USER,
            "entry_type": "place",
            "name": "Ceres Yard",
            "description": "",
            "deleted_at": None,
        }
    )
    clash = await sb._op_update(
        {"user_id": USER, "project_id": "p1", "name": "Ceres Yard", "new_name": "ironhold keep"}
    )
    assert clash["saved"] is False and clash["reason"] == "duplicate"
    assert len(_live(db, "Ceres Yard")) == 1


@pytest.mark.asyncio
async def test_update_leaves_a_soft_deleted_entry_alone(db: Any) -> None:
    out = await sb._op_update(
        {"user_id": USER, "project_id": "p1", "name": "Kell Dray", "description": "Back!"}
    )
    assert out["saved"] is False and out["reason"] == "deleted"
    trashed = next(r for r in db.tables["story_bible_v2"] if r["id"] == "e3")
    assert trashed["description"] == "Cut from the book" and trashed["deleted_at"]


@pytest.mark.asyncio
async def test_update_unknown_entry_says_how_to_add_it(db: Any) -> None:
    out = await sb._op_update({"user_id": USER, "project_id": "p1", "name": "Nobody", "description": "x"})
    assert out["reason"] == "not_found" and "add Nobody" in out["message"]


@pytest.mark.asyncio
async def test_writes_refuse_someone_elses_project_id(db: Any) -> None:
    before = len(db.tables["story_bible_v2"])
    out = await sb._op_add(
        {"user_id": USER, "project_id": "p2", "name": "Intruder Person", "entry_type": "character"}
    )
    assert out["saved"] is False and out["reason"] == "project"
    assert len(db.tables["story_bible_v2"]) == before


@pytest.mark.asyncio
async def test_list_filters_to_one_entry_by_name(db: Any) -> None:
    out = await sb._op_list({"user_id": USER, "project_id": "p1", "name": "osei asante"})
    assert [r["name"] for r in out["entries"]] == ["Osei Asante"]
