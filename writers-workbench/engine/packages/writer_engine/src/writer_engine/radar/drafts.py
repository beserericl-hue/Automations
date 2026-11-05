"""Drafting a radar slate into calendar posts ("schedule the week").

* **Trend Radar → TechAhir blog + LinkedIn**: the port of ``Batch - Generate & Schedule Week``
  (FaxRBqptjRfk8YuB). One Claude call per topic with the n8n prompt and its plain-text output format
  (SEO_TITLE / TITLE / META / CATEGORY / ===BLOG=== / ===LINKEDIN=== / ===END===), parsed the n8n
  way, into the next free 09:00/14:00 ET slots, weekends included, with a sketchnote image.
* **Dev Radar → LinkedIn link posts**: the batch path of ``Content - AI Dev Roundup (Social Studio)``
  with its post format (hook, our-words summary, 🔗 Read / 🎥 Watch link, the "comment 'newsletter'"
  CTA, hashtags, no image so the link preview unfurls), spread two per weekday from tomorrow with
  articles and videos alternating (``Sub - Schedule Roundup Batch``).

A failed draft is dropped and counted, as in n8n, but the count is returned instead of vanishing.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel

from writer_engine.config import get_settings
from writer_engine.llm import complete_structured, get_router
from writer_engine.radar.brand import DEFAULT_BRAND, blog_system, brand_of, roundup_system
from writer_engine.social import schedule as S
from writer_engine.telemetry.logging import get_logger

logger = get_logger("radar.drafts")

BLOG_SYSTEM = blog_system(DEFAULT_BRAND)
"""The TechAhir wording; ``draft_trend(..., settings=)`` builds the prompt for the subscription's brand."""
ROUNDUP_SYSTEM = roundup_system(DEFAULT_BRAND)

TREND_CHANNELS = ("website", "li_techahir", "li_agile", "li_personal")
ROUNDUP_CHANNELS = ("li_techahir", "li_agile", "li_personal")


def expand_selection(spec: str | Sequence[int] | None, ranks: Sequence[int]) -> list[int]:
    """ "1,3,5-7" / "all" / [2, 4] → ranks in order. Empty or "all" means every rank."""
    if isinstance(spec, (list, tuple)):
        wanted = [int(n) for n in spec]
    else:
        text = str(spec or "").strip()
        wanted = []
        if text and text.lower() != "all":
            for part in text.split(","):
                p = part.strip()
                m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", p)
                if m:
                    a, b = sorted((int(m.group(1)), int(m.group(2))))
                    wanted.extend(range(a, b + 1))
                elif p.isdigit():
                    wanted.append(int(p))
    available = set(ranks)
    out = [n for n in wanted if n in available] if wanted else sorted(available)
    return list(dict.fromkeys(out))


def parse_blog(text: str) -> dict[str, str] | None:
    """The n8n `Parse JSON` node (which parses the delimited text format)."""

    def grab(pattern: str) -> str:
        m = re.search(pattern, text, re.IGNORECASE)
        return m.group(1).strip() if m else ""

    seo = grab(r"SEO_TITLE:\s*(.+)")
    title = grab(r"(?:^|\n)\s*TITLE:\s*(.+)")
    meta = grab(r"META:\s*(.+)")
    category = grab(r"CATEGORY:\s*(.+)")
    m = re.search(r"===\s*BLOG\s*===\s*([\s\S]*?)\s*===\s*LINKEDIN\s*===", text, re.IGNORECASE)
    body = m.group(1).strip() if m else ""
    m = re.search(r"===\s*LINKEDIN\s*===\s*([\s\S]*?)\s*===\s*END\s*===", text, re.IGNORECASE)
    linkedin = m.group(1).strip() if m else ""
    if not linkedin:
        m = re.search(r"===\s*LINKEDIN\s*===\s*([\s\S]*)$", text, re.IGNORECASE)
        linkedin = re.sub(r"===\s*END\s*===", "", m.group(1), flags=re.IGNORECASE).strip() if m else ""
    if not body:
        m = re.search(r"===\s*BLOG\s*===\s*([\s\S]*?)(?:===\s*LINKEDIN\s*===|$)", text, re.IGNORECASE)
        body = m.group(1).strip() if m else ""
    if not body:
        return None
    return {
        "seo_title": seo,
        "title": title,
        "meta_description": meta,
        "category": category or "AI & DATA",
        "body_md": body,
        "linkedin_content": linkedin,
    }


