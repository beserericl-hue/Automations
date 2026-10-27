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
from writer_engine.social import schedule as S
from writer_engine.telemetry.logging import get_logger

logger = get_logger("radar.drafts")

BLOG_SYSTEM = (
    "You are a senior content writer for TechAhir, which builds full, working, sellable MVPs for founders in days "
    "(not throwaway prototypes). Write publish-ready content that showcases expertise and promotes the rapid 3-day "
    "MVP service.\nOUTPUT FORMAT: output PLAIN TEXT in EXACTLY this structure and NOTHING else (no JSON, no code "
    "fences, no commentary before or after):\nSEO_TITLE: <about 55 characters>\nTITLE: <the blog headline>\nMETA: "
    "<about 155 characters>\nCATEGORY: <a short label like AI & DATA>\n===BLOG===\n<a 700-1100 word blog in "
    "markdown: intro, ## H2 and ### H3 sections, a Key Takeaways list, ending with a short CTA paragraph as the "
    "markdown link [Get your MVP built in 3 days](https://www.techahir.com/3day-minimum-viable-product-mvp), then a "
    "final Sources line citing the primary source URL>\n===LINKEDIN===\n<a 400-700 word ARTICLE-STYLE LinkedIn post "
    'UNDER 2900 characters: a strong hook, key insights (short subheads or bullets), THEN a "How TechAhir builds '
    'working, sellable products in days" section (speed WITH discipline / no vibe-coding; senior developers as '
    "project leaders and the human guardrail; virtually zero defects via customized-model QA), a takeaway, the SAME "
    "CTA markdown link, and 3-5 hashtags>\n===END===\nGround the piece in the provided research summary and cite the "
    "primary source. Do not fabricate facts, dates, figures, or quotes. Weave in the TechAhir positioning, "
    "especially on AI-announcement topics."
)

ROUNDUP_SYSTEM = (
    "You are the AI Dev Roundup social curator for TechAhir. You turn the week's best AI + software-development "
    "articles and YouTube videos into SHORT LinkedIn posts that (1) summarize the source in our own words, (2) link "
    "to the original, and (3) invite readers to comment 'newsletter' to subscribe to our weekly AI-for-developers "
    "roundup. This is SOCIAL-FIRST: the output is a LinkedIn post, not a blog.\n\n"
    "For EACH item draft ONE LinkedIn post using its title, source, url and angle. FORMAT:\n"
    "- A strong one-line hook.\n"
    "- 2-4 sentences summarizing IN OUR OWN WORDS what the article/video covers and why it matters to founders and "
    "developers. NEVER copy the source's wording — paraphrase, stay accurate and neutral.\n"
    "- A link line using the EXACT url given: use '🔗 Read:' for articles and '🎥 Watch:' for videos.\n"
    "- The CTA (REQUIRED on every post): a line inviting readers to comment 'newsletter' to subscribe, e.g. "
    "\"💬 Want these every week? Comment 'newsletter' and we'll add you to our AI-for-developers roundup.\"\n"
    "- 3-5 relevant hashtags.\n"
    "Keep each UNDER 2900 characters. Always credit the source by name. Do NOT reproduce the article body or the "
    "video transcript; a short quoted phrase is fine, paragraphs are not. Never mention images.\n"
    "Return exactly one post object per item, with i matching the item number, as this JSON object:\n"
    '{"posts": [{"i": 0, "content": "<the full post text>"}]}'
)

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
    topics: Sequence[dict[str, Any]], *, router: Any = None
) -> tuple[list[dict[str, Any]], int]:
    settings = get_settings()
    router = router or get_router(service="radar")
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
                system=BLOG_SYSTEM,
                prompt=user,
                max_tokens=8000,
                temperature=0.7,
            )
            parsed = parse_blog(resp.text or "")
        except Exception as exc:
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
    topics: Sequence[dict[str, Any]], *, router: Any = None
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
        system=ROUNDUP_SYSTEM,
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


async def schedule_slate(
    client: Any,
    *,
    user_id: str,
    radar: str,
    topics: Sequence[dict[str, Any]],
    channels: Sequence[str] | None,
    now: datetime,
    router: Any = None,
) -> dict[str, Any]:
    """Draft ``topics`` and put them on the calendar. Returns what was scheduled and what failed."""
    if radar == "trend":
        drafted, failed = await draft_trend(topics, router=router)
        chans = list(channels or TREND_CHANNELS)
        taken = await S.taken_slots(client, user_id, now.astimezone(S.ET).date())
        slots = S.next_slots(now, len(drafted), weekdays_only=False, taken=taken)
        source, prefix = "trend_batch", "batch"
    else:
        drafted, failed = await draft_roundup(topics, router=router)
        drafted = S.interleave(drafted)
        chans = list(channels or ROUNDUP_CHANNELS)
        start = (now.astimezone(S.ET) + timedelta(days=1)).date()
        taken = await S.taken_slots(client, user_id, start)
        slots = S.next_slots(now, len(drafted), weekdays_only=True, taken=taken, start=start)
        source, prefix = "roundup_batch", "roundup"
    rows = [
        S.row_for(user_id, {**post, "channels": chans}, day, slot, source=source, prefix=prefix)
        for post, (day, slot) in zip(drafted, slots, strict=False)
    ]
    added = await S.enqueue(client, rows)
    return {
        "scheduled": len(added),
        "drafted": len(drafted),
        "failed_drafts": failed,
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
