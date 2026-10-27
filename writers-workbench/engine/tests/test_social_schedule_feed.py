"""Slots and numbering for the post calendar; the editions it feeds; gather's edition scoping."""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from typing import Any

import pytest
from conftest import FakeSupabase
from gather_step import main as G

from writer_engine.social import feed
from writer_engine.social import schedule as S

USER = "+14105914612"


def test_batch_week_uses_the_next_slots_including_weekends() -> None:
    # Friday 2026-10-30 10:00 ET: the 09:00 slot has passed.
    now = datetime(2026, 10, 30, 14, 0, tzinfo=UTC)
    slots = S.next_slots(now, 4, weekdays_only=False)
    assert [(d.isoformat(), s) for d, s in slots] == [
        ("2026-10-30", "afternoon"),
        ("2026-10-31", "morning"),
        ("2026-10-31", "afternoon"),
        ("2026-11-01", "morning"),
    ]


def test_roundup_batch_uses_weekdays_and_skips_taken_slots() -> None:
    now = datetime(2026, 10, 30, 14, 0, tzinfo=UTC)
    taken = {("2026-11-02", "morning")}
    slots = S.next_slots(now, 3, weekdays_only=True, taken=taken, start=date(2026, 10, 31))
    assert [(d.isoformat(), s) for d, s in slots] == [
        ("2026-11-02", "afternoon"),
        ("2026-11-03", "morning"),
        ("2026-11-03", "afternoon"),
    ]


def test_interleave_alternates_articles_and_videos() -> None:
    posts = [{"t": f"a{i}", "item_type": "article"} for i in range(4)] + [
        {"t": f"v{i}", "item_type": "video"} for i in range(2)
    ]
    order = [p["t"] for p in S.interleave(posts)]
    assert order[0] == "a0" and order.count("v0") == 1
    assert order == ["a0", "v0", "a1", "a2", "v1", "a3"]


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("website,li_techahir,li_agile", ["website", "li_techahir", "li_agile"]),
        ("both", ["li_techahir", "li_agile"]),
        ("linkedin", ["li_techahir", "li_agile"]),
        (["Agile", "personal"], ["li_agile", "li_personal"]),
        ("", ["website"]),
    ],
)
def test_normalise_channels(raw: Any, want: list[str]) -> None:
    assert S.normalise_channels(raw) == want


def test_slot_hours_are_eastern_across_dst() -> None:
    assert S.slot_at(date(2026, 10, 30), "morning").astimezone(UTC).hour == 13  # EDT
    assert S.slot_at(date(2026, 11, 2), "afternoon").astimezone(UTC).hour == 19  # EST


@pytest.mark.asyncio
async def test_enqueue_skips_an_external_id_the_user_already_has() -> None:
    db = FakeSupabase()
    row = S.row_for(
        USER,
        {"title": "Hello", "channels": ["website"]},
        date(2026, 11, 2),
        "morning",
        source="manual",
        prefix="sched",
    )
    assert len(await S.enqueue(db, [row])) == 1
    assert await S.enqueue(db, [dict(row)]) == []
    assert db.count("social_schedule_v2") == 1
    assert row["external_id"] == "sched-2026-11-02-morning-hello"


