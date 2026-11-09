"""Drafting in the studio: slate topics → drafts in review, revise with an instruction, regenerate.

The prompts are the radar ones (:mod:`writer_engine.radar.drafts`), so a studio draft is the same
artifact the batch path produced — Trend Radar: blog + LinkedIn article in the n8n delimited format;
Dev Radar: the short LinkedIn link post with the "comment 'newsletter'" CTA. The difference is where
it lands: ``state='draft'``, no day, no slot, tied to the edition — nothing is scheduled or posted
until someone decides to.
"""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import httpx

from writer_engine.config import get_settings
from writer_engine.llm import get_router
from writer_engine.radar import drafts as D
from writer_engine.social import channels as ch
from writer_engine.telemetry.logging import get_logger

from .core import EDITABLE, SCHEDULE, StudioEdition, StudioError, _rows, topics_by_id

logger = get_logger("studio.drafting")

ROUNDUP_BATCH = 12
"""Dev Radar topics per drafting call (one structured call drafts several posts)."""

REVISE_BLOG_SYSTEM = (
    "You are the editor of a TechAhir blog post and its LinkedIn article. Apply the editor's instruction "
    "to the draft and return the WHOLE revised piece. Keep every fact, figure, link and source as it is "
    "unless the instruction says otherwise; never invent facts. Keep the CTA link and the Sources line. "
    "The LinkedIn part must stay UNDER 2900 characters.\nOUTPUT FORMAT: PLAIN TEXT in EXACTLY this "
    "structure and nothing else:\nSEO_TITLE: <about 55 characters>\nTITLE: <headline>\nMETA: <about 155 "
    "characters>\nCATEGORY: <short label>\n===BLOG===\n<the blog in markdown>\n===LINKEDIN===\n<the "
    "LinkedIn article>\n===END==="
)

REVISE_POST_SYSTEM = (
    "You are the editor of a short LinkedIn post. Apply the editor's instruction and return ONLY the full "
    "revised post text — no preamble, no quotes, no commentary. Keep it UNDER 2900 characters. Keep the "
    "link line with the EXACT same URL, keep the call to action and the source credit unless the "
    "instruction says otherwise, and never invent facts."
)


def _external_id(ed: StudioEdition, topic: dict[str, Any]) -> str:
    week = str(topic.get("week_of") or "")[:10]
    return f"studio-{ed.radar}-{week}-r{topic.get('rank')}-{secrets.token_hex(3)}"


def draft_row(ed: StudioEdition, topic: dict[str, Any], post: dict[str, Any]) -> dict[str, Any]:
    title = str(post.get("title") or topic.get("title") or "Untitled").strip()[:500]
    return {
        "user_id": ed.user_id,
        "edition_id": ed.edition_id,
        "external_id": _external_id(ed, topic),
        "title": title,
        "body_md": str(post.get("body_md") or ""),
        "linkedin_content": str(post.get("linkedin_content") or ""),
        "seo_title": (str(post.get("seo_title") or "") or title)[:120],
        "meta_description": str(post.get("meta_description") or "")[:300],
        "category": (str(post.get("category") or "") or "INSIGHTS").upper()[:60],
        "include_image": bool(post.get("include_image", False)),
        "post_status": "published",
        "channels": list(ed.channels) or ["website"],
        "scheduled_date": None,
        "scheduled_at": None,
        "slot": "morning",
        "state": "draft",
        "source": "studio",
        "item_type": str(post.get("item_type") or "article"),
        "source_url": post.get("source_url") or topic.get("url") or None,
        "radar_topic_id": topic.get("id"),
        "studio": {
            "week_of": str(topic.get("week_of") or "")[:10],
            "rank": topic.get("rank"),
            "revisions": [],
        },
        **({"humanize": post["humanize"]} if isinstance(post.get("humanize"), dict) else {}),
    }


async def _existing_posts(
    client: Any, ed: StudioEdition, topic_ids: Sequence[str]
) -> dict[str, dict[str, Any]]:
    if not topic_ids:
        return {}
    rows = await _rows(
        client.table(SCHEDULE)
        .select("id,display_number,state,radar_topic_id")
        .eq("user_id", ed.user_id)
        .in_("radar_topic_id", list(topic_ids))
    )
    return {str(r["radar_topic_id"]): r for r in rows if r.get("state") != "cancelled"}


