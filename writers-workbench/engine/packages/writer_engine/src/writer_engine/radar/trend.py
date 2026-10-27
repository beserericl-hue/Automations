"""Trend Radar: the weekly 24-topic slate for the TechAhir "AI & MVP" blog.

Port of n8n ``Content - Trend Radar (Workflow A)`` (q1yDjiztjdGRDblT): 15 founder/AI feeds ->
keyword shortlist (<=100, 14 days, <=20 per feed) -> Claude scores each item for "would this make an
idea-stage founder want a product built" -> merge same-story duplicates by topicKey -> 24 topics with
at least 16 demand triggers -> Claude writes a two-paragraph summary of each. The filters, prompts and
ranking rules are the n8n ones; only the plumbing changed.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from pydantic import BaseModel

from writer_engine.config import get_settings
from writer_engine.llm import complete_structured, get_router
from writer_engine.telemetry.logging import get_logger

logger = get_logger("radar.trend")

DAYS, PER_FEED_CAP, MAX_SHORTLIST = 14, 20, 100
SLATE_SIZE, DEMAND_MIN = 24, 16

INCLUDE_TERMS = (
    "artificial intelligence",
    " ai ",
    "ai-",
    "ai,",
    "openai",
    "anthropic",
    " llm",
    "gpt-",
    "gpt ",
    "genai",
    "generative",
    "machine learning",
    "deep learning",
    "neural",
    "transformer",
    "foundation model",
    "ai agent",
    "agentic",
    "copilot",
    " model ",
    "models ",
    "inference",
    "fine-tun",
    "mlops",
    "software",
    "developer",
    "devops",
    "programming",
    "framework",
    "sdk",
    "open source",
    "github",
    "coding",
    "no-code",
    "low-code",
    "mvp",
    "minimum viable product",
    "prototype",
    "startup",
    "founder",
    "entrepreneur",
    "seed round",
    "pre-seed",
    "series a",
    "series b",
    " vc ",
    "venture",
    "funding",
    "fundrais",
    "raise",
    "accelerator",
    "saas",
    "product launch",
    "launch",
    "show hn",
    "build in public",
    "indie hacker",
    "y combinator",
    "angel",
    "investor",
    "pitch",
    "traction",
)
FOUNDER_SOURCES = (
    "techcrunch startups",
    "techcrunch venture",
    "crunchbase",
    "product hunt",
    "lenny",
    "y combinator",
    "saastr",
    "tomasz tunguz",
    "the generalist",
    "not boring",
    "hacker news: show hn",
)

SCORING_SYSTEM = (
    "You are the content strategist for TechAhir. We build a full, sellable minimum viable product (MVP) in days "
    "for our ideal customer: an entrepreneur who has a product IDEA and is pitching angel/seed investors, and who "
    "has been told to 'come back when you have a product.' Our content's job is to GENERATE DEMAND for that service "
    "— to make idea-stage founders realize they need a real, demonstrable product (to show investors AND sell to "
    "customers) and that they can get one built fast.\n\n"
    "Score each item 0-100 for how strongly it triggers that demand and gives us a blog angle aimed at our ideal "
    "customer.\n"
    "Score TOP (90-100) — DEMAND TRIGGERS: investors/angels requiring a working product, traction, or revenue "
    "before funding; founders who raised seed/angel money AFTER shipping an MVP; 'you can build a real product in "
    "days/weeks with AI or no-code' stories; solo or non-technical founders shipping products; MVP/product launches "
    "and Demo Day/accelerator outcomes that hinge on having a product; what seed/angel investors want in 2026.\n"
    "Score HIGH (75-89): AI and software-engineering advances that make building a product faster, cheaper, or "
    "better (the 'how' behind our service), and notable fundraising/startup news with a clear builder takeaway.\n"
    "Score MEDIUM (45-74): broader startup, product, growth, or developer news with looser relevance.\n"
    "Score LOW (0-39) and mark off-topic: big-tech corporate or political news, pure research with no builder "
    "takeaway, crypto/web3 hype, generic listicles, hardware specs, and anything off-topic.\n\n"
    'For EACH item output an object with: i (item number), marketDriverScore (0-100), driverType (one of "demand '
    'trigger","startup funding","MVP/product launch","founder lessons","AI dev tool/agent","AI model/research",'
    '"software engineering","industry shift","off-topic"), clientRelevance (one of "MVP & startups","Fundraising",'
    '"AI advances","Software engineering","General","none"), demandTrigger (true if this story would make an '
    "idea-stage entrepreneur want a sellable product/MVP built to pitch investors, else false), blogAngle (one "
    "concise sentence framing the angle for an entrepreneur who needs a product to pitch investors — what changed "
    "and why they need a product NOW), topicKey (short kebab-case id of the underlying story; two articles on the "
    "SAME event share it), keep (true if it belongs on our blog else false).\n"
    "Return exactly one object per item. Output only the structured JSON, in this shape:\n"
    '{"scores": [{"i": 0, "marketDriverScore": 92, "driverType": "demand trigger", "clientRelevance": '
    '"MVP & startups", "demandTrigger": true, "blogAngle": "Why angels now expect a working product before '
    'they invest — and how to ship one fast", "topicKey": "angels-want-product-not-deck", "keep": true}]}'
)

SUMMARY_SYSTEM = (
    "You are a content editor for TechAhir, which builds a full, sellable MVP in days for entrepreneurs pitching "
    "angel/seed investors. For each article, write a clear, engaging summary of about TWO short paragraphs "
    "(120-170 words total) for an audience of idea-stage and early founders: paragraph 1 = what happened; "
    "paragraph 2 = why it matters for an entrepreneur who needs a real, demonstrable product to show investors "
    "and customers — the demand signal and what they should do now. Use plain professional prose, no marketing "
    "fluff, no title, and do not insert links. Separate the two paragraphs with a blank line. Return exactly one "
    "summary object per item, with i matching the ITEM number, in this shape:\n"
    '{"summaries": [{"i": 0, "summary": "First paragraph.\\n\\nSecond paragraph."}]}'
)


class Score(BaseModel):
    i: int
    marketDriverScore: int = 0
    driverType: str = "off-topic"
    clientRelevance: str = "none"
    demandTrigger: bool = False
    blogAngle: str = ""
    topicKey: str = ""
    keep: bool = False


class Scores(BaseModel):
    scores: list[Score]


class Summary(BaseModel):
    i: int
    summary: str


class Summaries(BaseModel):
    summaries: list[Summary]


@dataclass
class Item:
    source: str
    title: str
    link: str
    published: datetime | None
    summary: str = ""
    content: str = ""
    categories: str = ""
    guid: str = ""
    score: Score | None = None
    also_covered_by: list[str] = field(default_factory=list)
    summary2: str = ""


def _strip(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"&[a-z]+;", " ", re.sub(r"<[^>]+>", " ", html or ""))).strip()


def shortlist(items: Sequence[Item], now: datetime) -> list[Item]:
    """n8n `Filter Shortlist`: recent (or undated), <=20 newest per feed, relevant, <=100 newest overall."""
    cutoff = now - timedelta(days=DAYS)

    def ts(i: Item) -> datetime:
        return i.published or cutoff

    recent = sorted((i for i in items if i.published is None or i.published >= cutoff), key=ts, reverse=True)
    by_feed: dict[str, list[Item]] = {}
    for i in recent:
        by_feed.setdefault(i.source, []).append(i)
    capped = [i for group in by_feed.values() for i in group[:PER_FEED_CAP]]

    def relevant(i: Item) -> bool:
        if any(s in i.source.lower() for s in FOUNDER_SOURCES):
            return True
        hay = f" {i.title} {i.summary} {i.categories} ".lower()
        return any(t in hay for t in INCLUDE_TERMS)

    return sorted((i for i in capped if relevant(i)), key=ts, reverse=True)[:MAX_SHORTLIST]


def _norm_title(t: str) -> str:
    words = [w for w in re.sub(r"[^a-z0-9 ]", " ", (t or "").lower()).split() if len(w) > 3]
    return " ".join(words[:7])


def _is_demand(i: Item) -> bool:
    s = i.score or Score(i=0)
    if s.demandTrigger:
        return True
    dt, cr, sr = s.driverType.lower(), s.clientRelevance.lower(), i.source.lower()
    return (
        any(k in dt for k in ("demand", "mvp", "funding", "product launch", "founder"))
        or any(k in cr for k in ("mvp", "fundrais", "startup"))
        or any(k in sr for k in FOUNDER_SOURCES)
    )


def rank_and_slate(items: Sequence[Item]) -> list[Item]:
    """n8n `Rank & Slate`: keep, merge same-story duplicates, 24 with >=16 demand triggers first."""
    kept = [i for i in items if i.score and i.score.keep and i.score.driverType != "off-topic"]
    kept.sort(key=lambda i: i.score.marketDriverScore if i.score else 0, reverse=True)
    groups: dict[str, list[Item]] = {}
    for i in kept:
        key = (i.score.topicKey.strip().lower() if i.score else "") or _norm_title(i.title)
        groups.setdefault(key, []).append(i)
    reps: list[Item] = []
    for group in groups.values():
        rep = group[0]
        rep.also_covered_by = [g.source for g in group[1:]]
        reps.append(rep)
    reps.sort(key=lambda i: i.score.marketDriverScore if i.score else 0, reverse=True)
    picked: list[Item] = []
    seen: set[str] = set()
    for i in [r for r in reps if _is_demand(r)][:DEMAND_MIN]:
        picked.append(i)
        seen.add(i.guid)
    for i in reps:
        if len(picked) >= SLATE_SIZE:
            break
        if i.guid not in seen:
            picked.append(i)
            seen.add(i.guid)
    picked.sort(key=lambda i: i.score.marketDriverScore if i.score else 0, reverse=True)
    return picked[:SLATE_SIZE]


async def fetch(http: httpx.AsyncClient, feeds: Sequence[tuple[str, str]]) -> tuple[list[Item], list[str]]:
    from writer_engine.ingestion import feeds as feedlib
    from writer_engine.ingestion.keys import parse_published_date

    items: list[Item] = []
    errors: list[str] = []
    for label, url in feeds:
        try:
            entries = await feedlib.fetch_feed(url, url_type="rss", client=http)
        except Exception as exc:
            errors.append(f"{label}: {type(exc).__name__}: {exc}"[:200])
            continue
        for e in entries:
            published: datetime | None = None
            if e.published:
                d = parse_published_date(e.published, now=datetime.now(UTC))
                published = datetime(d.year, d.month, d.day, tzinfo=UTC)
            body = e.body_text or _strip(e.body_html)
            items.append(
                Item(
                    source=label,
                    title=e.title or "(no title)",
                    link=e.url,
                    published=published,
                    summary=body[:2000],
                    content=(e.body_html or body)[:10000],
                    guid=e.url or e.title,
                )
            )
    return items, errors


async def build_slate(
    http: httpx.AsyncClient, *, feeds: Sequence[tuple[str, str]], now: datetime
) -> tuple[list[Item], dict[str, Any]]:
    settings = get_settings()
    router = get_router(service="radar")
    raw, errors = await fetch(http, feeds)
    short = shortlist(raw, now)
    stats: dict[str, Any] = {"fetched": len(raw), "shortlisted": len(short), "feed_errors": errors}
    if not short:
        return [], stats

    def line(n: int, i: Item) -> str:
        gist = re.sub(r"\s+", " ", i.summary)[:120]
        return f"{n}. [{i.source}] {i.title}" + (f" — {gist}" if gist else "")

    lines = [line(n, i) for n, i in enumerate(short)]
    scores, _ = await complete_structured(
        router,
        provider="anthropic",
        model=settings.model_default,
        system=SCORING_SYSTEM,
        prompt=(
            f"Score these {len(short)} items. Return exactly {len(short)} objects (one per item; index i "
            f"matches the item number).\n\nITEMS:\n" + "\n".join(lines)
        ),
        schema=Scores,
        max_tokens=16000,
        temperature=0.2,
    )
    by_i = {s.i: s for s in scores.scores}
    for n, i in enumerate(short):
        i.score = by_i.get(n)
    slate = rank_and_slate(short)
    stats["scored"] = len(by_i)
    if slate:
        blocks = [
            f"ITEM {n}:\nTITLE: {i.title}\nSOURCE: {i.source}\nARTICLE: "
            + ((_strip(i.content) or _strip(i.summary) or "(no article body available)")[:3500])
            for n, i in enumerate(slate)
        ]
        sums, _ = await complete_structured(
            router,
            provider="anthropic",
            model=settings.model_default,
            system=SUMMARY_SYSTEM,
            prompt=(
                f"Write a 2-paragraph summary for each of the {len(slate)} articles below. Return exactly "
                f"{len(slate)} summary objects (i matches the ITEM number).\n\n" + "\n\n---\n\n".join(blocks)
            ),
            schema=Summaries,
            max_tokens=16000,
            temperature=0.4,
        )
        by_s = {s.i: s.summary for s in sums.summaries}
        for n, i in enumerate(slate):
            i.summary2 = by_s.get(n) or i.summary
    stats["slate"] = len(slate)
    return slate, stats


def topic_rows(slate: Sequence[Item]) -> list[dict[str, Any]]:
    return [
        {
            "rank": n + 1,
            "title": i.title[:500],
            "url": i.link,
            "source": i.source,
            "item_type": "article",
            "angle": (i.score.blogAngle if i.score else "")[:1000],
            "category": (i.score.driverType if i.score else ""),
            "driver_type": i.score.driverType if i.score else None,
            "client_relevance": i.score.clientRelevance if i.score else None,
            "score": i.score.marketDriverScore if i.score else None,
            "summary": i.summary2 or i.summary,
            "also_covered_by": i.also_covered_by,
            "published_at": i.published.isoformat() if i.published else None,
        }
        for n, i in enumerate(slate)
    ]
