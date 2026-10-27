"""The radars: selection rules (ported verbatim from n8n), the weekly run, and scheduling a slate."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import pytest
from conftest import FakeSupabase

from writer_engine.radar import dev, drafts, run, trend
from writer_engine.radar.dev import Candidate

USER = "+14105914612"
NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)  # Sunday 07:00 ET


# --- Trend Radar ------------------------------------------------------------------------------


def _item(n: int, source: str = "InfoQ", title: str = "", days_old: int = 1) -> trend.Item:
    return trend.Item(
        source=source,
        title=title or f"AI agent story {n}",
        link=f"https://x.test/{n}",
        published=NOW - timedelta(days=days_old),
        guid=f"g{n}",
    )


def test_shortlist_drops_old_and_irrelevant_items_but_keeps_founder_sources() -> None:
    items = [
        _item(1),
        _item(2, days_old=30),
        _item(3, title="Gardening tips for autumn"),
        _item(4, source="Y Combinator", title="Gardening tips for autumn"),
    ]
    assert [i.guid for i in trend.shortlist(items, NOW)] == ["g1", "g4"]


def test_shortlist_caps_each_feed_at_twenty() -> None:
    items = [_item(n) for n in range(30)]
    assert len(trend.shortlist(items, NOW)) == 20


def test_rank_and_slate_merges_same_story_and_puts_demand_first() -> None:
    items = []
    for n in range(30):
        i = _item(n)
        demand = n < 20
        i.score = trend.Score(
            i=n,
            marketDriverScore=50 + n,
            driverType="demand trigger" if demand else "AI model/research",
            clientRelevance="MVP & startups" if demand else "AI advances",
            demandTrigger=demand,
            keep=True,
            topicKey=f"t{n}",
        )
        items.append(i)
    dup = _item(99, source="TechCrunch AI")
    dup.score = trend.Score(
        i=99, marketDriverScore=10, keep=True, topicKey="t5", driverType="demand trigger", demandTrigger=True
    )
    items.append(dup)
    off = _item(100)
    off.score = trend.Score(i=100, marketDriverScore=99, keep=True, driverType="off-topic")
    items.append(off)
    slate = trend.rank_and_slate(items)
    assert len(slate) == 24
    assert "g100" not in {i.guid for i in slate}  # off-topic never makes it
    assert sum(1 for i in slate if trend._is_demand(i)) >= 16
    t5 = next(i for i in slate if i.guid == "g5")
    assert t5.also_covered_by == ["TechCrunch AI"]


# --- Dev Radar --------------------------------------------------------------------------------


def _art(n: int, host: str, points: int = 0) -> Candidate:
    return Candidate(
        f"Claude agent article {n}", f"https://{host}/{n}", host, "article", "2026-10-30", points
    )


def test_select_keeps_youtube_query_strings_apart() -> None:
    # The n8n bug: stripping "?v=…" collapsed every video into one.
    arts = [_art(n, f"site{n}.dev") for n in range(16)]
    vids = [
        Candidate(
            f"Video {n} on Claude Code", f"https://www.youtube.com/watch?v=id{n}", "Chan (YouTube)", "video"
        )
        for n in range(8)
    ]
    pick = dev.select(arts + vids)
    assert len(pick) == 24 and sum(1 for p in pick if p.item_type == "video") == 8


def test_select_caps_three_articles_per_domain_and_prefers_known_sites() -> None:
    arts = [_art(n, "same.dev", 100) for n in range(10)] + [_art(100 + n, f"o{n}.dev") for n in range(12)]
    arts.append(_art(500, "simonwillison.net", 0))
    pick = dev.select(arts)
    ranked = pick[:16]  # ranks 1-16 are the capped articles; 17-24 backfill when there are no videos
    assert sum(1 for p in ranked if p.source == "same.dev") == 3
    assert ranked[0].source == "simonwillison.net"  # 0 points + 120 for a preferred site beats 100 points


def test_select_returns_nothing_on_an_outage_week() -> None:
    assert dev.select([_art(n, f"s{n}.dev") for n in range(5)]) == []


def test_fresh_videos_rank_before_archived_ones() -> None:
    arts = [_art(n, f"s{n}.dev") for n in range(16)]
    old = Candidate(
        "Old Claude video",
        "https://www.youtube.com/watch?v=old",
        "A (YouTube)",
        "video",
        "2026-10-01",
        archived=True,
    )
    new = Candidate(
        "New Claude video", "https://www.youtube.com/watch?v=new", "B (YouTube)", "video", "2026-10-29"
    )
    vids = [p for p in dev.select([*arts, old, new]) if p.item_type == "video"]
    assert [v.url for v in vids] == [
        "https://www.youtube.com/watch?v=new",
        "https://www.youtube.com/watch?v=old",
    ]


def test_hn_parsing_filters_junk_and_bad_hosts() -> None:
    hits = {
        "hits": [
            {"url": "https://ok.dev/a", "title": "Claude Code in practice", "points": 50, "created_at": "x"},
            {"url": "https://x.com/b", "title": "Claude agent thread", "points": 9},
            {"url": "https://ok.dev/c", "title": "Make money with AI agents", "points": 9},
            {"url": "https://ok.dev/d", "title": "Gardening", "points": 9},
        ]
    }
    assert [c.url for c in dev.parse_hn([hits])] == ["https://ok.dev/a"]


# --- Drafting ---------------------------------------------------------------------------------


BLOG = """SEO_TITLE: Ship before you pitch
TITLE: Angels want a product
META: Why seed investors ask for a working product.
CATEGORY: AI & DATA
===BLOG===
# Angels want a product