async def _draft_one_by_one(
    topics: Sequence[dict[str, Any]], router: Any, brand: dict[str, Any] | None = None
) -> list[tuple[dict[str, Any], dict[str, Any] | None, str]]:
    out: list[tuple[dict[str, Any], dict[str, Any] | None, str]] = []
    for t in topics:
        drafted, _failed = await D.draft_trend([t], router=router, brand=brand)
        if drafted:
            out.append((t, drafted[0], ""))
        else:
            out.append((t, None, "the model's reply had no blog in it (or the call failed)"))
    return out


async def _draft_roundup(
    topics: Sequence[dict[str, Any]], router: Any, brand: dict[str, Any] | None = None
) -> list[tuple[dict[str, Any], dict[str, Any] | None, str]]:
    out: list[tuple[dict[str, Any], dict[str, Any] | None, str]] = []
    for i in range(0, len(topics), ROUNDUP_BATCH):
        chunk = list(topics[i : i + ROUNDUP_BATCH])
        try:
            drafted, _ = await D.draft_roundup(chunk, router=router, brand=brand)
            error = "the draft came back empty or without the source link"
        except Exception as exc:  # noqa: BLE001 - one chunk's provider/parse failure is reported per topic, the rest go on
            logger.warning("studio.roundup_failed", error=f"{type(exc).__name__}: {exc}"[:200])
            drafted, error = [], f"{type(exc).__name__}: {exc}"[:200]
        by_topic = {str(d.get("radar_topic_id")): d for d in drafted}
        for t in chunk:
            d = by_topic.get(str(t.get("id")))
            out.append((t, d, "" if d else error))
    return out


async def generate(
    client: Any,
    ed: StudioEdition,
    topics: Sequence[dict[str, Any]],
    *,
    redo: bool = False,
    router: Any = None,
) -> dict[str, Any]:
    """Draft each topic into a ``draft`` post. A topic that already has a live post is skipped unless
    ``redo``. Each draft is saved as soon as it exists, so the studio shows them arriving."""
    router = router or get_router(service="studio")
    existing = await _existing_posts(client, ed, [str(t["id"]) for t in topics])
    skipped = [
        {
            "rank": t.get("rank"),
            "title": t.get("title"),
            "display_number": existing[str(t["id"])]["display_number"],
        }
        for t in topics
        if str(t["id"]) in existing and not redo
    ]
    todo = [t for t in topics if redo or str(t["id"]) not in existing]
    results = await (
        _draft_one_by_one(todo, router, ed.settings)
        if ed.radar == "trend"
        else _draft_roundup(todo, router, ed.settings)
    )
    drafted: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for topic, post, error in results:
        if post is None:
            failed.append({"rank": topic.get("rank"), "title": topic.get("title"), "error": error})
            continue
        await D.humanize_drafts([post])
        made = await _rows(client.table(SCHEDULE).insert(draft_row(ed, topic, post)))
        row = made[0] if made else {}
        drafted.append(
            {
                "id": row.get("id"),
                "display_number": row.get("display_number"),
                "rank": topic.get("rank"),
                "title": row.get("title"),
            }
        )
    parts = [
        f"Drafted {len(drafted)}"
        + (": " + ", ".join(f"#{d['display_number']} ({d['title']})" for d in drafted) if drafted else "")
    ]
    if skipped:
        parts.append(
            "already drafted: " + ", ".join(f"{s['rank']} (#{s['display_number']})" for s in skipped)
        )
    if failed:
        parts.append("failed: " + ", ".join(f"{f['rank']} ({f['error']})" for f in failed))
    return {
        "drafted": drafted,
        "skipped": skipped,
        "failed": failed,
        "message": "; ".join(parts) + ". Drafts wait for review; nothing is scheduled.",
    }


_TEXT_FIELDS = ("title", "body_md", "linkedin_content", "seo_title", "meta_description", "category")


def _previous(post: dict[str, Any]) -> dict[str, Any]:
    """The version an undo goes back to: the text, and the humanizer record that describes THAT text
    (a regenerate replaces it; without it, undo showed the redraft's "humanized" record on the old text)."""
    prev = {k: post.get(k) for k in _TEXT_FIELDS}
    prev["humanize"] = post.get("humanize")
    return prev


