"""Gate 4 — publishing content whose scheduled time has arrived.

Found by enumerating what the DEV n8n workflows do rather than from the inventory: the engine and
the Workbench could both SCHEDULE content, and the only thing that ever published it was n8n's
hourly ``17 Cron: Scheduled Publisher``. Turning n8n off without this leaves every scheduled post at
``status='scheduled'`` forever — no error, no failed job, just content that never goes out on the
date the user picked.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from conftest import FakeSupabase

from writer_engine import publisher

NOW = datetime(2026, 10, 17, 18, 30, tzinfo=UTC)


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch, fake_supabase: FakeSupabase) -> FakeSupabase:
    async def _client() -> FakeSupabase:
        return fake_supabase

    monkeypatch.setattr("writer_engine.supabase.client.get_supabase_admin", _client)
    return fake_supabase


def _row(rid: str, schedule_date: object, *, status: str = "scheduled", **extra: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": rid,
        "user_id": "+14105914612",
        "title": f"Post {rid}",
        "content_type": "blog_post",
        "status": status,
        "deleted_at": None,
        "metadata": {} if schedule_date is None else {"schedule_date": schedule_date},
    }
    row.update(extra)
    return row


class TestParseScheduleDate:
    def test_full_iso(self) -> None:
        assert publisher.parse_schedule_date("2026-10-17T09:00:00Z") == datetime(
            2026, 10, 17, 9, 0, tzinfo=UTC
        )

    def test_date_only_from_the_ui_picker(self) -> None:
        assert publisher.parse_schedule_date("2026-10-20") == datetime(2026, 10, 20, tzinfo=UTC)

    def test_naive_iso_is_treated_as_utc(self) -> None:
        assert publisher.parse_schedule_date("2026-10-17T09:00:00") == datetime(
            2026, 10, 17, 9, 0, tzinfo=UTC
        )

    def test_a_datetime_passes_through(self) -> None:
        assert publisher.parse_schedule_date(NOW) == NOW

    def test_junk_is_unreadable(self) -> None:
        assert publisher.parse_schedule_date("next tuesday") is None
        assert publisher.parse_schedule_date("") is None
        assert publisher.parse_schedule_date(None) is None


class TestFindDue:
    @pytest.mark.asyncio
    async def test_a_past_schedule_is_due(self, wired: FakeSupabase) -> None:
        wired.tables[publisher.TABLE] = [_row("a", "2026-10-17T09:00:00Z")]
        due, unreadable = await publisher.find_due(now=NOW)
        assert [d.content_id for d in due] == ["a"]
        assert unreadable == []

    @pytest.mark.asyncio
    async def test_a_future_schedule_is_not_due(self, wired: FakeSupabase) -> None:
        wired.tables[publisher.TABLE] = [_row("a", "2026-10-20T09:00:00Z")]
        due, _ = await publisher.find_due(now=NOW)
        assert due == []

    @pytest.mark.asyncio
    async def test_the_exact_moment_is_due(self, wired: FakeSupabase) -> None:
        wired.tables[publisher.TABLE] = [_row("a", NOW.isoformat())]
        due, _ = await publisher.find_due(now=NOW)
        assert len(due) == 1

    @pytest.mark.asyncio
    async def test_only_scheduled_rows_are_considered(self, wired: FakeSupabase) -> None:
        """A draft with a stale schedule_date must not be published."""
        wired.tables[publisher.TABLE] = [
            _row("draft", "2026-10-01T09:00:00Z", status="draft"),
            _row("published", "2026-10-01T09:00:00Z", status="published"),
            _row("due", "2026-10-01T09:00:00Z"),
        ]
        due, _ = await publisher.find_due(now=NOW)
        assert [d.content_id for d in due] == ["due"]

    @pytest.mark.asyncio
    async def test_a_deleted_row_is_not_published(self, wired: FakeSupabase) -> None:
        wired.tables[publisher.TABLE] = [
            _row("gone", "2026-10-01T09:00:00Z", deleted_at="2026-10-02T00:00:00Z")
        ]
        due, _ = await publisher.find_due(now=NOW)
        assert due == []

    @pytest.mark.asyncio
    async def test_scheduled_with_no_date_is_skipped_silently(self, wired: FakeSupabase) -> None:
        """Status says scheduled but nothing says when — it is not due for anything."""
        wired.tables[publisher.TABLE] = [_row("a", None)]
        due, unreadable = await publisher.find_due(now=NOW)
        assert due == [] and unreadable == []

    @pytest.mark.asyncio
    async def test_an_unreadable_date_is_reported_not_published(self, wired: FakeSupabase) -> None:
        """Fails CLOSED, like ``cadence.is_due``: publishing is outward-facing, so a late send is
        recoverable and a wrong one is not. But it must not be invisible either."""
        wired.tables[publisher.TABLE] = [_row("bad", "next tuesday")]
        due, unreadable = await publisher.find_due(now=NOW)
        assert due == []
        assert unreadable == ["bad"]

    @pytest.mark.asyncio
    async def test_oldest_first(self, wired: FakeSupabase) -> None:
        wired.tables[publisher.TABLE] = [
            _row("newer", "2026-10-17T10:00:00Z"),
            _row("older", "2026-10-15T10:00:00Z"),
        ]
        due, _ = await publisher.find_due(now=NOW)
        assert [d.content_id for d in due] == ["older", "newer"]

    @pytest.mark.asyncio
    async def test_the_per_tick_ceiling_applies(self, wired: FakeSupabase) -> None:
        """A bad bulk schedule or a clock jump should send a bounded number of emails."""
        wired.tables[publisher.TABLE] = [
            _row(f"r{i:03d}", (NOW - timedelta(days=1)).isoformat()) for i in range(120)
        ]
        due, _ = await publisher.find_due(now=NOW)
        assert len(due) == publisher.MAX_PER_TICK

    @pytest.mark.asyncio
    async def test_a_non_dict_metadata_does_not_crash(self, wired: FakeSupabase) -> None:
        wired.tables[publisher.TABLE] = [{**_row("a", None), "metadata": "not a dict"}]
        due, unreadable = await publisher.find_due(now=NOW)
        assert due == [] and unreadable == []


class TestPublishPayload:
    def test_it_targets_the_existing_publish_path(self) -> None:
        """Reuse, not a second implementation: ``library.lifecycle`` already owns the version
        snapshot, the status flip and the user's email."""
        item = publisher.DueItem(
            content_id="c-1",
            user_id="+1",
            title="Post",
            content_type="blog_post",
            schedule_date="2026-10-17T09:00:00Z",
        )
        body = publisher.publish_payload(item)
        assert body["op"] == "lifecycle"
        assert body["action"] == "publish"
        assert body["content_id"] == "c-1"
        assert body["auto_published"] is True
        assert body["scheduled_for"] == "2026-10-17T09:00:00Z"


