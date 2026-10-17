"""E1 — the write conventions the Express ``/api/ingestion/upload`` route used to own.

The engine writes Supabase Storage and ``content_ingestion_v2`` directly now, so the rules that
route enforced are no longer enforced by it. These tests are what keeps them true.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from conftest import FakeSupabase

from writer_engine.ingestion import store

NOW = datetime(2026, 10, 17, 18, 30, tzinfo=UTC)
KEY = "2026-10-17/a-real-headline.techcrunch"


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch, fake_supabase: FakeSupabase) -> FakeSupabase:
    """Point both Supabase entry points at the in-memory fake.

    Two targets, not one. ``store`` imports ``get_supabase_admin`` inside each function, so patching
    the client module reaches it. ``storage.adapter`` binds the name at module import — so without
    the second patch the first test to import the adapter would freeze ITS fake into the module and
    every later test in this file would silently write into a dead object.
    """

    async def _client() -> FakeSupabase:
        return fake_supabase

    import writer_engine.storage.adapter as adapter

    monkeypatch.setattr("writer_engine.supabase.client.get_supabase_admin", _client)
    monkeypatch.setattr(adapter, "get_supabase_admin", _client)
    return fake_supabase


def _feed_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": "feed-1",
        "user_id": "+14105914612",
        "edition_id": "ai-news",
        "name": "Google News (AI)",
        "url": "https://rss.app/feeds/v1.1/AkOariu1C7YyUUMv.json",
        "url_type": "rss",
        "item_type": "article",
        "active": True,
        "fetch_interval_minutes": 180,
        "last_fetched_at": None,
    }
    row.update(overrides)
    return row


class TestUploadItem:
    @pytest.mark.asyncio
    async def test_blob_paths_and_content_types(self, wired: FakeSupabase) -> None:
        """The bucket's ``allowed_mime_types`` is a strict string match — ``text/markdown``, not
        ``text/markdown; charset=utf-8``, which the Express route has a comment about because it
        was learned the hard way."""
        await store.upload_item(
            key=KEY,
            user_id="+14105914612",
            item_type="article",
            title="A real headline",
            authors="A. Writer",
            source_name="techcrunch",
            source_url="https://techcrunch.com/x",
            markdown="# Body",
            html="<h1>Body</h1>",
        )
        assert wired.paths(store.BUCKET) == {f"{KEY}.md", f"{KEY}.html"}
        md_opts = wired.objects[(store.BUCKET, f"{KEY}.md")][1]
        html_opts = wired.objects[(store.BUCKET, f"{KEY}.html")][1]
        assert md_opts["content-type"] == "text/markdown"
        assert html_opts["content-type"] == "text/html"
        assert md_opts["x-upsert"] == "true"

    @pytest.mark.asyncio
    async def test_row_records_the_storage_paths(self, wired: FakeSupabase) -> None:
        await store.upload_item(
            key=KEY,
            user_id="+14105914612",
            item_type="article",
            title="A real headline",
            authors=None,
            source_name="techcrunch",
            source_url=None,
            markdown="body",
            html="<p>body</p>",
            external_source_urls=["https://openai.com/announcement"],
            image_urls=["https://cdn.example/x.jpg"],
            published_timestamp="2026-10-17",
            feed_url="https://rss.app/feeds/v1.1/x.json",
        )
        row = wired.tables[store.TABLE][0]
        assert row["storage_path_md"] == f"{KEY}.md"
        assert row["storage_path_html"] == f"{KEY}.html"
        assert row["external_source_urls"] == ["https://openai.com/announcement"]
        assert row["deleted_at"] is None

    @pytest.mark.asyncio
    async def test_reingest_upserts_on_key_and_heals_a_soft_delete(self, wired: FakeSupabase) -> None:
        wired.tables[store.TABLE] = [
            {"key": KEY, "user_id": "+14105914612", "title": "stale", "deleted_at": "2026-10-01T00:00:00Z"}
        ]
        await store.upload_item(
            key=KEY,
            user_id="+14105914612",
            item_type="article",
            title="fresh",
            authors=None,
            source_name="techcrunch",
            source_url=None,
            markdown="body",
            html="<p>body</p>",
        )
        assert len(wired.tables[store.TABLE]) == 1
        assert wired.tables[store.TABLE][0]["title"] == "fresh"
        assert wired.tables[store.TABLE][0]["deleted_at"] is None

    @pytest.mark.asyncio
    async def test_row_failure_removes_the_blobs_it_just_wrote(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Otherwise the bucket accumulates content no metadata row can reach."""

        original = wired.table

        def exploding_table(name: str) -> object:
            if name == store.TABLE:
                raise RuntimeError("row write failed")
            return original(name)

        monkeypatch.setattr(wired, "table", exploding_table)
        with pytest.raises(RuntimeError):
            await store.upload_item(
                key=KEY,
                user_id="+14105914612",
                item_type="article",
                title="A real headline",
                authors=None,
                source_name="techcrunch",
                source_url=None,
                markdown="body",
                html="<p>body</p>",
            )
        assert wired.paths(store.BUCKET) == set()

    @pytest.mark.asyncio
    async def test_second_blob_failure_removes_the_first(self, wired: FakeSupabase) -> None:
        wired.fail_uploads.add(f"{KEY}.html")
        with pytest.raises(RuntimeError):
            await store.upload_item(
                key=KEY,
                user_id="+14105914612",
                item_type="article",
                title="A real headline",
                authors=None,
                source_name="techcrunch",
                source_url=None,
                markdown="body",
                html="<p>body</p>",
            )
        assert wired.paths(store.BUCKET) == set()
        assert wired.count(store.TABLE) == 0


