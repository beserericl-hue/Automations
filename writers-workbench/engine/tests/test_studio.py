"""Content Studio (migration 050): ownership, the command grammar, drafting into review, state changes,
scheduling, the issue selection the newsletter saga uses, and the assistant's routing.

Everything runs over the in-memory FakeSupabase and a fake LLM router: no network, no spend.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any
from uuid import uuid4

import pytest
from conftest import FakeSupabase

from writer_engine.hub import build_dispatch_plan, route_message
from writer_engine.hub.catalog import render_catalog_prompt
from writer_engine.hub.schemas import HubDecision, HubRequest
from writer_engine.schemas import StepInput, StepStatus
from writer_engine.studio import commands, core, drafting, issue
from writer_engine.studio.core import StudioError

OWNER = "+14105914612"
OTHER = "+15550000001"


def _db() -> FakeSupabase:
    db = FakeSupabase()
    db.tables["newsletter_editions_v2"] = [
        {"id": "ai-dev-roundup", "user_id": OWNER, "display_name": "AI Dev Roundup", "enabled": True},
        {"id": "ai-mvp", "user_id": OWNER, "display_name": "The MVP Brief", "enabled": True},
        {"id": "e2e-studio", "user_id": OWNER, "display_name": "E2E", "enabled": True},
        {"id": "wasteland-wire", "user_id": OWNER, "display_name": "Wire", "enabled": True},
        {"id": "theirs", "user_id": OTHER, "display_name": "Theirs", "enabled": True},
    ]
    db.tables["radar_subscriptions_v2"] = [
        {
            "user_id": OWNER,
            "radar": "dev",
            "enabled": True,
            "settings": {"edition_id": "ai-dev-roundup", "channels": ["li_techahir", "li_agile"]},
        },
        {
            "user_id": OWNER,
            "radar": "trend",
            "enabled": True,
            "settings": {"edition_id": "ai-mvp", "channels": ["website", "li_techahir"]},
        },
    ]
    db.tables["newsletter_feed_sources_v2"] = [
        {
            "user_id": OWNER,
            "edition_id": "e2e-studio",
            "url": "radar://dev",
            "url_type": "radar",
            "active": True,
        },
        # Another user's edition pointing at a radar: they have no subscription, so it is not a studio edition.
        {"user_id": OTHER, "edition_id": "theirs", "url": "radar://dev", "url_type": "radar", "active": True},
    ]
    db.tables["social_channels_v2"] = [
        {"user_id": OWNER, "channel": c, "enabled": True}
        for c in ("website", "li_techahir", "li_agile", "li_personal")
    ]
    week = "2026-11-02"
    db.tables["radar_topics_v2"] = [
        {
            "id": f"t{r}",
            "user_id": OWNER,
            "radar": "dev",
            "week_of": week,
            "rank": r,
            "title": f"Dev topic {r}",
            "url": f"https://example.com/{r}",
            "source": "HN",
            "item_type": "video" if r % 3 == 0 else "article",
            "angle": f"angle {r}",
            "summary": f"summary {r}",
        }
        for r in range(1, 9)
    ] + [
        {
            "id": f"x{r}",
            "user_id": OWNER,
            "radar": "trend",
            "week_of": week,
            "rank": r,
            "title": f"Trend topic {r}",
            "url": f"https://news.example/{r}",
            "source": "TC",
            "item_type": "article",
            "angle": "",
            "summary": "s",
        }
        for r in range(1, 4)
    ]
    db.tables["social_schedule_v2"] = []
    return db


class _Resp:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeRouter:
    """Answers the radar / revise prompts; records the calls."""

    def __init__(self, text: str | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.text = text

    async def complete(self, **kw: Any) -> _Resp:
        self.calls.append(kw)
        if self.text is not None:
            return _Resp(self.text)
        return _Resp(
            "SEO_TITLE: Seo\nTITLE: A title\nMETA: meta\nCATEGORY: ai & data\n===BLOG===\n## Body\n\ntext\n"
            "===LINKEDIN===\nLinkedIn text\n===END==="
        )


@pytest.fixture(autouse=True)
def _numbering(monkeypatch: pytest.MonkeyPatch) -> None:
    """The DB trigger numbers posts; the fake does it here."""
    from conftest import FakeQuery

    real = FakeQuery.execute

    async def execute(self: Any) -> Any:
        if self.table_name == "social_schedule_v2" and self._op == "insert":
            rows = self.db.tables.setdefault("social_schedule_v2", [])
            items = self._payload if isinstance(self._payload, list) else [self._payload]
            for it in items:
                it.setdefault(
                    "display_number", max([int(r.get("display_number") or 0) for r in rows] + [0]) + 1
                )
                it.setdefault("id", f"p{it['display_number']}")
        return await real(self)

    monkeypatch.setattr(FakeQuery, "execute", execute)


# ----------------------------------------------------------------------------- ownership


@pytest.mark.asyncio
async def test_only_the_owners_radar_editions_are_studio_editions() -> None:
    db = _db()
    eds = {e.edition_id: e for e in await core.studio_editions(db, OWNER)}
    assert set(eds) == {"ai-dev-roundup", "ai-mvp", "e2e-studio"}  # not wasteland-wire (no radar)
    assert eds["e2e-studio"].radar == "dev" and eds["ai-mvp"].radar == "trend"
    assert eds["ai-dev-roundup"].channels == ("li_techahir", "li_agile")
    assert await core.studio_editions(db, OTHER) == []  # a radar:// feed without a subscription is nothing
    for user, edition in (
        (OTHER, "ai-dev-roundup"),
        (OTHER, "theirs"),
        (OWNER, "theirs"),
        (OWNER, "wasteland-wire"),
    ):
        with pytest.raises(StudioError) as err:
            await core.resolve_edition(db, user, edition)
        assert err.value.code == "NOT_FOUND"


@pytest.mark.asyncio
async def test_the_step_refuses_another_users_edition(monkeypatch: pytest.MonkeyPatch) -> None:
    from studio_step import main as step

    db = _db()

    async def client() -> FakeSupabase:
        return db

    monkeypatch.setattr(step, "_client", client)
    out = await step.handler(
        StepInput(
            execution_id=uuid4(),
            step_name="studio",
            payload={"op": "slate", "user_id": OTHER, "edition_id": "ai-dev-roundup"},
        )
    )
    assert out.status is StepStatus.ERROR and out.error is not None and out.error.code == "NOT_FOUND"
    ok = await step.handler(
        StepInput(
            execution_id=uuid4(),
            step_name="studio",
            payload={"op": "slate", "user_id": OWNER, "edition_id": "ai-dev-roundup"},
        )
    )
    assert ok.status is StepStatus.OK
    assert [t["rank"] for t in ok.payload["result"]["topics"]] == list(range(1, 9))
    assert "1. [ARTICLE] Dev topic 1" in ok.payload["result"]["message"]


# ----------------------------------------------------------------------------- commands


@pytest.mark.parametrize(
    ("message", "op", "params"),
    [
        ("generate 1-5, 8, 12-16", "generate", {"numbers": "1-5, 8, 12-16"}),
        ("generate 1-5 and 8", "generate", {"numbers": "1-5, 8"}),
        ("generate all", "generate", {"numbers": "all"}),
        ("revise #3 to be shorter", "revise", {"posts": "3", "instruction": "be shorter", "mode": "revise"}),
        ("tighten #4", "revise", {"posts": "4", "instruction": "tighten it", "mode": "revise"}),
        ("regenerate #3", "revise", {"posts": "3", "mode": "regenerate"}),
        ("undo #3", "revise", {"posts": "3", "mode": "undo"}),
        ("approve #3, #5", "update", {"action": "approve", "posts": "3, 5"}),
        ("approve all", "update", {"action": "approve", "posts": "all"}),
        ("cancel 4", "update", {"action": "cancel", "posts": "4"}),
        ("discard #7", "update", {"action": "discard", "posts": "7"}),
        ("no image on #2", "update", {"action": "image_off", "posts": "2"}),
        ("schedule all approved", "schedule", {"posts": "approved", "mode": "next"}),
        (
            "schedule #3 tuesday afternoon",
            "schedule",
            {"posts": "3", "mode": "slot", "day": "tuesday", "slot": "afternoon"},
        ),
        (
            "schedule #3 2026-11-10 at 11:30 am",
            "schedule",
            {"posts": "3", "mode": "at", "day": "2026-11-10", "time": "11:30 am"},
        ),
        ("publish #5 now", "schedule", {"posts": "5", "mode": "now"}),
        ("list the queue", "queue", {"status": "queue"}),
        ("show my drafts", "queue", {"status": "drafts"}),
        ("show the slate", "slate", {}),
        ("put 1-6 in this week's newsletter", "issue", {"action": "add", "ranks": "1-6", "posts": ""}),
        ("add #3 to the newsletter", "issue", {"action": "add", "ranks": "", "posts": "3"}),
        ("remove #3 from the newsletter", "issue", {"action": "remove", "ranks": "", "posts": "3"}),
        ("show the newsletter", "issue", {"action": "show"}),
        ("email #3", "email", {"posts": "3"}),
        ("email the roundup", "email", {"target": "digest"}),
    ],
)
def test_command_grammar(message: str, op: str, params: dict[str, Any]) -> None:
    parsed = commands.parse(message)
    assert parsed is not None, message
    got_op, got = parsed
    assert got_op == op
    for k, v in params.items():
        assert got.get(k) == v, (message, k, got)


def test_unknown_text_is_not_a_command() -> None:
    assert commands.parse("what do you think about the second one?") is None


# ----------------------------------------------------------------------------- drafting


@pytest.mark.asyncio
async def test_generate_makes_unscheduled_drafts_and_skips_topics_already_drafted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _db()
    ed = await core.resolve_edition(db, OWNER, "ai-mvp")
    _week, topics = await core.topics_by_rank(db, ed, "1-2")
    router = FakeRouter()
    out = await drafting.generate(db, ed, topics, router=router)
    assert len(router.calls) == 2 and not out["failed"]
    rows = db.tables["social_schedule_v2"]
    assert [r["state"] for r in rows] == ["draft", "draft"]
    assert all(r["scheduled_date"] is None and r["scheduled_at"] is None for r in rows)
    assert rows[0]["edition_id"] == "ai-mvp" and rows[0]["source"] == "studio"
    assert rows[0]["channels"] == ["website", "li_techahir"] and rows[0]["category"] == "AI & DATA"
    assert rows[0]["radar_topic_id"] == "x1" and rows[0]["studio"]["rank"] == 1
    again = await drafting.generate(db, ed, topics, router=router)
    assert again["drafted"] == [] and [s["rank"] for s in again["skipped"]] == [1, 2]


@pytest.mark.asyncio
async def test_a_failed_draft_is_listed_with_its_topic() -> None:
    db = _db()
    ed = await core.resolve_edition(db, OWNER, "ai-mvp")
    _w, topics = await core.topics_by_rank(db, ed, "3")
    out = await drafting.generate(db, ed, topics, router=FakeRouter(text="no format at all"))
    assert out["drafted"] == [] and out["failed"][0]["rank"] == 3
    assert db.tables["social_schedule_v2"] == []


@pytest.mark.asyncio
async def test_roundup_drafts_need_the_source_link(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _db()
    ed = await core.resolve_edition(db, OWNER, "ai-dev-roundup")
    _w, topics = await core.topics_by_rank(db, ed, "1-2")

    async def structured(router: Any, **kw: Any) -> Any:
        from writer_engine.radar.drafts import RoundupPosts

        return RoundupPosts(
            posts=[
                {"i": 0, "content": "Hook\n🔗 Read: https://example.com/1"},
                {"i": 1, "content": "no link"},
            ]
        ), None

    monkeypatch.setattr("writer_engine.radar.drafts.complete_structured", structured)
    out = await drafting.generate(db, ed, topics, router=FakeRouter())
    assert [d["rank"] for d in out["drafted"]] == [1]
    assert [f["rank"] for f in out["failed"]] == [2]
    assert db.tables["social_schedule_v2"][0]["include_image"] is False


@pytest.mark.asyncio
async def test_revise_keeps_the_previous_version_and_refuses_a_dropped_link() -> None:
    db = _db()
    ed = await core.resolve_edition(db, OWNER, "ai-dev-roundup")
    db.tables["social_schedule_v2"] = [
        {
            "id": "p1",
            "display_number": 1,
            "user_id": OWNER,
            "edition_id": "ai-dev-roundup",
            "state": "draft",
            "title": "T",
            "body_md": "",
            "linkedin_content": "Long post\n🔗 Read: https://example.com/1",
            "source_url": "https://example.com/1",
            "studio": {},
        }
    ]
    post = (await core.own_posts(db, ed, numbers=[1]))[0]
    with pytest.raises(StudioError):
        await drafting.revise(db, ed, post, "shorter", router=FakeRouter(text="Short, no link"))
    r = await drafting.revise(
        db, ed, post, "shorter", router=FakeRouter(text="Short\n🔗 Read: https://example.com/1")
    )
    row = db.tables["social_schedule_v2"][0]
    assert r["post"]["display_number"] == 1 and row["linkedin_content"].startswith("Short")
    assert row["studio"]["previous"]["linkedin_content"].startswith("Long post")
    assert row["studio"]["revisions"][-1]["what"] == "revise: shorter"
    post = (await core.own_posts(db, ed, numbers=[1]))[0]
    await drafting.restore_previous(db, ed, post)
    assert db.tables["social_schedule_v2"][0]["linkedin_content"].startswith("Long post")


# ----------------------------------------------------------------------------- states + scheduling


def _post(n: int, state: str, edition: str = "ai-dev-roundup", **kw: Any) -> dict[str, Any]:
    return {
        "id": f"p{n}",
        "display_number": n,
        "user_id": OWNER,
        "edition_id": edition,
        "state": state,
        "title": f"Post {n}",
        "channels": ["li_techahir"],
        "item_type": "article",
        "studio": {},
        **kw,
    }


@pytest.mark.asyncio
async def test_actions_move_only_posts_in_the_right_state() -> None:
    db = _db()
    ed = await core.resolve_edition(db, OWNER, "ai-dev-roundup")
    db.tables["social_schedule_v2"] = [
        _post(1, "draft"),
        _post(2, "posted"),
        _post(3, "draft"),
        _post(9, "draft", edition="ai-mvp"),
    ]
    out = await core.apply_action(db, ed, await core.own_posts(db, ed, numbers=[1, 2, 9]), "approve")
    assert [d["display_number"] for d in out["done"]] == [1]
    assert [s["display_number"] for s in out["skipped"]] == [2]  # #9 is another edition's: not even found
    assert db.tables["social_schedule_v2"][0]["state"] == "approved"
    await core.apply_action(db, ed, await core.own_posts(db, ed, numbers=[3]), "discard")
    assert [p["display_number"] for p in db.tables["social_schedule_v2"]] == [1, 2, 9]


@pytest.mark.asyncio
async def test_schedule_next_puts_dev_posts_on_weekdays_from_tomorrow() -> None:
    db = _db()
    ed = await core.resolve_edition(db, OWNER, "ai-dev-roundup")
    db.tables["social_schedule_v2"] = [_post(1, "approved"), _post(2, "approved"), _post(3, "posted")]
    now = datetime(2026, 11, 6, 15, 0, tzinfo=UTC)  # Friday
    posts = await core.own_posts(db, ed, numbers=[1, 2, 3])
    out = await core.schedule_posts(db, ed, posts, mode="next", now=now)
    assert [(d["scheduled_date"], d["slot"]) for d in out["scheduled"]] == [
        ("2026-11-09", "morning"),
        ("2026-11-09", "afternoon"),
    ]
    assert [s["display_number"] for s in out["skipped"]] == [3]
    assert db.tables["social_schedule_v2"][0]["state"] == "pending"


@pytest.mark.asyncio
async def test_schedule_now_and_at_set_an_exact_time_and_check_channels() -> None:
    db = _db()
    ed = await core.resolve_edition(db, OWNER, "ai-dev-roundup")
    db.tables["social_schedule_v2"] = [_post(1, "draft"), _post(2, "approved")]
    now = datetime(2026, 11, 3, 15, 0, tzinfo=UTC)
    await core.schedule_posts(db, ed, await core.own_posts(db, ed, numbers=[1]), mode="now", now=now)
    row = db.tables["social_schedule_v2"][0]
    assert (
        row["post_at"] == now.isoformat()
        and row["scheduled_date"] == "2026-11-03"
        and row["slot"] == "morning"
    )
    with pytest.raises(StudioError):
        await core.schedule_posts(
            db, ed, await core.own_posts(db, ed, numbers=[2]), mode="now", channels=["li_nope"], now=now
        )
    with pytest.raises(StudioError):
        await core.schedule_posts(
            db,
            ed,
            await core.own_posts(db, ed, numbers=[2]),
            mode="at",
            at=datetime(2026, 1, 1, tzinfo=UTC),
            now=now,
        )


def test_parse_day() -> None:
    now = datetime(2026, 11, 3, 15, 0, tzinfo=UTC)  # Tuesday
    assert core.parse_day("tomorrow", now) == date(2026, 11, 4)
    assert core.parse_day("tuesday", now) == date(2026, 11, 10)
    assert core.parse_day("friday", now) == date(2026, 11, 6)
    assert core.parse_day("2026-12-01", now) == date(2026, 12, 1)
    assert core.parse_day("nov 20", now) == date(2026, 11, 20)
    assert core.parse_day("someday", now) is None


# ----------------------------------------------------------------------------- the issue


@pytest.mark.asyncio
async def test_issue_selection_uses_reviewed_posts_for_drafted_topics_and_rejects_foreign_items() -> None:
    db = _db()
    ed = await core.resolve_edition(db, OWNER, "ai-dev-roundup")
    db.tables["social_schedule_v2"] = [
        _post(5, "approved", radar_topic_id="t2"),
        _post(6, "draft", edition="ai-mvp"),
    ]
    items = await issue.items_for_spec(db, ed, ranks=[1, 2, 3])
    assert items == [
        {"kind": "topic", "id": "t1"},
        {"kind": "post", "id": "p5"},
        {"kind": "topic", "id": "t3"},
    ]
    out = await issue.set_items(db, ed, items)
    assert [i["title"] for i in out["items"]] == ["Dev topic 1", "Post 5", "Dev topic 3"]
    removed = await issue.remove_items(db, ed, [{"kind": "post", "id": "p5"}])
    assert [i["position"] for i in removed["items"]] == [1, 2]
    with pytest.raises(StudioError):
        await issue.set_items(db, ed, [{"kind": "post", "id": "p6"}])  # another edition's post
    with pytest.raises(StudioError):
        await issue.set_items(db, ed, [{"kind": "topic", "id": "x1"}])  # the other radar's topic


@pytest.mark.asyncio
async def test_take_selection_writes_the_stories_in_order_and_locks_the_selection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _db()
    ed = await core.resolve_edition(db, OWNER, "ai-dev-roundup")
    db.tables["social_schedule_v2"] = [
        _post(
            5,
            "posted",
            linkedin_content="Post five text https://example.com/2",
            source_url="https://example.com/2",
        )
    ]
    db.tables["social_schedule_deliveries_v2"] = []
    await issue.set_items(db, ed, [{"kind": "post", "id": "p5"}, {"kind": "topic", "id": "t1"}])
    uploaded: list[dict[str, Any]] = []

    async def existing(keys: list[str], *, user_id: str) -> set[str]:
        return set()

    async def upload(**kw: Any) -> None:
        uploaded.append(kw)
        db.tables.setdefault("content_ingestion_v2", []).append(
            {
                "id": f"ci{len(uploaded)}",
                "key": kw["key"],
                "user_id": kw["user_id"],
                "type": "article",
                "title": kw["title"],
                "source_url": kw["source_url"],
                "source_name": kw["source_name"],
            }
        )

    import writer_engine.ingestion.store as store

    monkeypatch.setattr(store, "existing_keys", existing)
    monkeypatch.setattr(store, "upload_item", upload)
    arts = await issue.take_selection(
        db, user_id=OWNER, edition_id="ai-dev-roundup", send_date="2026-11-06", execution_id="ex1"
    )
    assert arts is not None and [a["title"] for a in arts] == ["Post 5", "Dev topic 1"]
    assert all(k["key"].endswith(".ai-dev-roundup") and k["key"].startswith("2026-11-06/") for k in uploaded)
    sel = db.tables["newsletter_issue_selections_v2"][0]
    assert sel["status"] == "locked" and sel["execution_id"] == "ex1"
    picked = issue.picked_from_selection(arts)
    assert [s["title"] for s in picked["top_selected_stories"]] == ["Post 5", "Dev topic 1"]
    assert picked["top_selected_stories"][0]["identifiers"] == ["ci1"]
    # A resumed run gets the same stories; another user's run gets nothing.
    again = await issue.take_selection(
        db, user_id=OWNER, edition_id="ai-dev-roundup", send_date="2026-11-06", execution_id="ex1"
    )
    assert again is not None and [a["title"] for a in again] == ["Post 5", "Dev topic 1"]
    assert (
        await issue.take_selection(
            db, user_id=OTHER, edition_id="ai-dev-roundup", send_date="2026-11-06", execution_id="ex2"
        )
        is None
    )


# ----------------------------------------------------------------------------- the hub


@pytest.mark.asyncio
async def test_studio_surface_routes_commands_and_pins_the_edition_from_context() -> None:
    req = HubRequest(
        message="generate 1-5 and 8 for edition theirs",
        user_id=OWNER,
        context={"surface": "content_studio", "edition_id": "ai-dev-roundup"},
    )
    decision = await route_message(req)
    assert (decision.tool, decision.op, decision.kind) == ("studio", "generate", "task")
    plan = build_dispatch_plan(
        HubDecision(**{**decision.model_dump(), "params": {**decision.params, "edition_id": "theirs"}}), req
    )
    assert plan.body["edition_id"] == "ai-dev-roundup" and plan.body["user_id"] == OWNER
    info = await route_message(
        HubRequest(
            message="cancel 4", user_id=OWNER, context={"surface": "content_studio", "edition_id": "ai-mvp"}
        )
    )
    assert (info.tool, info.op, info.kind, info.params["action"]) == ("studio", "update", "info", "cancel")


def test_the_general_chat_menu_has_no_studio_ops_and_the_studio_menu_only_studio_ops() -> None:
    general = render_catalog_prompt()
    studio = render_catalog_prompt(studio=True)
    assert "studio." not in general and "library.retrieve" in general
    assert "studio.generate" in studio and "library." not in studio


@pytest.mark.asyncio
async def test_general_chat_schedule_alias_still_means_library_lifecycle() -> None:
    from writer_engine.hub.catalog import lookup

    spec = lookup(None, "schedule")
    assert spec is not None and spec.name == "library.lifecycle"