class RoundupPost(BaseModel):
    i: int
    # Required, so a reply that names the field anything else fails validation and gets the repair
    # call. With a default of "" it validated as empty posts and every draft was dropped silently.
    content: str


class RoundupPosts(BaseModel):
    posts: list[RoundupPost]


async def draft_trend(
    topics: Sequence[dict[str, Any]], *, router: Any = None, brand: dict[str, Any] | None = None
) -> tuple[list[dict[str, Any]], int]:
    """``brand`` is the radar subscription's settings (its ``brand`` key names who is speaking)."""
    settings = get_settings()
    router = router or get_router(service="radar")
    system = blog_system(brand_of(brand))
    drafted: list[dict[str, Any]] = []
    failed = 0
    for t in topics:
        user = (
            f"Topic: {t.get('title')}\nAngle: {t.get('angle') or ''}\nResearch summary: {t.get('summary') or ''}\n"
            f"Primary source: {t.get('url') or t.get('source') or ''}\n\nWrite the blog and LinkedIn post now, in the "
            "exact output format."
        )
        try:
            resp = await router.complete(
                provider="anthropic",
                model=settings.model_default,
                system=system,
                prompt=user,
                max_tokens=8000,
                temperature=0.7,
            )
            parsed = parse_blog(resp.text or "")
        except Exception as exc:  # noqa: BLE001 - per-topic isolation: one draft's provider/parse failure is logged and the topic is kept undrafted
            logger.warning(
                "radar.draft_failed",
                topic=str(t.get("title"))[:80],
                error=f"{type(exc).__name__}: {exc}"[:200],
            )
            parsed = None
        if parsed is None:
            failed += 1
            continue
        parsed["title"] = parsed["title"] or str(t.get("title") or "Untitled")
        parsed["seo_title"] = parsed["seo_title"] or parsed["title"]
        drafted.append(
            {
                **parsed,
                "radar_topic_id": t.get("id"),
                "source_url": t.get("url"),
                "item_type": "blog",
                "include_image": True,
            }
        )
    return drafted, failed


async def draft_roundup(
    topics: Sequence[dict[str, Any]], *, router: Any = None, brand: dict[str, Any] | None = None
) -> tuple[list[dict[str, Any]], int]:
    settings = get_settings()
    router = router or get_router(service="radar")
    lines = [
        f"{n}. [{'VIDEO' if t.get('item_type') == 'video' else 'ARTICLE'}] {t.get('title')} — {t.get('source')} — "
        f"{t.get('angle') or ''} — url: {t.get('url')}"
        for n, t in enumerate(topics)
    ]
    out, _ = await complete_structured(
        router,
        provider="anthropic",
        model=settings.model_default,
        system=roundup_system(brand_of(brand)),
        prompt=f"Draft {len(topics)} LinkedIn posts, one per item.\n\nITEMS:\n" + "\n".join(lines),
        schema=RoundupPosts,
        max_tokens=16000,
        temperature=0.6,
    )
    by_i = {p.i: p.content.strip() for p in out.posts if p.content.strip()}
    drafted: list[dict[str, Any]] = []
    for n, t in enumerate(topics):
        content = by_i.get(n, "")
        # The link is the whole point of a roundup post; one without the exact URL is not posted.
        if not content or str(t.get("url") or "") not in content:
            continue
        is_video = t.get("item_type") == "video"
        drafted.append(
            {
                "title": str(t.get("title") or "Untitled")[:300],
                "linkedin_content": content,
                "body_md": "",
                "category": "VIDEO" if is_video else "ROUNDUP",
                "include_image": False,
                "item_type": "video" if is_video else "article",
                "radar_topic_id": t.get("id"),
                "source_url": t.get("url"),
            }
        )
    return drafted, len(topics) - len(drafted)


LINKEDIN_CHAR_LIMIT = 3000
"""LinkedIn's post limit. The drafting prompts ask for under 2900; a humanized rewrite that grows past
3000 cannot be posted, so it is rejected and the drafted text kept (humanize.humanize_capped)."""

_HUMANIZE_FIELDS = (
    ("body_md", "radar_blog", None),
    ("linkedin_content", "radar_linkedin", LINKEDIN_CHAR_LIMIT),
)