def _bookkeeping(post: dict[str, Any], what: str) -> dict[str, Any]:
    studio = dict(post.get("studio") or {})
    history = list(studio.get("revisions") or [])[-19:]
    history.append({"at": datetime.now(UTC).isoformat(), "what": what[:300]})
    studio["revisions"] = history
    studio["previous"] = _previous(post)
    return studio


async def _save(
    client: Any, ed: StudioEdition, post: dict[str, Any], patch: dict[str, Any]
) -> dict[str, Any]:
    rows = await _rows(
        client.table(SCHEDULE)
        .update(patch)
        .eq("id", str(post["id"]))
        .eq("user_id", ed.user_id)
        .in_("state", list(EDITABLE))
    )
    if not rows:
        raise StudioError("CONFLICT", f"#{post.get('display_number')} can no longer be changed")
    return rows[0]


async def revise(
    client: Any, ed: StudioEdition, post: dict[str, Any], instruction: str, *, router: Any = None
) -> dict[str, Any]:
    """Rewrite a draft to an instruction ("shorter", "punch up the hook", "more on pricing")."""
    if post.get("state") not in EDITABLE:
        raise StudioError("ALREADY_POSTED", f"#{post.get('display_number')} is {post.get('state')}")
    instruction = (instruction or "").strip()
    if not instruction:
        raise StudioError("VALIDATION", "Say how to revise it")
    settings = get_settings()
    router = router or get_router(service="studio")
    is_blog = bool(str(post.get("body_md") or "").strip())
    if is_blog:
        prompt = (
            f"INSTRUCTION: {instruction}\n\nCURRENT DRAFT:\nSEO_TITLE: {post.get('seo_title')}\nTITLE: "
            f"{post.get('title')}\nMETA: {post.get('meta_description')}\nCATEGORY: {post.get('category')}\n"
            f"===BLOG===\n{post.get('body_md')}\n===LINKEDIN===\n{post.get('linkedin_content')}\n===END==="
        )
        resp = await router.complete(
            provider="anthropic",
            model=settings.model_default,
            system=REVISE_BLOG_SYSTEM,
            prompt=prompt,
            max_tokens=8000,
            temperature=0.5,
        )
        parsed = D.parse_blog(resp.text or "")
        if parsed is None:
            raise StudioError(
                "REVISE_FAILED", "The revision came back in the wrong shape; the draft is unchanged"
            )
        patch: dict[str, Any] = {
            "title": (parsed["title"] or str(post.get("title")))[:500],
            "seo_title": (parsed["seo_title"] or str(post.get("seo_title") or ""))[:120],
            "meta_description": (parsed["meta_description"] or str(post.get("meta_description") or ""))[:300],
            "category": (parsed["category"] or str(post.get("category") or "INSIGHTS")).upper()[:60],
            "body_md": parsed["body_md"],
            "linkedin_content": parsed["linkedin_content"] or str(post.get("linkedin_content") or ""),
        }
    else:
        resp = await router.complete(
            provider="anthropic",
            model=settings.model_default,
            system=REVISE_POST_SYSTEM,
            prompt=f"INSTRUCTION: {instruction}\n\nCURRENT POST:\n{post.get('linkedin_content')}",
            max_tokens=2000,
            temperature=0.5,
        )
        text = (resp.text or "").strip().strip('"').strip()
        if not text:
            raise StudioError("REVISE_FAILED", "The revision came back empty; the draft is unchanged")
        url = str(post.get("source_url") or "")
        if url and url in str(post.get("linkedin_content") or "") and url not in text:
            raise StudioError("REVISE_FAILED", "The revision dropped the source link; the draft is unchanged")
        patch = {"linkedin_content": text}
    if len(str(patch.get("linkedin_content") or "")) > D.LINKEDIN_CHAR_LIMIT:
        raise StudioError(
            "REVISE_FAILED", "The revised LinkedIn text is over 3,000 characters; the draft is unchanged"
        )
    # The rewrite is the model's text, not the humanizer's: the old record would label it "humanized".
    # It is kept in studio.previous, so an undo brings it back with the text it describes.
    patch["humanize"] = None
    patch["studio"] = _bookkeeping(post, f"revise: {instruction}")
    row = await _save(client, ed, post, patch)
    return {
        "post": {"id": row.get("id"), "display_number": row.get("display_number"), "title": row.get("title")},
        "message": f"Revised #{row.get('display_number')} ({instruction[:80]}).",
    }


