"""E1 — one feed end to end, and the three n8n failures the port exists to fix.

1. **J6** — a single item with no date or no usable title aborted the whole execution.
2. **the dead loop** — ``DEV - Newsletter Ingestion (Multi-User Cron)`` never wired ``report_run``
   back to ``split_per_feed``, so it processed the first feed and stopped, having already claimed
   all 32.
3. **the wasted scrape** — every candidate was Firecrawled even when the feed carried the full post.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest
from conftest import FakeSupabase

from writer_engine.ingestion import enrich, pipeline, store

NOW = datetime(2026, 10, 17, 18, 30, tzinfo=UTC)


def _feed(**overrides: object) -> store.FeedSource:
    row: dict[str, object] = {
        "id": "feed-1",
        "user_id": "+14105914612",
        "edition_id": "ai-news",
        # Named for the single publisher the default items come from: with every item on one
        # domain the aggregator rule (3+ distinct domains) correctly does NOT fire, so the label
        # comes from the feed name. The aggregator path has its own test below.
        "name": "TechCrunch",
        "url": "https://rss.app/feeds/v1.1/AkOariu1C7YyUUMv.json",
        "url_type": "rss",
        "item_type": "article",
        "fetch_interval_minutes": 180,
    }
    row.update(overrides)
    return store.FeedSource.from_row(row)


def _json_feed(*items: dict[str, object]) -> str:
    return json.dumps({"version": "https://jsonfeed.org/version/1.1", "items": list(items)})


def _item(n: int, **overrides: object) -> dict[str, object]:
    out: dict[str, object] = {
        "id": str(n),
        "title": f"Story number {n}",
        "url": f"https://techcrunch.com/2026/10/17/story-{n}/",
        "date_published": "2026-10-17T09:00:00Z",
        "content_text": "teaser",
    }
    out.update(overrides)
    return out


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch, fake_supabase: FakeSupabase) -> FakeSupabase:
    """Supabase faked (both entry points), Firecrawl and both LLM calls stubbed."""

    async def _client() -> FakeSupabase:
        return fake_supabase

    import writer_engine.storage.adapter as adapter

    monkeypatch.setattr("writer_engine.supabase.client.get_supabase_admin", _client)
    monkeypatch.setattr(adapter, "get_supabase_admin", _client)

    async def _scrape(url: str, *, client: object = None) -> enrich.Scraped:
        return enrich.Scraped(
            markdown=f"# Scraped\n\nFull body of {url}",
            html=f"<h1>Scraped</h1><p>{url}</p>",
            image_urls=["https://cdn.example/hero.jpg"],
            links=["https://openai.com/announcement"],
            title="Scraped title",
            url=url,
        )

    async def _judge(body: str, *, title: str = "", genre: str = "") -> tuple[bool, str]:
        return True, "relevant"

    async def _external(scraped: enrich.Scraped) -> list[str]:
        return ["https://openai.com/announcement"]

    # The suite runs with FIRECRAWL_API_KEY cleared (conftest), and the pipeline now asks whether a
    # scraper is available BEFORE reaching for one — so a stubbed `scrape` is not enough on its own.
    monkeypatch.setattr(pipeline.enrich, "scraper_available", lambda: True)
    monkeypatch.setattr(pipeline.enrich, "scrape", _scrape)
    monkeypatch.setattr(pipeline.enrich, "judge_relevance", _judge)
    monkeypatch.setattr(pipeline.enrich, "extract_external_sources", _external)
    return fake_supabase


def _client_serving(body: str, content_type: str = "application/json") -> httpx.AsyncClient:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=body, headers={"content-type": content_type})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_uploads_each_item_with_the_scraped_body(self, wired: FakeSupabase) -> None:
        async with _client_serving(_json_feed(_item(1), _item(2))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)

        assert (result.items_fetched, result.items_uploaded) == (2, 2)
        rows = wired.tables[store.TABLE]
        assert sorted(r["key"] for r in rows) == [
            "2026-10-17/story-number-1.techcrunch",
            "2026-10-17/story-number-2.techcrunch",
        ]
        assert rows[0]["source_name"] == "techcrunch"
        assert rows[0]["type"] == "article"
        assert rows[0]["external_source_urls"] == ["https://openai.com/announcement"]
        assert wired.paths(store.BUCKET) == {f"{r['key']}.{ext}" for r in rows for ext in ("md", "html")}

    @pytest.mark.asyncio
    async def test_records_the_run(self, wired: FakeSupabase) -> None:
        async with _client_serving(_json_feed(_item(1))) as client:
            await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        run = wired.tables[store.RUNS_TABLE][0]
        assert (run["items_fetched"], run["items_uploaded"]) == (1, 1)
        assert run["error_message"] is None

    @pytest.mark.asyncio
    async def test_a_vendor_blog_is_labelled_by_its_domain(self, wired: FakeSupabase) -> None:
        """``openai``, not the row name ``OpenAI Blog`` and not n8n's ``blog-open-ai``.

        A measured, accepted divergence: the 150 ``blog-open-ai`` rows in DEV were written from a
        hardcoded constant in an n8n code node, which the feed table cannot reproduce either way
        (the row slugs to ``openai-blog``). Nothing joins on ``source_name``, so the cost is one
        publisher reading under two names across the cutover. See ``sources.modal_domain``.
        """
        items = [_item(n, url=f"https://openai.com/index/post-{n}/") for n in range(1, 4)]
        async with _client_serving(_json_feed(*items)) as client:
            await pipeline.ingest_feed(_feed(name="OpenAI Blog"), client=client, now=NOW)
        assert {r["source_name"] for r in wired.tables[store.TABLE]} == {"openai"}

    @pytest.mark.asyncio
    async def test_aggregator_feed_is_labelled_per_publisher(self, wired: FakeSupabase) -> None:
        items = [
            _item(1, url="https://www.bbc.com/news/a"),
            _item(2, url="https://finance.yahoo.com/news/b"),
            _item(3, url="https://i-programmer.info/news/c"),
        ]
        async with _client_serving(_json_feed(*items)) as client:
            await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert {r["source_name"] for r in wired.tables[store.TABLE]} == {
            "bbc",
            "yahoo-finance",
            "i-programmer",
        }


class TestDedupe:
    @pytest.mark.asyncio
    async def test_already_ingested_keys_are_skipped(self, wired: FakeSupabase) -> None:
        wired.tables[store.TABLE] = [
            {
                "key": "2026-10-17/story-number-1.techcrunch",
                "user_id": "+14105914612",
                "deleted_at": None,
            }
        ]
        async with _client_serving(_json_feed(_item(1), _item(2))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_uploaded, result.items_skipped_existing) == (1, 1)

    @pytest.mark.asyncio
    async def test_two_entries_colliding_on_one_key_upload_once(self, wired: FakeSupabase) -> None:
        """A feed that lists an updated story twice would otherwise be counted as two uploads while
        the second upsert silently overwrote the first."""
        async with _client_serving(_json_feed(_item(1), _item(1, id="1-dup"))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_uploaded, result.items_skipped_existing) == (1, 1)
        assert len(wired.tables[store.TABLE]) == 1


class TestJ6Isolation:
    @pytest.mark.asyncio
    async def test_a_dateless_item_is_keyed_to_today_not_dropped(self, wired: FakeSupabase) -> None:
        async with _client_serving(_json_feed(_item(1, date_published=None))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert result.items_uploaded == 1
        assert wired.tables[store.TABLE][0]["key"].startswith("2026-10-17/")

    @pytest.mark.asyncio
    async def test_one_unkeyable_item_does_not_cost_the_others(self, wired: FakeSupabase) -> None:
        """The whole point. In n8n this batch produced zero rows and an errored execution."""
        async with _client_serving(_json_feed(_item(1, title="🚀"), _item(2), _item(3))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_uploaded, result.items_skipped_unkeyable) == (2, 1)
        assert result.error is None

    @pytest.mark.asyncio
    async def test_one_failing_upload_does_not_cost_the_others(self, wired: FakeSupabase) -> None:
        wired.fail_uploads.add("2026-10-17/story-number-2.techcrunch.md")
        async with _client_serving(_json_feed(_item(1), _item(2), _item(3))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_uploaded, result.items_failed) == (2, 1)
        # The feed is still reported as degraded, so `last_error` says so.
        assert result.error and "1 item(s) failed" in result.error

    @pytest.mark.asyncio
    async def test_untitled_items_are_dropped_before_keying(self, wired: FakeSupabase) -> None:
        async with _client_serving(_json_feed(_item(1, title=""), _item(2))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_fetched, result.items_uploaded) == (1, 1)


class TestFeedLevelFailure:
    @pytest.mark.asyncio
    async def test_a_dead_feed_records_its_error_and_returns(self, wired: FakeSupabase) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="upstream down")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert result.items_uploaded == 0
        assert result.error and "HTTPStatusError" in result.error
        assert wired.tables[store.RUNS_TABLE][0]["error_message"] == result.error

    @pytest.mark.asyncio
    async def test_an_empty_feed_is_logged_without_an_error(self, wired: FakeSupabase) -> None:
        async with _client_serving(_json_feed()) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_fetched, result.error) == (0, None)
        assert wired.tables[store.RUNS_TABLE][0]["items_fetched"] == 0


class TestScrapeAvoidance:
    @pytest.mark.asyncio
    async def test_a_full_body_in_the_feed_is_used_as_is(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Medium / Clarkesworld / Escape Pod syndicate the whole post; scraping it spends a
        Firecrawl credit to get a worse copy of text we already have."""
        scraped: list[str] = []

        async def _spy(url: str, *, client: object = None) -> enrich.Scraped:
            scraped.append(url)
            return enrich.Scraped(markdown="scraped")

        monkeypatch.setattr(pipeline.enrich, "scrape", _spy)
        body = "word " * (pipeline.INLINE_BODY_MIN_WORDS + 10)
        async with _client_serving(
            _json_feed(_item(1, content_text=body, content_html=f"<p>{body}</p>"))
        ) as client:
            result = await pipeline.ingest_feed(_feed(name="Clarkesworld"), client=client, now=NOW)
        assert result.items_uploaded == 1
        assert scraped == []
        assert wired.tables[store.TABLE][0]["storage_path_md"].endswith(".md")
        assert wired.objects[(store.BUCKET, wired.tables[store.TABLE][0]["storage_path_md"])][0].decode()

    @pytest.mark.asyncio
    async def test_a_teaser_is_scraped(self, wired: FakeSupabase) -> None:
        async with _client_serving(_json_feed(_item(1, content_text="short teaser"))) as client:
            await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        md_path = wired.tables[store.TABLE][0]["storage_path_md"]
        assert "Full body of" in wired.objects[(store.BUCKET, md_path)][0].decode()

    @pytest.mark.asyncio
    async def test_unscrapeable_destinations_are_not_scraped(self, wired: FakeSupabase) -> None:
        items = [
            _item(1, url="https://www.youtube.com/watch?v=x"),
            _item(2, url="https://i.redd.it/x.png"),
        ]
        async with _client_serving(_json_feed(*items)) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_uploaded, result.items_skipped_unscrapeable) == (0, 2)

    @pytest.mark.asyncio
    async def test_a_failed_scrape_skips_the_item(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _broken(url: str, *, client: object = None) -> enrich.Scraped:
            return enrich.Scraped(error="ReadTimeout: firecrawl")

        monkeypatch.setattr(pipeline.enrich, "scrape", _broken)
        async with _client_serving(_json_feed(_item(1))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_uploaded, result.items_skipped_unscrapeable) == (0, 1)


class TestRelevanceGate:
    @pytest.mark.asyncio
    async def test_an_irrelevant_item_is_not_ingested(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _reject(body: str, *, title: str = "", genre: str = "") -> tuple[bool, str]:
            return False, "job posting"

        monkeypatch.setattr(pipeline.enrich, "judge_relevance", _reject)
        async with _client_serving(_json_feed(_item(1))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_uploaded, result.items_skipped_irrelevant) == (0, 1)
        assert wired.count(store.TABLE) == 0

    @pytest.mark.asyncio
    async def test_items_kept_because_the_gate_was_down_are_counted(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The gate fails open, so a dead Gemini key used to look exactly like a clean run.
        async def _down(body: str, *, title: str = "", genre: str = "") -> tuple[bool, str]:
            return True, enrich.GATE_UNAVAILABLE

        monkeypatch.setattr(pipeline.enrich, "judge_relevance", _down)
        async with _client_serving(_json_feed(_item(1), _item(2))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_uploaded, result.items_kept_ungated) == (2, 2)

    @pytest.mark.asyncio
    async def test_a_judged_run_reports_no_ungated_items(self, wired: FakeSupabase) -> None:
        async with _client_serving(_json_feed(_item(1))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert (result.items_uploaded, result.items_kept_ungated) == (1, 0)

    @pytest.mark.asyncio
    async def test_judge_relevance_returns_the_marker_when_the_model_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _boom(*_a: object, **_k: object) -> object:
            raise RuntimeError("400 API key not valid")

        monkeypatch.setattr(enrich, "complete_structured", _boom)
        monkeypatch.setattr(enrich, "get_router", lambda *_a, **_k: object())
        assert await enrich.judge_relevance("some body", genre="post-apocalyptic") == (
            True,
            enrich.GATE_UNAVAILABLE,
        )


class TestRedditRouting:
    @staticmethod
    def _listing(**overrides: object) -> dict[str, object]:
        data: dict[str, object] = {
            "title": "Anyone else noticing this?",
            "permalink": "/r/artificial/comments/abc123/anyone_else/",
            "created_utc": 1_792_000_000,
            "author": "someuser",
            "is_self": True,
            "selftext": "I ran the model locally and...",
            "selftext_html": "&lt;p&gt;I ran the model locally and...&lt;/p&gt;",
            "score": 42,
            "num_comments": 7,
            "subreddit": "artificial",
            "id": "abc123",
            "link_flair_text": None,
        }
        data.update(overrides)
        return {"data": {"children": [{"data": data}]}}

    @pytest.mark.asyncio
    async def test_a_self_post_is_ingested_without_a_scrape(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _never(url: str, *, client: object = None) -> enrich.Scraped:  # pragma: no cover
            raise AssertionError("a self post must not be scraped")

        monkeypatch.setattr(pipeline.enrich, "scrape", _never)
        async with _client_serving(json.dumps(self._listing())) as client:
            result = await pipeline.ingest_feed(
                _feed(name="r/artificial", url_type="reddit", item_type="reddit_post"),
                client=client,
                now=NOW,
            )
        assert result.items_uploaded == 1
        row = wired.tables[store.TABLE][0]
        assert row["type"] == "reddit_post"
        assert row["source_name"] == "reddit-artificial"
        assert row["reddit_metadata"]["score"] == 42
        assert row["key"] == "2026-10-14/anyone-else-noticing-this.reddit-artificial"

    @pytest.mark.asyncio
    async def test_a_link_post_is_scraped_and_typed_article(self, wired: FakeSupabase) -> None:
        listing = self._listing(
            is_self=False,
            selftext="",
            selftext_html="",
            url_overridden_by_dest="https://techcrunch.com/2026/10/17/thing/",
        )
        async with _client_serving(json.dumps(listing)) as client:
            result = await pipeline.ingest_feed(
                _feed(name="r/artificial", url_type="reddit", item_type="reddit_post"),
                client=client,
                now=NOW,
            )
        assert result.items_uploaded == 1
        row = wired.tables[store.TABLE][0]
        assert row["type"] == "article"
        assert row["source_name"] == "reddit-artificial"
        assert row["source_url"] == "https://techcrunch.com/2026/10/17/thing/"


class TestItemType:
    def test_a_competitor_newsletter_feed_keeps_its_declared_type(self) -> None:
        """``gather_step`` filters ``type != 'newsletter'``. Without migration 029's column these six
        feeds would be typed ``article`` and their archives would show up as candidate stories."""
        assert pipeline.feed_item_type(_feed(name="The Neuron", item_type="newsletter")) == "newsletter"

    def test_an_undeclared_rss_feed_defaults_to_article(self) -> None:
        assert pipeline.feed_item_type(_feed(item_type="")) == "article"

    def test_an_undeclared_reddit_feed_defaults_to_reddit_post(self) -> None:
        assert pipeline.feed_item_type(_feed(url_type="reddit", item_type="")) == "reddit_post"

    def test_a_junk_value_is_ignored(self) -> None:
        assert pipeline.feed_item_type(_feed(item_type="nonsense")) == "article"


class TestSourceUrlType:
    @pytest.mark.asyncio
    async def test_a_source_row_is_scraped_as_one_item(self, wired: FakeSupabase) -> None:
        """``source`` rows come from ``genre_config_v2.source_urls`` and are pages, not feeds. n8n
        routed them into the RSS branch, where they parsed as zero items every time."""

        def handler(_request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
            raise AssertionError("a source row must not be fetched as a feed")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await pipeline.ingest_feed(
                _feed(
                    name="Post-Apocalyptic Science Fiction — source",
                    url="https://www.goodreads.com/shelf/show/post-apocalyptic",
                    url_type="source",
                ),
                client=client,
                now=NOW,
            )
        assert (result.items_fetched, result.items_uploaded) == (1, 1)
        assert wired.tables[store.TABLE][0]["key"].startswith("2026-10-17/")


class TestTickProcessesEveryFeed:
    @pytest.mark.asyncio
    async def test_all_claimed_feeds_are_ingested(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The multi-user cron's loop was never wired back from ``report_run``, so it handled feed
        one and stopped — after ``/feeds/due`` had already stamped all 32."""
        wired.tables[store.FEEDS_TABLE] = [
            {
                "id": f"feed-{n}",
                "user_id": "+14105914612",
                "edition_id": "ai-news",
                "name": f"Feed {n}",
                "url": f"https://rss.app/feeds/v1.1/feed-{n}.json",
                "url_type": "rss",
                "item_type": "article",
                "active": True,
                "fetch_interval_minutes": 180,
                "last_fetched_at": None,
            }
            for n in range(1, 6)
        ]

        seen: list[str] = []

        async def _ingest(feed: store.FeedSource, **kwargs: object) -> pipeline.FeedRunResult:
            seen.append(feed.name)
            return pipeline.FeedRunResult(feed_id=feed.id, feed_name=feed.name, items_uploaded=1)

        monkeypatch.setattr(pipeline, "ingest_feed", _ingest)
        results = await pipeline.ingest_due_feeds(now=NOW)
        assert len(results) == 5
        assert seen == [f"Feed {n}" for n in range(1, 6)]

    @pytest.mark.asyncio
    async def test_nothing_due_is_not_an_error(self, wired: FakeSupabase) -> None:
        wired.tables[store.FEEDS_TABLE] = []
        assert await pipeline.ingest_due_feeds(now=NOW) == []

    @pytest.mark.asyncio
    async def test_one_dead_feed_does_not_stop_the_tick(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        wired.tables[store.FEEDS_TABLE] = [
            {
                "id": f"feed-{n}",
                "user_id": "u",
                "edition_id": "ai-news",
                "name": f"Feed {n}",
                "url": f"https://x/{n}.json",
                "url_type": "rss",
                "item_type": "article",
                "active": True,
                "fetch_interval_minutes": 180,
                "last_fetched_at": None,
            }
            for n in range(1, 4)
        ]

        async def _ingest(feed: store.FeedSource, **kwargs: object) -> pipeline.FeedRunResult:
            if feed.name == "Feed 2":
                return pipeline.FeedRunResult(
                    feed_id=feed.id, feed_name=feed.name, error="HTTPStatusError: 503"
                )
            return pipeline.FeedRunResult(feed_id=feed.id, feed_name=feed.name, items_uploaded=2)

        monkeypatch.setattr(pipeline, "ingest_feed", _ingest)
        results = await pipeline.ingest_due_feeds(now=NOW)
        assert sum(r.items_uploaded for r in results) == 4
        assert [r.feed_name for r in results if r.error] == ["Feed 2"]


class TestLabelOrdering:
    """The four cases of ``_label_items``, in the order they are tried."""

    @pytest.mark.asyncio
    async def test_a_newsletter_feed_keeps_its_brand(self, wired: FakeSupabase) -> None:
        """ "The Neuron", not "theneurondaily" — and it matches the 124 rows already in the corpus."""
        items = [_item(n, url=f"https://www.theneurondaily.com/p/post-{n}") for n in range(1, 4)]
        async with _client_serving(_json_feed(*items)) as client:
            await pipeline.ingest_feed(
                _feed(name="The Neuron", item_type="newsletter"), client=client, now=NOW
            )
        rows = wired.tables[store.TABLE]
        assert {r["source_name"] for r in rows} == {"the-neuron"}
        assert {r["type"] for r in rows} == {"newsletter"}

    @pytest.mark.asyncio
    async def test_a_single_publisher_feed_uses_its_domain_not_its_name(self, wired: FakeSupabase) -> None:
        """The nine wasteland-wire feeds share one name, so the name cannot be the label."""
        items = [_item(n, url=f"https://www.strangehorizons.com/fiction/{n}/") for n in range(1, 4)]
        async with _client_serving(_json_feed(*items)) as client:
            await pipeline.ingest_feed(
                _feed(name="Post-Apocalyptic Science Fiction — RSS"), client=client, now=NOW
            )
        assert {r["source_name"] for r in wired.tables[store.TABLE]} == {"strangehorizons"}

    @pytest.mark.asyncio
    async def test_two_feeds_sharing_a_name_do_not_collide(self, wired: FakeSupabase) -> None:
        """Same title from two magazines under one shared feed name is a key collision."""
        shared = "Post-Apocalyptic Science Fiction — RSS"
        for domain in ("strangehorizons.com", "clarkesworldmagazine.com"):
            items = [_item(n, url=f"https://www.{domain}/story-{n}/") for n in range(1, 4)]
            async with _client_serving(_json_feed(*items)) as client:
                await pipeline.ingest_feed(_feed(name=shared), client=client, now=NOW)
        keys = {r["key"] for r in wired.tables[store.TABLE]}
        assert len(keys) == 6
        assert sum("strangehorizons" in k for k in keys) == 3
        assert sum("clarkesworldmagazine" in k for k in keys) == 3

    @pytest.mark.asyncio
    async def test_a_subreddit_feed_is_labelled_from_its_name(self, wired: FakeSupabase) -> None:
        """Every item is on reddit.com, so the domain says nothing; the subreddit is the source."""
        listing = TestRedditRouting._listing()
        async with _client_serving(json.dumps(listing)) as client:
            await pipeline.ingest_feed(
                _feed(name="r/artificial", url_type="reddit", item_type="reddit_post"),
                client=client,
                now=NOW,
            )
        assert wired.tables[store.TABLE][0]["source_name"] == "reddit-artificial"


class TestNoScraperConfigured:
    """Firecrawl is excluded on DEV until the account is topped up or a substitute is wired in. The
    point of this block is that "we are not scraping today" must not be recorded as "this
    destination cannot be read": on the first live tick, 62 of 72 items were lost to a 402 and the
    counters called them unscrapeable, which reads as a feed problem."""

    @pytest.mark.asyncio
    async def test_items_needing_a_scrape_are_deferred_not_called_unscrapeable(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(pipeline.enrich, "scraper_available", lambda: False)
        called: list[str] = []

        async def _never(url: str, *, client: object = None) -> enrich.Scraped:
            called.append(url)
            return enrich.Scraped(markdown="should not happen")

        monkeypatch.setattr(pipeline.enrich, "scrape", _never)

        body = _json_feed(_item(1, content_text="short teaser"), _item(2, content_text="also short"))
        async with _client_serving(body) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)

        assert called == [], "no scrape should be attempted when no scraper is available"
        assert result.items_deferred_no_scraper == 2
        assert result.items_skipped_unscrapeable == 0
        assert result.items_uploaded == 0
        assert result.error is None, "a missing scraper is not a feed error"

    @pytest.mark.asyncio
    async def test_feeds_that_carry_their_own_body_still_ingest(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """This is what keeps ingestion useful with the scraper off: Medium, Clarkesworld, Escape
        Pod and Strange Horizons syndicate the whole piece, and reddit self posts are their body."""
        monkeypatch.setattr(pipeline.enrich, "scraper_available", lambda: False)
        whole = " ".join(["word"] * (pipeline.INLINE_BODY_MIN_WORDS + 10))
        async with _client_serving(_json_feed(_item(1, content_text=whole))) as client:
            result = await pipeline.ingest_feed(_feed(), client=client, now=NOW)
        assert result.items_uploaded == 1
        assert result.items_deferred_no_scraper == 0

    def test_the_switch_and_the_missing_key_mean_the_same_thing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from writer_engine.config import get_settings

        monkeypatch.setenv("FIRECRAWL_API_KEY", "fc-test-key")
        monkeypatch.setenv("FIRECRAWL_ENABLED", "true")
        get_settings.cache_clear()
        assert enrich.scraper_available() is True

        monkeypatch.setenv("FIRECRAWL_ENABLED", "false")
        get_settings.cache_clear()
        assert enrich.scraper_available() is False

        monkeypatch.setenv("FIRECRAWL_ENABLED", "true")
        monkeypatch.setenv("FIRECRAWL_API_KEY", "")
        get_settings.cache_clear()
        assert enrich.scraper_available() is False
        get_settings.cache_clear()