def _compact(report: dict[str, Any]) -> dict[str, Any]:
    keep = (
        "applied",
        "chunks",
        "humanized_chunks",
        "rejected",
        "retried",
        "words_spent",
        "charged_credits",
        "stopped_at_budget",
        "rejected_for_length",
        "skipped",
    )
    return {k: report.get(k) for k in keep if report.get(k) not in (None, {}, [])} | {
        "applied": bool(report.get("applied"))
    }


async def humanize_drafts(drafted: list[dict[str, Any]]) -> dict[str, Any] | None:
    """E6 for the radars: humanize each drafted post before it goes on the calendar.

    Non-fiction, so the same pass and guards as blog / social / newsletter: protected terms and
    links (a roundup post IS its link), structure + the collapse retry, LinkedIn's character cap, and
    the spend ceiling — HUMANIZE_MAX_WORDS_PER_RUN applies to the WHOLE slate here, not per post, so
    a 10-topic week cannot bill ten times the cap. Each post records its outcome under ``humanize``
    (stored in social_schedule_v2.humanize). Off with HUMANIZE_RADAR_DRAFTS=false. Returns a slate
    summary, or None when the pass did not run.
    """
    from writer_engine.humanize import humanize_capped

    settings = get_settings()
    if not settings.humanize_radar_drafts:
        return None
    ceiling = int(settings.humanize_max_words_per_run or 0)
    spent = 0
    ran = applied = 0
    for post in drafted:
        reports: dict[str, Any] = {}
        for field, content_type, limit in _HUMANIZE_FIELDS:
            text = str(post.get(field) or "")
            if not text.strip():
                continue
            left = None if ceiling <= 0 else max(0, ceiling - spent)
            new_text, report = await humanize_capped(
                text, content_type=content_type, char_limit=limit, budget_words=left
            )
            if report is None:
                continue
            spent += int(report.get("words_spent") or 0)
            post[field] = new_text
            reports[field] = _compact(report)
        if reports:
            ran += 1
            post_applied = any(r.get("applied") for r in reports.values())
            applied += int(post_applied)
            post["humanize"] = {"applied": post_applied, **reports}
    if not ran:
        return None
    logger.info("radar.humanized", posts=ran, applied=applied, words_spent=spent)
    return {"posts": ran, "applied": applied, "words_spent": spent}


async def schedule_slate(
    client: Any,
    *,
    user_id: str,
    radar: str,
    topics: Sequence[dict[str, Any]],
    channels: Sequence[str] | None,
    now: datetime,
    router: Any = None,
    brand: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Draft ``topics`` and put them on the calendar. Returns what was scheduled and what failed.
    ``brand`` is the radar subscription's settings (whose voice the drafts are in)."""
    if radar == "trend":
        drafted, failed = await draft_trend(topics, router=router, brand=brand)
        chans = list(channels or TREND_CHANNELS)
        taken = await S.taken_slots(client, user_id, now.astimezone(S.ET).date())
        slots = S.next_slots(now, len(drafted), weekdays_only=False, taken=taken)
        source, prefix = "trend_batch", "batch"
    else:
        drafted, failed = await draft_roundup(topics, router=router, brand=brand)
        drafted = S.interleave(drafted)
        chans = list(channels or ROUNDUP_CHANNELS)
        start = (now.astimezone(S.ET) + timedelta(days=1)).date()
        taken = await S.taken_slots(client, user_id, start)
        slots = S.next_slots(now, len(drafted), weekdays_only=True, taken=taken, start=start)
        source, prefix = "roundup_batch", "roundup"
    humanized = await humanize_drafts(drafted)
    rows = [
        S.row_for(user_id, {**post, "channels": chans}, day, slot, source=source, prefix=prefix)
        for post, (day, slot) in zip(drafted, slots, strict=False)
    ]
    added = await S.enqueue(client, rows)
    return {
        "scheduled": len(added),
        "drafted": len(drafted),
        "failed_drafts": failed,
        "humanize": humanized,
        "channels": chans,
        "schedule": [
            {
                "display_number": r.get("display_number"),
                "scheduled_date": r.get("scheduled_date"),
                "slot": r.get("slot"),
                "title": r.get("title"),
            }
            for r in added
        ],
    }
