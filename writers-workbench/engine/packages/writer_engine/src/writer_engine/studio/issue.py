"""The posts and topics chosen for an edition's next newsletter issue, and how the saga uses them.

An edition has at most one ``open`` selection (``newsletter_issue_selections_v2``). While it has items,
it is **authoritative**: the next newsletter run for the edition (the studio's Generate button, the
Generate page, or the cadence cron) does not gather the week's pool and does not ask the LLM to pick —
it writes one ``content_ingestion_v2`` story per chosen item (so segment / render read them like any
other story), hands exactly those to the stories approval gate in the chosen order, and locks the
selection to that run. The approval, subject, image, render and send steps are unchanged.

This replaces the n8n ``Dev Roundup - Weekly Digest Email`` (WiG2AmTTf6rUj6gS): the week's roundup is
now an ordinary edition issue made from the posts the owner chose.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any

from writer_engine.telemetry.logging import get_logger

from .core import SCHEDULE, TOPICS, StudioEdition, StudioError, _rows

logger = get_logger("studio.issue")

SELECTIONS = "newsletter_issue_selections_v2"
ITEMS = "newsletter_issue_items_v2"
MAX_ITEMS = 20
INGESTION_COLUMNS = "id,key,user_id,type,title,source_name,source_url,external_source_urls,image_urls,published_timestamp,feed_url"


async def open_selection(client: Any, ed: StudioEdition, *, create: bool = True) -> dict[str, Any] | None:
    rows = await _rows(
        client.table(SELECTIONS)
        .select("*")
        .eq("user_id", ed.user_id)
        .eq("edition_id", ed.edition_id)
        .eq("status", "open")
        .limit(1)
    )
    if rows or not create:
        return rows[0] if rows else None
    made = await _rows(
        client.table(SELECTIONS).insert(
            {"user_id": ed.user_id, "edition_id": ed.edition_id, "status": "open"}
        )
    )
    return made[0] if made else None


async def _items(client: Any, selection_id: str) -> list[dict[str, Any]]:
    rows = await _rows(client.table(ITEMS).select("*").eq("selection_id", selection_id).order("position"))
    return sorted(rows, key=lambda r: int(r.get("position") or 0))


async def view(client: Any, ed: StudioEdition, selection: dict[str, Any] | None = None) -> dict[str, Any]:
    """The open selection (or the given one) with each item's title, state and number."""
    sel = selection or await open_selection(client, ed, create=False)
    last_locked = await _rows(
        client.table(SELECTIONS)
        .select("id,status,execution_id,send_date,locked_at")
        .eq("user_id", ed.user_id)
        .eq("edition_id", ed.edition_id)
        .eq("status", "locked")
        .order("locked_at", desc=True)
        .limit(1)
    )
    if not sel:
        return {"selection": None, "items": [], "last_issue": last_locked[0] if last_locked else None}
    items = await _items(client, str(sel["id"]))
    post_ids = [str(i["schedule_id"]) for i in items if i.get("schedule_id")]
    topic_ids = [str(i["radar_topic_id"]) for i in items if i.get("radar_topic_id")]
    posts = {
        str(p["id"]): p
        for p in (
            await _rows(
                client.table(SCHEDULE)
                .select("id,display_number,title,state,source_url,item_type,scheduled_date")
                .eq("user_id", ed.user_id)
                .in_("id", post_ids)
            )
            if post_ids
            else []
        )
    }
    topics = {
        str(t["id"]): t
        for t in (
            await _rows(
                client.table(TOPICS)
                .select("id,rank,title,url,item_type,week_of,source")
                .eq("user_id", ed.user_id)
                .in_("id", topic_ids)
            )
            if topic_ids
            else []
        )
    }
    out = []
    for i in items:
        if i.get("kind") == "post":
            p = posts.get(str(i.get("schedule_id")), {})
            out.append(
                {
                    "position": i["position"],
                    "kind": "post",
                    "id": i.get("schedule_id"),
                    "display_number": p.get("display_number"),
                    "title": p.get("title"),
                    "state": p.get("state"),
                    "url": p.get("source_url"),
                }
            )
        else:
            t = topics.get(str(i.get("radar_topic_id")), {})
            out.append(
                {
                    "position": i["position"],
                    "kind": "topic",
                    "id": i.get("radar_topic_id"),
                    "rank": t.get("rank"),
                    "week_of": t.get("week_of"),
                    "title": t.get("title"),
                    "url": t.get("url"),
                }
            )
    return {"selection": sel, "items": out, "last_issue": last_locked[0] if last_locked else None}