Body.
===LINKEDIN===
LinkedIn body #MVP
===END==="""


def test_parse_blog_reads_the_delimited_format() -> None:
    out = drafts.parse_blog(BLOG)
    assert out is not None
    assert out["title"] == "Angels want a product" and out["seo_title"] == "Ship before you pitch"
    assert out["body_md"].startswith("# Angels") and out["linkedin_content"] == "LinkedIn body #MVP"
    assert drafts.parse_blog("no format here") is None


def test_expand_selection() -> None:
    ranks = list(range(1, 25))
    assert drafts.expand_selection("1-3, 8, 12-13", ranks) == [1, 2, 3, 8, 12, 13]
    assert drafts.expand_selection("all", ranks) == ranks
    assert drafts.expand_selection("30, 2", ranks) == [2]


class _Router:
    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = 0

    async def complete(self, **_k: Any) -> Any:
        self.calls += 1

        class R:
            text = self.text

        return R()


@pytest.mark.asyncio
async def test_scheduling_a_trend_slate_fills_free_slots_with_all_channels() -> None:
    db = FakeSupabase()
    db.tables["social_schedule_v2"] = [
        {
            "user_id": USER,
            "scheduled_date": "2026-11-01",
            "slot": "afternoon",
            "state": "pending",
            "external_id": "x",
        }
    ]
    topics = [
        {"id": f"t{n}", "rank": n, "title": f"Topic {n}", "url": f"https://s.test/{n}", "summary": "s"}
        for n in (1, 2)
    ]
    router = _Router(BLOG)
    out = await drafts.schedule_slate(
        db, user_id=USER, radar="trend", topics=topics, channels=None, now=NOW, router=router
    )
    assert out["scheduled"] == 2 and router.calls == 2
    rows = [r for r in db.tables["social_schedule_v2"] if r.get("source") == "trend_batch"]
    # Sunday 07:00 EST: 09:00 is still ahead, 14:00 is taken, so then Monday morning.
    assert [(r["scheduled_date"], r["slot"]) for r in rows] == [
        ("2026-11-01", "morning"),
        ("2026-11-02", "morning"),
    ]
    assert rows[0]["channels"] == ["website", "li_techahir", "li_agile", "li_personal"]
    assert rows[0]["include_image"] is True and rows[0]["radar_topic_id"] == "t1"


@pytest.mark.asyncio
async def test_a_roundup_post_without_its_link_is_not_scheduled(monkeypatch: pytest.MonkeyPatch) -> None:
    db = FakeSupabase()
    topics = [
        {"id": "a", "rank": 1, "title": "A", "url": "https://a.test/1", "item_type": "article"},
        {"id": "b", "rank": 2, "title": "B", "url": "https://b.test/2", "item_type": "video"},
    ]

    async def fake_structured(*_a: Any, **_k: Any) -> Any:
        return drafts.RoundupPosts(
            posts=[
                drafts.RoundupPost(
                    i=0, content="Hook\n\n🔗 Read: https://a.test/1\n\n💬 Comment 'newsletter'"
                ),
                drafts.RoundupPost(i=1, content="A post that forgot its link"),
            ]
        ), None

    monkeypatch.setattr(drafts, "complete_structured", fake_structured)
    out = await drafts.schedule_slate(
        db, user_id=USER, radar="dev", topics=topics, channels=None, now=NOW, router=object()
    )
    assert (out["scheduled"], out["failed_drafts"]) == (1, 1)
    row = db.tables["social_schedule_v2"][0]
    assert row["channels"] == ["li_techahir", "li_agile", "li_personal"] and row["include_image"] is False
    assert row["scheduled_date"] == "2026-11-02"  # weekdays only, from tomorrow


# --- The weekly run ---------------------------------------------------------------------------


def test_week_of_and_due_times() -> None:
    assert run.week_of(NOW) == date(2026, 11, 2)  # Sunday's slate is for the next week
    assert run.week_of(datetime(2026, 11, 4, 15, tzinfo=UTC)) == date(2026, 11, 2)
    assert run.due_at("dev", date(2026, 11, 2)).isoformat() == "2026-11-01T06:00:00-05:00"
    assert run.due_at("trend", date(2026, 11, 2)).isoformat() == "2026-11-02T06:00:00-05:00"


def _dev_net(req: httpx.Request) -> httpx.Response:
    if "hn.algolia.com" in str(req.url):
        q = req.url.params.get("query")
        return httpx.Response(
            200,
            json={
                "hits": [
                    {
                        "url": f"https://site{n}-{abs(hash(q)) % 97}.dev/{q}",
                        "title": f"Claude Code {q} {n}",
                        "points": n,
                    }
                    for n in range(3)
                ]
            },
        )
    return httpx.Response(404)


@pytest.mark.asyncio
async def test_a_dev_run_stores_the_slate_once_per_week(monkeypatch: pytest.MonkeyPatch) -> None:
    db = FakeSupabase()

    async def no_feeds(*_a: Any, **_k: Any) -> list[Any]:
        return []

    async def no_editions(*_a: Any, **_k: Any) -> int:
        return 0

    import writer_engine.ingestion.feeds as feedlib

    monkeypatch.setattr(feedlib, "fetch_feed", no_feeds)
    monkeypatch.setattr(run, "feed_radar_slate", no_editions)
    async with httpx.AsyncClient(transport=httpx.MockTransport(_dev_net)) as http:
        first = await run.run_radar(db, http, user_id=USER, radar="dev", now=NOW)
        second = await run.run_radar(db, http, user_id=USER, radar="dev", now=NOW + timedelta(hours=1))
    assert first["status"] == "ok" and first["stats"]["topics"] >= 6
    assert second["skipped"] == "already run this week"
    assert {r["week_of"] for r in db.tables["radar_topics_v2"]} == {"2026-11-02"}
    assert db.tables["radar_runs_v2"][0]["status"] == "ok"
    assert "YOUTUBE_API_KEY" in json.dumps(first["stats"]["errors"])


@pytest.mark.asyncio
async def test_an_outage_week_keeps_last_weeks_slate(monkeypatch: pytest.MonkeyPatch) -> None:
    db = FakeSupabase()
    db.tables["radar_topics_v2"] = [{"user_id": USER, "radar": "dev", "week_of": "2026-10-26", "rank": 1}]

    async def no_feeds(*_a: Any, **_k: Any) -> list[Any]:
        return []

    import writer_engine.ingestion.feeds as feedlib

    monkeypatch.setattr(feedlib, "fetch_feed", no_feeds)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503))) as http:
        out = await run.run_radar(db, http, user_id=USER, radar="dev", now=NOW)
    assert out["status"] == "kept_previous"
    assert len(db.tables["radar_topics_v2"]) == 1
