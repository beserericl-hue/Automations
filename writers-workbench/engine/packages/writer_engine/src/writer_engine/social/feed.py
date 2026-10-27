"""Feeding newsletter editions from the radars and from the posts that go out.

An edition subscribes by having a ``newsletter_feed_sources_v2`` row the ingestion cron never
fetches:

* ``url_type='radar'``, ``url='radar://trend'`` or ``'radar://dev'`` — each week's slate becomes
  that week's stories;
* ``url_type='social_queue'``, ``url='social://<source>'`` (``trend_batch``, ``roundup_batch``,
  ``manual``) or ``'social://all'`` — each post the publisher sends becomes a story, with the
  website link when there is one.

Each item is written as an ordinary ``content_ingestion_v2`` row whose key's source tag is the
edition id, so one item can feed two editions without colliding, and gather can tell an edition's
own rows apart from every other row of the same user (see gather_step's edition scoping).
"""

from __future__ import annotations

import html as html_lib
from datetime import UTC, date, datetime
from typing import Any

from writer_engine.ingestion import keys
from writer_engine.telemetry.logging import get_logger

logger = get_logger("social.feed")

FEEDS = "newsletter_feed_sources_v2"
ENGINE_URL_TYPES = ("radar", "social_queue")


def edition_tag(edition_id: str) -> str:
    """The key suffix that marks a row as written for this edition."""
    return keys.slugify_source(edition_id) or ""


async def editions_for(client: Any, user_id: str, urls: list[str]) -> list[str]:
    resp = await (
        client.table(FEEDS)
        .select("edition_id,url,url_type,active")
        .eq("user_id", user_id)
        .in_("url_type", list(ENGINE_URL_TYPES))
        .eq("active", True)
        .execute()
    )
    wanted = {u.lower() for u in urls}
    return sorted(
        {str(r["edition_id"]) for r in (resp.data or []) if str(r.get("url") or "").lower() in wanted}
    )


def _html(markdown: str) -> str:
    paras = [p.strip() for p in (markdown or "").split("\n\n") if p.strip()]
    return "".join(f"<p>{html_lib.escape(p)}</p>" for p in paras)


async def feed_item(
    *,
    user_id: str,
    edition_id: str,
    feed_url: str,
    title: str,
    markdown: str,
    source_name: str,
    source_url: str | None,
    day: date,
    image_urls: list[str] | None = None,
) -> str | None:
    """Write one story for one edition. Returns its key, or None when it already exists / has none."""
    from writer_engine.ingestion import store

    key = keys.build_key(title=title, source_name=edition_tag(edition_id), published=day.isoformat())
    if not key:
        return None
    if await store.existing_keys([key], user_id=user_id):
        return None
    await store.upload_item(
        key=key,
        user_id=user_id,
        item_type="article",
        title=title,
        authors=None,
        source_name=source_name or edition_id,
        source_url=source_url,
        markdown=markdown,
        html=_html(markdown),
        image_urls=image_urls or [],
        published_timestamp=datetime(day.year, day.month, day.day, 12, tzinfo=UTC).isoformat(),
        feed_url=feed_url,
    )
    return key


def _post_markdown(row: dict[str, Any], url: str | None) -> str:
    body = str(row.get("body_md") or "").strip() or str(row.get("linkedin_content") or "").strip()
    link = url or row.get("source_url")
    return f"{body}\n\n{link}".strip() if link and str(link) not in body else body


async def feed_posted_item(row: dict[str, Any], deliveries: dict[str, dict[str, Any]]) -> None:
    """The publisher's hook: a post that went out becomes a story for every edition that wants it."""
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    source = str(row.get("source") or "manual")
    urls = [f"social://{source}", "social://all"]
    editions = await editions_for(client, str(row["user_id"]), urls)
    if not editions:
        return
    website = next(
        (d.get("public_url") for c, d in deliveries.items() if c == "website" and d.get("public_url")), None
    )
    day = datetime.now(UTC).date()
    for edition_id in editions:
        await feed_item(
            user_id=str(row["user_id"]),
            edition_id=edition_id,
            feed_url=urls[0],
            title=str(row.get("title") or "Untitled"),
            markdown=_post_markdown(row, website),
            source_name="TechAhir" if website else str(row.get("category") or "Roundup").title(),
            source_url=website or row.get("source_url"),
            day=day,
        )


async def feed_radar_slate(
    client: Any, user_id: str, radar: str, topics: list[dict[str, Any]], day: date
) -> int:
    """A radar's new slate becomes this week's stories for every edition subscribed to it."""
    url = f"radar://{radar}"
    editions = await editions_for(client, user_id, [url])
    written = 0
    for edition_id in editions:
        for t in topics:
            angle = str(t.get("angle") or "").strip()
            summary = str(t.get("summary") or "").strip()
            markdown = "\n\n".join(
                p for p in (summary, angle and f"Why it matters: {angle}", t.get("url")) if p
            )
            key = await feed_item(
                user_id=user_id,
                edition_id=edition_id,
                feed_url=url,
                title=str(t.get("title") or "Untitled"),
                markdown=markdown,
                source_name=str(t.get("source") or radar),
                source_url=str(t.get("url") or "") or None,
                day=day,
            )
            written += 1 if key else 0
    return written


__all__ = ["edition_tag", "editions_for", "feed_item", "feed_posted_item", "feed_radar_slate"]