@pytest.mark.asyncio
async def test_a_posted_item_feeds_only_the_editions_subscribed_to_its_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = FakeSupabase()
    db.tables["newsletter_feed_sources_v2"] = [
        {
            "user_id": USER,
            "edition_id": "ai-mvp",
            "url": "social://trend_batch",
            "url_type": "social_queue",
            "active": True,
        },
        {
            "user_id": USER,
            "edition_id": "ai-dev-roundup",
            "url": "social://roundup_batch",
            "url_type": "social_queue",
            "active": True,
        },
    ]
    written: list[dict[str, Any]] = []

    async def admin() -> FakeSupabase:
        return db

    async def existing(keys: list[str], *, user_id: str) -> set[str]:
        return set()

    async def upload(**kw: Any) -> None:
        written.append(kw)

    import writer_engine.ingestion.store as store
    import writer_engine.supabase.client as sc

    monkeypatch.setattr(sc, "get_supabase_admin", admin)
    monkeypatch.setattr(store, "existing_keys", existing)
    monkeypatch.setattr(store, "upload_item", upload)
    row = {
        "user_id": USER,
        "source": "trend_batch",
        "title": "Angels want product",
        "body_md": "Blog body",
        "category": "AI & DATA",
    }
    await feed.feed_posted_item(row, {"website": {"public_url": "https://www.techahir.com/blog/angels"}})
    assert len(written) == 1
    w = written[0]
    assert w["key"].endswith(".ai-mvp") and w["feed_url"] == "social://trend_batch"
    assert w["source_url"] == "https://www.techahir.com/blog/angels"
    assert "https://www.techahir.com/blog/angels" in w["markdown"]


def test_gather_scope_owns_its_feeds_and_its_engine_rows_only() -> None:
    scope = G.Scope({"https://clarkesworldmagazine.com/feed/"}, "ai-mvp", 7)
    assert scope.owns(
        {"feed_url": "https://clarkesworldmagazine.com/feed/", "key": "2026-11-02/x.clarkesworld"}
    )
    assert scope.owns({"feed_url": "radar://trend", "key": "2026-11-02/angels.ai-mvp"})
    assert not scope.owns({"feed_url": "radar://trend", "key": "2026-11-02/angels.ai-dev-roundup"})
    assert not scope.owns({"feed_url": "https://hnrss.org/show", "key": "2026-11-02/y.hn"})


def test_gather_without_an_edition_keeps_the_old_behaviour(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[tuple[str, dict[str, Any]]] = []

    async def fake(day: str, _user: str, _limit: int, **kw: Any) -> list[dict[str, Any]]:
        asked.append((day, kw))
        return [{"id": "a"}]

    monkeypatch.setattr(G, "_fetch_day", fake)
    assert asyncio.run(G._fetch("2026-11-02", USER, 50)) == [{"id": "a"}]
    assert asked == [("2026-11-02", {})]


def test_a_weekly_edition_reads_its_whole_week(monkeypatch: pytest.MonkeyPatch) -> None:
    db = FakeSupabase()
    db.tables["content_ingestion_v2"] = [
        {
            "id": "mon",
            "key": "2026-10-26/a.ai-mvp",
            "user_id": USER,
            "type": "article",
            "feed_url": "radar://trend",
            "published_timestamp": "2026-10-26T12:00:00+00:00",
        },
        {
            "id": "thu",
            "key": "2026-10-29/b.ai-mvp",
            "user_id": USER,
            "type": "article",
            "feed_url": "social://trend_batch",
            "published_timestamp": "2026-10-29T12:00:00+00:00",
        },
        {
            "id": "other",
            "key": "2026-10-29/c.wasteland-wire",
            "user_id": USER,
            "type": "article",
            "feed_url": "radar://dev",
            "published_timestamp": "2026-10-29T12:00:00+00:00",
        },
        {
            "id": "old",
            "key": "2026-10-20/d.ai-mvp",
            "user_id": USER,
            "type": "article",
            "feed_url": "radar://trend",
            "published_timestamp": "2026-10-20T12:00:00+00:00",
        },
    ]

    async def scope(_e: str, _u: str) -> G.Scope:
        return G.Scope(set(), "ai-mvp", 7)

    async def admin() -> FakeSupabase:
        return db

    import writer_engine.supabase.client as sc

    monkeypatch.setattr(G, "_scope", scope)
    monkeypatch.setattr(sc, "get_supabase_admin", admin)
    rows = asyncio.run(G._fetch("2026-10-30", USER, 50, edition_id="ai-mvp"))
    assert [r["id"] for r in rows] == ["thu", "mon"]