class TestLifecycleAuditTrail:
    @pytest.mark.asyncio
    async def test_an_auto_publish_is_marked_and_keeps_its_schedule_date(
        self, monkeypatch: pytest.MonkeyPatch, fake_supabase: FakeSupabase
    ) -> None:
        """n8n DELETED ``metadata.schedule_date`` on publish, erasing the only record of what the
        user asked for — so afterwards nothing could tell a scheduled publish from a manual one, or
        show that it went out late."""
        from writer_engine.config import get_settings

        async def _client() -> FakeSupabase:
            return fake_supabase

        monkeypatch.setenv("SUPABASE_URL", "https://fake.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "fake-key")
        get_settings.cache_clear()
        monkeypatch.setattr("writer_engine.supabase.client.get_supabase_admin", _client)

        fake_supabase.tables["published_content_v2"] = [
            {
                **_row("c-1", "2026-10-17T09:00:00Z"),
                "content_text": "Body.",
                "project_id": None,
                "chapter_number": None,
            }
        ]

        from library_step.main import OPS

        item = publisher.DueItem(
            content_id="c-1",
            user_id="+14105914612",
            title="Post c-1",
            content_type="blog_post",
            schedule_date="2026-10-17T09:00:00Z",
        )
        await OPS["lifecycle"](publisher.publish_payload(item))
        get_settings.cache_clear()

        row = fake_supabase.tables["published_content_v2"][0]
        assert row["status"] == "published"
        assert row["published_at"]
        meta = row["metadata"]
        assert meta["auto_published"] is True
        assert meta["auto_published_at"]
        assert meta["scheduled_for"] == "2026-10-17T09:00:00Z"
        # The evidence of the original request survives.
        assert meta["schedule_date"] == "2026-10-17T09:00:00Z"
        # And the version snapshot n8n took is still taken.
        assert len(fake_supabase.tables.get("content_versions_v2") or []) == 1
