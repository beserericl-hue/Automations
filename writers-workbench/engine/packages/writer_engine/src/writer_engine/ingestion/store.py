"""Reading the feed list and writing ingested items (E1).

This is the half of ingestion that used to be three HTTP calls into the Express server —
``GET /api/newsletter/cron/feeds/due``, ``GET /api/ingestion/search``, ``POST /api/ingestion/upload``
— all guarded by ``X-Ingestion-Secret`` and all called from n8n.

The engine writes Supabase directly instead, for the same reason ``gather_step`` already *reads*
``content_ingestion_v2`` directly: ingestion is background work on a 30-minute timer, and routing it
through the web service would make a Workbench redeploy a gap in the corpus. The cost of that choice
is that the conventions the Express route enforced are no longer enforced by it, so they are
re-stated here and pinned by ``tests/test_ingestion_store.py``:

* blobs live at ``<key>.md`` and ``<key>.html`` in the ``newsletter-ingestion`` bucket
* content types are exactly ``text/markdown`` and ``text/html`` — the bucket's
  ``allowed_mime_types`` is a strict string match, so appending ``; charset=utf-8`` is rejected
* the row is an **upsert on ``key``** with ``deleted_at`` reset, so a re-ingest heals a soft delete
* a failed row write removes the blobs it just uploaded, so the bucket cannot accumulate content
  no metadata row can reach

The Express routes stay where they are: the Workbench UI reads through ``/api/ingestion/mine`` and
n8n's PROD workflows still upload through ``/upload`` until the PROD cutover.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from writer_engine.telemetry.logging import get_logger

logger = get_logger("ingestion.store")

BUCKET = "newsletter-ingestion"
TABLE = "content_ingestion_v2"
FEEDS_TABLE = "newsletter_feed_sources_v2"
RUNS_TABLE = "newsletter_ingestion_runs_v2"

FEED_COLUMNS = (
    "id,user_id,edition_id,name,url,url_type,item_type,active,fetch_interval_minutes,last_fetched_at"
)
"""``item_type`` arrives with migration 029 — see ``pipeline.feed_item_type`` for why it has to
exist. Selecting a column PostgREST does not know is a 400, so a deployment order of engine-before-
migration would break every tick; ``claim_due_feeds`` therefore retries once without it."""

FEED_COLUMNS_PRE_029 = FEED_COLUMNS.replace("item_type,", "")


@dataclass
class FeedSource:
    """One row of ``newsletter_feed_sources_v2``."""

    id: str
    user_id: str
    edition_id: str
    name: str
    url: str
    url_type: str
    fetch_interval_minutes: int = 240
    item_type: str = ""

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> FeedSource:
        return cls(
            id=str(row.get("id") or ""),
            user_id=str(row.get("user_id") or ""),
            edition_id=str(row.get("edition_id") or ""),
            name=str(row.get("name") or ""),
            url=str(row.get("url") or ""),
            url_type=str(row.get("url_type") or "rss"),
            fetch_interval_minutes=int(row.get("fetch_interval_minutes") or 240),
            item_type=str(row.get("item_type") or ""),
        )


def _due(row: dict[str, Any], *, now: datetime) -> bool:
    """Has this feed's interval elapsed? A feed never fetched is due."""
    last = row.get("last_fetched_at")
    if not last:
        return True
    try:
        stamp = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
    except ValueError:
        return True
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=UTC)
    interval = int(row.get("fetch_interval_minutes") or 240)
    return (now - stamp).total_seconds() >= interval * 60