async def regenerate(
    client: Any, ed: StudioEdition, post: dict[str, Any], *, router: Any = None
) -> dict[str, Any]:
    """Draft the post again from its slate topic, replacing the text (the old text is kept as ``previous``)."""
    if post.get("state") not in EDITABLE:
        raise StudioError("ALREADY_POSTED", f"#{post.get('display_number')} is {post.get('state')}")
    topics = await topics_by_id(client, ed, [str(post.get("radar_topic_id") or "")])
    if not topics:
        raise StudioError("NO_TOPIC", f"#{post.get('display_number')} has no slate topic to draft from")
    router = router or get_router(service="studio")
    results = await (
        _draft_one_by_one(topics, router, ed.settings)
        if ed.radar == "trend"
        else _draft_roundup(topics, router, ed.settings)
    )
    _topic, fresh, error = results[0]
    if fresh is None:
        raise StudioError("REGENERATE_FAILED", f"Could not redraft #{post.get('display_number')}: {error}")
    await D.humanize_drafts([fresh])
    patch = {k: fresh.get(k) for k in _TEXT_FIELDS if fresh.get(k) is not None}
    patch["category"] = str(patch.get("category") or "INSIGHTS").upper()[:60]
    patch["studio"] = _bookkeeping(post, "regenerate")
    patch["humanize"] = fresh["humanize"] if isinstance(fresh.get("humanize"), dict) else None
    row = await _save(client, ed, post, patch)
    return {
        "post": {"id": row.get("id"), "display_number": row.get("display_number"), "title": row.get("title")},
        "message": f"Redrafted #{row.get('display_number')} from its topic.",
    }


async def restore_previous(client: Any, ed: StudioEdition, post: dict[str, Any]) -> dict[str, Any]:
    """Undo the last revise / regenerate."""
    prev = (post.get("studio") or {}).get("previous")
    if not isinstance(prev, dict):
        raise StudioError("NOTHING_TO_UNDO", f"#{post.get('display_number')} has no earlier version")
    patch: dict[str, Any] = {k: v for k, v in prev.items() if k in _TEXT_FIELDS and v is not None}
    if "humanize" in prev:  # versions saved before the record was kept leave it alone
        patch["humanize"] = prev["humanize"]
    patch["studio"] = _bookkeeping(post, "undo")
    row = await _save(client, ed, post, patch)
    return {
        "post": {"id": row.get("id"), "display_number": row.get("display_number")},
        "message": f"Restored #{row.get('display_number')}.",
    }


async def make_image(
    client: Any, ed: StudioEdition, post: dict[str, Any], *, make: Any = None
) -> dict[str, Any]:
    """Make the post's sketchnote now, so it can be seen before it is approved.

    The same prompt and generator the publisher uses, saved as the post's chosen ``image_url`` (the
    publisher posts a chosen image as it is, so what was reviewed is what goes out). The text and its
    undo history are not touched. ``make`` lets tests stand in for the image service.
    """
    if post.get("state") not in EDITABLE:
        raise StudioError("ALREADY_POSTED", f"#{post.get('display_number')} is {post.get('state')}")
    key = get_settings().kieai_api_key
    if make is None and not key:
        raise StudioError("NO_IMAGE_KEY", "Image generation is not set up (KIEAI_API_KEY)")
    context = str(post.get("body_md") or "").strip() or str(post.get("linkedin_content") or "")
    prompt = ch.sketchnote_prompt(str(post.get("title") or ""), context)
    if make is not None:
        made = await make(prompt)
    else:
        async with httpx.AsyncClient() as http:
            made = await ch.kie_sketchnote(http, prompt, api_key=key, sleep=asyncio.sleep)
    if made is None:
        raise StudioError(
            "IMAGE_FAILED", f"Could not make an image for #{post.get('display_number')}; try again"
        )
    url = str(made[2])
    studio = dict(post.get("studio") or {})
    history = list(studio.get("revisions") or [])[-19:]
    history.append({"at": datetime.now(UTC).isoformat(), "what": "make image"})
    studio["revisions"] = history
    row = await _save(client, ed, post, {"image_url": url, "include_image": True, "studio": studio})
    return {
        "post": {"id": row.get("id"), "display_number": row.get("display_number"), "title": row.get("title")},
        "message": f"Made the image for #{row.get('display_number')}.",
    }