class TestExistingKeys:
    @pytest.mark.asyncio
    async def test_one_query_covers_the_batch(self, wired: FakeSupabase) -> None:
        """n8n issued a ``/api/ingestion/search`` request per item — ~400 round trips a tick."""
        wired.tables[store.TABLE] = [
            {"key": "a", "user_id": "u", "deleted_at": None},
            {"key": "b", "user_id": "u", "deleted_at": None},
        ]
        assert await store.existing_keys(["a", "b", "c"], user_id="u") == {"a", "b"}

    @pytest.mark.asyncio
    async def test_soft_deleted_rows_do_not_block_a_reingest(self, wired: FakeSupabase) -> None:
        wired.tables[store.TABLE] = [{"key": "a", "user_id": "u", "deleted_at": "2026-01-01T00:00:00Z"}]
        assert await store.existing_keys(["a"], user_id="u") == set()

    @pytest.mark.asyncio
    async def test_another_users_rows_are_not_mine(self, wired: FakeSupabase) -> None:
        wired.tables[store.TABLE] = [{"key": "a", "user_id": "other", "deleted_at": None}]
        assert await store.existing_keys(["a"], user_id="u") == set()

    @pytest.mark.asyncio
    async def test_empty_input_makes_no_query(self, wired: FakeSupabase) -> None:
        assert await store.existing_keys([], user_id="u") == set()
        assert await store.existing_keys(["", None], user_id="u") == set()  # type: ignore[list-item]