async def claim_due_feeds(*, limit: int = 100, now: datetime | None = None) -> list[FeedSource]:
    """Return the feeds whose interval has elapsed, stamping ``last_fetched_at`` to claim them.

    Same two-step read-then-claim as the Express ``/feeds/due`` route, and the same reason: the
    stamp is what stops two overlapping ticks from fetching the same feed twice. Claiming *before*
    the work means a crash mid-tick costs one interval rather than looping on the same feed.
    """
    from writer_engine.supabase.client import get_supabase_admin

    moment = now or datetime.now(UTC)
    client = await get_supabase_admin()

    async def _select(columns: str) -> list[dict[str, Any]]:
        resp = await (
            client.table(FEEDS_TABLE)
            .select(columns)
            .eq("active", True)
            .order("last_fetched_at", desc=False, nullsfirst=True)
            .limit(limit)
            .execute()
        )
        return list(getattr(resp, "data", None) or [])

    try:
        candidates = await _select(FEED_COLUMNS)
    except Exception as exc:
        # Engine deployed ahead of migration 029: fall back rather than stop ingesting.
        logger.warning("ingestion.item_type_column_missing", error=f"{type(exc).__name__}: {exc}"[:140])
        candidates = await _select(FEED_COLUMNS_PRE_029)

    rows = [r for r in candidates if _due(r, now=moment)]
    if not rows:
        return []

    ids = [str(r["id"]) for r in rows]
    try:
        await (
            client.table(FEEDS_TABLE).update({"last_fetched_at": moment.isoformat()}).in_("id", ids).execute()
        )
    except Exception as exc:
        # Refuse to proceed unclaimed: without the stamp the next tick picks the same feeds and
        # every feed gets fetched twice per interval, which is how a rate limit gets hit.
        logger.error("ingestion.claim_failed", count=len(ids), error=f"{type(exc).__name__}: {exc}"[:160])
        return []
    return [FeedSource.from_row(r) for r in rows]


async def get_feed(feed_id: str) -> FeedSource | None:
    """One feed by id — the path a manual ``/cron/ingestion`` kick for a single feed takes."""
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    try:
        resp = await client.table(FEEDS_TABLE).select(FEED_COLUMNS).eq("id", feed_id).limit(1).execute()
    except Exception:
        resp = (
            await client.table(FEEDS_TABLE).select(FEED_COLUMNS_PRE_029).eq("id", feed_id).limit(1).execute()
        )
    rows = getattr(resp, "data", None) or []
    return FeedSource.from_row(rows[0]) if rows else None


async def edition_genres(edition_ids: list[str]) -> dict[str, str]:
    """``edition_id -> genre`` for the editions these feeds belong to.

    The relevance gate needs it: the AI prompt ported from n8n rejects every post-apocalyptic
    fiction item in the ``wasteland-wire`` edition, because the baseline only ever polled the
    ai-news feeds. One query per tick, and an edition that cannot be read simply has no genre —
    which falls back to the verbatim AI prompt.
    """
    wanted = sorted({e for e in edition_ids if e})
    if not wanted:
        return {}
    from writer_engine.supabase.client import get_supabase_admin

    try:
        client = await get_supabase_admin()
        resp = await client.table("newsletter_editions_v2").select("id,genre").in_("id", wanted).execute()
    except Exception as exc:
        logger.warning("ingestion.edition_genres_failed", error=f"{type(exc).__name__}: {exc}"[:140])
        return {}
    return {str(r.get("id")): str(r.get("genre") or "") for r in (getattr(resp, "data", None) or [])}


async def existing_keys(keys: list[str], *, user_id: str) -> set[str]:
    """Which of these keys are already ingested?

    One query for the whole batch. n8n issued a ``/api/ingestion/search`` request **per item** —
    ~400 round trips a tick — and it is also where J6 surfaced: an empty key made the search 400 and
    took the execution down. Here an empty key simply is not in the set.
    """
    wanted = [k for k in keys if k]
    if not wanted:
        return set()
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    found: set[str] = set()
    # PostgREST caps a response at 1000 rows and a URL has a practical length limit, so chunk the
    # `in` list rather than assuming one request covers a busy feed.
    for start in range(0, len(wanted), 200):
        chunk = wanted[start : start + 200]
        resp = await (
            client.table(TABLE)
            .select("key")
            .in_("key", chunk)
            .eq("user_id", user_id)
            .is_("deleted_at", "null")
            .execute()
        )
        found |= {str(r.get("key")) for r in (getattr(resp, "data", None) or [])}
    return found