async def _check_items(
    client: Any, ed: StudioEdition, items: Sequence[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Keep only the caller's own posts and topics — from ANY of their editions and radars, so a radar
    post can be featured in any of their newsletters (Eric, 2026-11-05). Never another user's."""
    post_ids = [str(i["id"]) for i in items if i.get("kind") == "post" and i.get("id")]
    topic_ids = [str(i["id"]) for i in items if i.get("kind") == "topic" and i.get("id")]
    own_posts = {
        str(p["id"]): p
        for p in (
            await _rows(
                client.table(SCHEDULE).select("id,state").eq("user_id", ed.user_id).in_("id", post_ids)
            )
            if post_ids
            else []
        )
    }
    own_topics = {
        str(t["id"])
        for t in (
            await _rows(client.table(TOPICS).select("id").eq("user_id", ed.user_id).in_("id", topic_ids))
            if topic_ids
            else []
        )
    }
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for i in items:
        kind, ident = str(i.get("kind")), str(i.get("id") or "")
        if (kind, ident) in seen:
            continue
        ok = (kind == "post" and ident in own_posts and own_posts[ident].get("state") != "cancelled") or (
            kind == "topic" and ident in own_topics
        )
        if not ok:
            raise StudioError("NOT_FOUND", f"Not one of your {kind}s: {ident}")
        seen.add((kind, ident))
        out.append({"kind": kind, "id": ident})
    if len(out) > MAX_ITEMS:
        raise StudioError("VALIDATION", f"An issue holds at most {MAX_ITEMS} stories")
    return out


async def set_items(client: Any, ed: StudioEdition, items: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Replace the open selection's items with ``items`` (``[{kind: post|topic, id}]``), in that order."""
    checked = await _check_items(client, ed, items)
    sel = await open_selection(client, ed)
    if sel is None:
        raise StudioError("CONFLICT", "Could not open a selection")
    await client.table(ITEMS).delete().eq("selection_id", str(sel["id"])).execute()
    for n, i in enumerate(checked, start=1):
        await (
            client.table(ITEMS)
            .insert(
                {
                    "selection_id": sel["id"],
                    "position": n,
                    "kind": i["kind"],
                    "schedule_id": i["id"] if i["kind"] == "post" else None,
                    "radar_topic_id": i["id"] if i["kind"] == "topic" else None,
                }
            )
            .execute()
        )
    await (
        client.table(SELECTIONS)
        .update({"updated_at": datetime.now(UTC).isoformat()})
        .eq("id", str(sel["id"]))
        .execute()
    )
    out = await view(client, ed, sel)
    out["message"] = f"The next issue has {len(checked)} stor{'y' if len(checked) == 1 else 'ies'}: " + (
        "; ".join(f"{i['position']}. {i['title']}" for i in out["items"]) or "none"
    )
    return out


async def add_items(client: Any, ed: StudioEdition, items: Sequence[dict[str, Any]]) -> dict[str, Any]:
    current = (await view(client, ed))["items"]
    merged = [{"kind": i["kind"], "id": str(i["id"])} for i in current]
    merged += [
        {"kind": i["kind"], "id": str(i["id"])}
        for i in items
        if {"kind": i["kind"], "id": str(i["id"])} not in merged
    ]
    return await set_items(client, ed, merged)


async def remove_items(client: Any, ed: StudioEdition, items: Sequence[dict[str, Any]]) -> dict[str, Any]:
    drop = {(i["kind"], str(i["id"])) for i in items}
    current = (await view(client, ed))["items"]
    return await set_items(
        client,
        ed,
        [{"kind": i["kind"], "id": str(i["id"])} for i in current if (i["kind"], str(i["id"])) not in drop],
    )


async def new_selection(client: Any, ed: StudioEdition) -> dict[str, Any]:
    """Start the next issue fresh: the open selection (if any) is abandoned, a new one opened."""
    await (
        client.table(SELECTIONS)
        .update({"status": "abandoned"})
        .eq("user_id", ed.user_id)
        .eq("edition_id", ed.edition_id)
        .eq("status", "open")
        .execute()
    )
    sel = await open_selection(client, ed)
    out = await view(client, ed, sel)
    out["message"] = "Started a new selection for the next issue."
    return out


async def items_for_spec(
    client: Any,
    ed: StudioEdition,
    *,
    ranks: Sequence[int] = (),
    numbers: Sequence[int] = (),
    week_of: str | None = None,
) -> list[dict[str, Any]]:
    """Slate ranks and post numbers → selection items. A ranked topic that already became a post in this
    edition is added as that post (its reviewed text), otherwise as the topic itself."""
    from .core import own_posts, topics_by_rank

    out: list[dict[str, Any]] = []
    if ranks:
        _week, topics = await topics_by_rank(client, ed, list(ranks), week_of)
        made = {
            str(p["radar_topic_id"]): p
            for p in (
                await _rows(
                    client.table(SCHEDULE)
                    .select("id,state,radar_topic_id")
                    .eq("user_id", ed.user_id)
                    .eq("edition_id", ed.edition_id)
                    .in_("radar_topic_id", [str(t["id"]) for t in topics])
                )
                if topics
                else []
            )
            if p.get("state") != "cancelled"
        }
        for t in topics:
            p = made.get(str(t["id"]))
            out.append({"kind": "post", "id": str(p["id"])} if p else {"kind": "topic", "id": str(t["id"])})
    if numbers:
        for p in await own_posts(client, ed, numbers=list(numbers)):
            out.append({"kind": "post", "id": str(p["id"])})
    return out


# --------------------------------------------------------------------------- the saga's side


def _topic_markdown(t: dict[str, Any]) -> str:
    angle = str(t.get("angle") or "").strip()
    summary = str(t.get("summary") or "").strip()
    return "\n\n".join(
        p for p in (summary, angle and f"Why it matters: {angle}", str(t.get("url") or "")) if p
    )


async def _website_url(client: Any, post_id: str) -> str | None:
    rows = await _rows(
        client.table("social_schedule_deliveries_v2").select("channel,public_url").eq("schedule_id", post_id)
    )
    return next(
        (str(r["public_url"]) for r in rows if r.get("public_url") and r.get("channel") == "website"), None
    )


async def _ensure_story(
    client: Any,
    *,
    user_id: str,
    edition_id: str,
    send_date: str,
    title: str,
    markdown: str,
    source_name: str,
    source_url: str | None,
    image_url: str | None = None,
) -> dict[str, Any] | None:
    """One content_ingestion_v2 story for this issue (written once; a rerun reuses it)."""
    from writer_engine.ingestion import keys, store
    from writer_engine.social.feed import _html, edition_tag

    key = keys.build_key(title=title, source_name=edition_tag(edition_id), published=send_date)
    if not key:
        return None
    if not await store.existing_keys([key], user_id=user_id):
        d = date.fromisoformat(send_date)
        await store.upload_item(
            key=key,
            user_id=user_id,
            item_type="article",
            title=title,
            authors=None,
            source_name=source_name or edition_id,
            source_url=source_url,
            # The post's chosen image is the story's picture: the image gate offers it.
            image_urls=[image_url] if image_url else None,
            markdown=markdown,
            html=_html(markdown),
            published_timestamp=datetime(d.year, d.month, d.day, 12, tzinfo=UTC).isoformat(),
            feed_url=f"studio://{edition_id}",
        )
    rows = await _rows(client.table("content_ingestion_v2").select(INGESTION_COLUMNS).eq("key", key).limit(1))
    return rows[0] if rows else None


async def take_selection(
    client: Any, *, user_id: str, edition_id: str, send_date: str, execution_id: str
) -> list[dict[str, Any]] | None:
    """The articles for a newsletter run when the edition has a chosen selection, else ``None``.

    Takes the edition's open selection (or the one this same run already locked, so a resumed run gets
    the same stories), writes a story per item, records each item's ingestion key, and locks the
    selection to the run. Raises when the selection exists but a story cannot be written: the owner
    chose these stories, so silently falling back to the LLM pick would publish something else.
    """
    if not (user_id and edition_id and send_date):
        return None
    sel_rows = await _rows(
        client.table(SELECTIONS)
        .select("*")
        .eq("user_id", user_id)
        .eq("edition_id", edition_id)
        .eq("execution_id", execution_id)
        .limit(1)
    ) or await _rows(
        client.table(SELECTIONS)
        .select("*")
        .eq("user_id", user_id)
        .eq("edition_id", edition_id)
        .eq("status", "open")
        .limit(1)
    )
    if not sel_rows:
        return None
    sel = sel_rows[0]
    items = await _items(client, str(sel["id"]))
    if not items:
        return None
    post_ids = [str(i["schedule_id"]) for i in items if i.get("schedule_id")]
    topic_ids = [str(i["radar_topic_id"]) for i in items if i.get("radar_topic_id")]
    posts = {
        str(p["id"]): p
        for p in (
            await _rows(client.table(SCHEDULE).select("*").eq("user_id", user_id).in_("id", post_ids))
            if post_ids
            else []
        )
    }
    topics = {
        str(t["id"]): t
        for t in (
            await _rows(client.table(TOPICS).select("*").eq("user_id", user_id).in_("id", topic_ids))
            if topic_ids
            else []
        )
    }
    from writer_engine.social.feed import _post_markdown

    articles: list[dict[str, Any]] = []
    for i in items:
        if i.get("kind") == "post":
            p = posts.get(str(i.get("schedule_id")))
            if not p:
                continue
            website = await _website_url(client, str(p["id"]))
            story = await _ensure_story(
                client,
                user_id=user_id,
                edition_id=edition_id,
                send_date=send_date,
                title=str(p.get("title") or "Untitled"),
                markdown=_post_markdown(p, website),
                source_name="TechAhir" if website else str(p.get("category") or "Roundup").title(),
                source_url=website or p.get("source_url"),
                image_url=str(p.get("image_url") or "") or None,
            )
        else:
            t = topics.get(str(i.get("radar_topic_id")))
            if not t:
                continue
            story = await _ensure_story(
                client,
                user_id=user_id,
                edition_id=edition_id,
                send_date=send_date,
                title=str(t.get("title") or "Untitled"),
                markdown=_topic_markdown(t),
                source_name=str(t.get("source") or "Radar"),
                source_url=str(t.get("url") or "") or None,
            )
        if story is None:
            raise StudioError("ISSUE_STORY_FAILED", f"Could not prepare chosen story {i.get('position')}")
        await client.table(ITEMS).update({"ingestion_key": story["key"]}).eq("id", str(i["id"])).execute()
        articles.append({**story, "markdown": None, "_summary": _summary_for(i, posts, topics)})
    if not articles:
        return None
    await (
        client.table(SELECTIONS)
        .update(
            {
                "status": "locked",
                "execution_id": execution_id,
                "send_date": send_date,
                "locked_at": datetime.now(UTC).isoformat(),
            }
        )
        .eq("id", str(sel["id"]))
        .execute()
    )
    logger.info(
        "studio.issue_locked", edition_id=edition_id, execution_id=execution_id, stories=len(articles)
    )
    return articles


def _plain(text: str, n: int) -> str:
    import re

    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text or "")
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"[#*_>`]+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:n]


def _summary_for(item: dict[str, Any], posts: dict[str, Any], topics: dict[str, Any]) -> str:
    if item.get("kind") == "post":
        p = posts.get(str(item.get("schedule_id"))) or {}
        return _plain(
            str(p.get("meta_description") or "")
            + " "
            + str(p.get("body_md") or p.get("linkedin_content") or ""),
            900,
        )
    t = topics.get(str(item.get("radar_topic_id"))) or {}
    return _plain(f"{t.get('summary') or ''} {t.get('angle') or ''}", 900)


def picked_from_selection(articles: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """The stories gate payload for a chosen selection: every article, in order, no LLM pick."""
    return {
        "top_selected_stories": [
            {
                "title": str(a.get("title") or "Untitled"),
                "summary": str(a.get("_summary") or a.get("title") or ""),
                "identifiers": [str(a["id"])],
                "external_source_links": [str(a["source_url"])] if a.get("source_url") else [],
            }
            for a in articles
        ],
        "chain_of_thought": "Chosen in the Content Studio: these stories, in this order (no automatic pick).",
    }