class TestClaimDueFeeds:
    @pytest.mark.asyncio
    async def test_never_fetched_feed_is_due(self, wired: FakeSupabase) -> None:
        wired.tables[store.FEEDS_TABLE] = [_feed_row()]
        claimed = await store.claim_due_feeds(now=NOW)
        assert [f.name for f in claimed] == ["Google News (AI)"]
        assert claimed[0].item_type == "article"

    @pytest.mark.asyncio
    async def test_interval_not_elapsed_is_not_due(self, wired: FakeSupabase) -> None:
        wired.tables[store.FEEDS_TABLE] = [
            _feed_row(last_fetched_at=(NOW - timedelta(minutes=30)).isoformat())
        ]
        assert await store.claim_due_feeds(now=NOW) == []

    @pytest.mark.asyncio
    async def test_elapsed_interval_is_due(self, wired: FakeSupabase) -> None:
        wired.tables[store.FEEDS_TABLE] = [
            _feed_row(last_fetched_at=(NOW - timedelta(minutes=181)).isoformat())
        ]
        assert len(await store.claim_due_feeds(now=NOW)) == 1

    @pytest.mark.asyncio
    async def test_inactive_feed_is_skipped(self, wired: FakeSupabase) -> None:
        wired.tables[store.FEEDS_TABLE] = [_feed_row(active=False)]
        assert await store.claim_due_feeds(now=NOW) == []

    @pytest.mark.asyncio
    async def test_claiming_stamps_last_fetched_at(self, wired: FakeSupabase) -> None:
        """The stamp is what stops two overlapping ticks fetching the same feed twice."""
        wired.tables[store.FEEDS_TABLE] = [_feed_row()]
        await store.claim_due_feeds(now=NOW)
        assert wired.tables[store.FEEDS_TABLE][0]["last_fetched_at"] == NOW.isoformat()
        # Immediately after, nothing is due.
        assert await store.claim_due_feeds(now=NOW) == []

    @pytest.mark.asyncio
    async def test_unreadable_timestamp_is_treated_as_due(self, wired: FakeSupabase) -> None:
        wired.tables[store.FEEDS_TABLE] = [_feed_row(last_fetched_at="not a date")]
        assert len(await store.claim_due_feeds(now=NOW)) == 1

    @pytest.mark.asyncio
    async def test_a_failed_claim_yields_nothing(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Proceeding unclaimed would double-fetch every feed each interval."""
        wired.tables[store.FEEDS_TABLE] = [_feed_row()]

        async def failing_update(*_a: object, **_k: object) -> None:
            raise RuntimeError("update failed")

        real_table = wired.table

        def table(name: str) -> object:
            query = real_table(name)
            if name == store.FEEDS_TABLE:
                original_update = query.update

                def update(payload: object) -> object:
                    q = original_update(payload)
                    q.execute = failing_update  # type: ignore[method-assign]
                    return q

                query.update = update  # type: ignore[method-assign]
            return query

        monkeypatch.setattr(wired, "table", table)
        assert await store.claim_due_feeds(now=NOW) == []

    @pytest.mark.asyncio
    async def test_falls_back_when_item_type_column_is_absent(self, wired: FakeSupabase) -> None:
        """Engine deployed ahead of migration 029 must still ingest, not stop."""
        calls: list[str] = []
        real_table = wired.table

        def table(name: str) -> object:
            query = real_table(name)
            if name == store.FEEDS_TABLE:
                original_select = query.select

                def select(*cols: str, **kw: object) -> object:
                    calls.append(cols[0] if cols else "")
                    if cols and "item_type" in cols[0]:
                        raise RuntimeError('column "item_type" does not exist')
                    return original_select(*cols, **kw)

                query.select = select  # type: ignore[method-assign]
            return query

        wired.tables[store.FEEDS_TABLE] = [_feed_row()]
        wired.table = table  # type: ignore[method-assign]
        claimed = await store.claim_due_feeds(now=NOW)
        # The retry without item_type is what keeps ingestion alive; the fake returns whole rows so
        # the column's absence is asserted on the two selects, not on the parsed value.
        assert len(claimed) == 1
        assert [("item_type" in c) for c in calls] == [True, False]


class TestRecordRun:
    @pytest.mark.asyncio
    async def test_writes_the_real_counts(self, wired: FakeSupabase) -> None:
        """n8n's ``report_run`` posted a hardcoded ``{"items_uploaded": 1}``, which is why the runs
        table holds exactly one row from 2026-04-29."""
        wired.tables[store.FEEDS_TABLE] = [_feed_row()]
        feed = store.FeedSource.from_row(_feed_row())
        await store.record_run(
            feed=feed, items_fetched=12, items_uploaded=4, items_skipped_existing=8, started_at=NOW
        )
        run = wired.tables[store.RUNS_TABLE][0]
        assert (run["items_fetched"], run["items_uploaded"], run["items_skipped_existing"]) == (12, 4, 8)
        assert run["error_message"] is None
        assert wired.tables[store.FEEDS_TABLE][0]["last_item_count"] == 4

    @pytest.mark.asyncio
    async def test_error_lands_on_the_feed_row(self, wired: FakeSupabase) -> None:
        wired.tables[store.FEEDS_TABLE] = [_feed_row()]
        feed = store.FeedSource.from_row(_feed_row())
        await store.record_run(
            feed=feed,
            items_fetched=0,
            items_uploaded=0,
            items_skipped_existing=0,
            error_message="HTTPStatusError: 503",
        )
        assert wired.tables[store.FEEDS_TABLE][0]["last_error"] == "HTTPStatusError: 503"

    @pytest.mark.asyncio
    async def test_a_failed_log_write_does_not_raise(
        self, wired: FakeSupabase, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A feed that ingested fine but could not write its own log row is not a failed feed."""

        def exploding_table(_name: str) -> object:
            raise RuntimeError("postgrest down")

        monkeypatch.setattr(wired, "table", exploding_table)
        await store.record_run(
            feed=store.FeedSource.from_row(_feed_row()),
            items_fetched=1,
            items_uploaded=1,
            items_skipped_existing=0,
        )