async def upload_item(
    *,
    key: str,
    user_id: str,
    item_type: str,
    title: str | None,
    authors: str | None,
    source_name: str,
    source_url: str | None,
    markdown: str,
    html: str,
    external_source_urls: list[str] | None = None,
    image_urls: list[str] | None = None,
    reddit_metadata: dict[str, Any] | None = None,
    published_timestamp: str | None = None,
    feed_url: str | None = None,
) -> None:
    """Write one ingested item: both blobs, then the metadata row. Raises on failure.

    Order matters. Blobs first, row last, and the row's failure path deletes the blobs — so the
    reachable state is always "row implies blobs", never "blobs with no row". The reverse order
    would leave a row pointing at storage paths that 404 for the renderer.
    """
    from writer_engine.storage.adapter import upload_text
    from writer_engine.supabase.client import get_supabase_admin

    md_path = f"{key}.md"
    html_path = f"{key}.html"

    uploaded: list[str] = []
    try:
        await upload_text(bucket=BUCKET, path=md_path, content=markdown, content_type="text/markdown")
        uploaded.append(md_path)
        await upload_text(bucket=BUCKET, path=html_path, content=html, content_type="text/html")
        uploaded.append(html_path)
    except Exception:
        await _remove_quietly(uploaded)
        raise

    client = await get_supabase_admin()
    row = {
        "key": key,
        "user_id": user_id,
        "type": item_type,
        "title": title or None,
        "authors": authors or None,
        "source_name": source_name,
        "source_url": source_url or None,
        "external_source_urls": external_source_urls or [],
        "image_urls": image_urls or [],
        "reddit_metadata": reddit_metadata or None,
        "published_timestamp": published_timestamp or None,
        "feed_url": feed_url or None,
        "storage_path_md": md_path,
        "storage_path_html": html_path,
        "deleted_at": None,
    }
    try:
        await client.table(TABLE).upsert(row, on_conflict="key").execute()
    except Exception:
        await _remove_quietly(uploaded)
        raise


async def _remove_quietly(paths: list[str]) -> None:
    if not paths:
        return
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        await client.storage.from_(BUCKET).remove(paths)
    except Exception as exc:
        # C4: an orphaned blob is a leak, not an outage — but it must not be invisible.
        logger.warning(
            "ingestion.orphan_cleanup_failed", paths=len(paths), error=f"{type(exc).__name__}: {exc}"[:140]
        )


async def record_run(
    *,
    feed: FeedSource,
    items_fetched: int,
    items_uploaded: int,
    items_skipped_existing: int,
    error_message: str | None = None,
    started_at: datetime | None = None,
) -> None:
    """Append the run log row and update the feed's ``last_item_count`` / ``last_error``.

    Best-effort: a feed that ingested fine but could not write its own log row should not be
    reported as failed. n8n's ``report_run`` posted a hardcoded ``{"items_uploaded": 1}``, which is
    why ``newsletter_ingestion_runs_v2`` holds exactly one row from 2026-04-29 and has told nobody
    anything since.
    """
    from writer_engine.supabase.client import get_supabase_admin

    try:
        client = await get_supabase_admin()
        await (
            client.table(RUNS_TABLE)
            .insert(
                {
                    "feed_source_id": feed.id,
                    "user_id": feed.user_id,
                    "edition_id": feed.edition_id,
                    "started_at": (started_at or datetime.now(UTC)).isoformat(),
                    "finished_at": datetime.now(UTC).isoformat(),
                    "items_fetched": items_fetched,
                    "items_uploaded": items_uploaded,
                    "items_skipped_existing": items_skipped_existing,
                    "error_message": error_message,
                }
            )
            .execute()
        )
        await (
            client.table(FEEDS_TABLE)
            .update({"last_item_count": items_uploaded, "last_error": error_message})
            .eq("id", feed.id)
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "ingestion.run_log_failed", feed=feed.name[:48], error=f"{type(exc).__name__}: {exc}"[:140]
        )


__all__ = [
    "BUCKET",
    "FEEDS_TABLE",
    "FEED_COLUMNS",
    "RUNS_TABLE",
    "TABLE",
    "FeedSource",
    "claim_due_feeds",
    "edition_genres",
    "existing_keys",
    "get_feed",
    "record_run",
    "upload_item",
]
