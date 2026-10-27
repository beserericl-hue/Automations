"""Dev Radar: the weekly AI + software-development slate (16 articles + 8 videos) for the roundup.

Port of n8n ``Dev Radar - Weekly AI+Dev Slate (ingestion)`` (czBKvhON08FzFydK). No LLM: YouTube
search (8 queries, needs YOUTUBE_API_KEY), Hacker News via Algolia (10 queries), 15 RSS feeds, and
the last 45 days of the video archive as a fallback when YouTube's quota runs out. ``select`` is the
n8n ``Select 24`` node: dedupe by URL and by title, HN points + 120 for a preferred domain, at most 3
articles per domain, 16 articles then 8 videos (fresh before archived, known channels first).

One n8n bug is fixed on purpose: URL de-duplication keeps the query string. n8n once stripped it and
collapsed every ``youtube.com/watch?v=…`` into one video.
"""

from __future__ import annotations

import html as html_lib
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from writer_engine.telemetry.logging import get_logger

logger = get_logger("radar.dev")

KW = re.compile(
    r"(claude|cursor|codex|copilot|agent|agentic|llm|gpt|ai coding|\bmcp\b|context engineering|prompt|vibe cod|"
    r"software engineer|dev tool|coding|programming|anthropic|openai|\bmodel\b|devin|skill)",
    re.IGNORECASE,
)
JUNK = re.compile(
    r"(make money|passive income|get rich|millionaire|side hustle|financial freedom|quit your job|dropship|"
    r"earn \$|earn money|earn cash|\$\d\d)",
    re.IGNORECASE,
)
BADHOST = re.compile(r"(x\.com|twitter\.com|t\.co|reddit\.com)$", re.IGNORECASE)
PREF = re.compile(
    r"(github\.blog|blog\.google|googleblog|developers\.openai\.com|(^|\.)openai\.com|anthropic\.com|claude\.com|"
    r"huggingface\.co|simonwillison\.net|latent\.space|interconnects\.ai|addyo\.substack\.com|addyosmani\.com|"
    r"kentbeck\.com|martinfowler\.com|infoq\.com|thenewstack\.io|pragmaticengineer|techcrunch\.com|"
    r"arstechnica\.com|theregister\.com|arxiv\.org|deeplearning\.ai|factory\.ai|devin\.ai|cognition\.com|"
    r"microsoft\.ai|mongodb\.com|playwright\.dev|sitepoint\.com|every\.to|artificialanalysis\.ai|monid\.ai|"
    r"(^|\.)z\.ai|agentfield\.ai|fireworks\.ai|augmentcode\.com)",
    re.IGNORECASE,
)
CHANNELS = (
    "cursor",
    "anthropic",
    "openai",
    "theo",
    "t3",
    "fireship",
    "theprimeagen",
    "indydevdan",
    "cole medin",
    "ai engineer",
    "matthew berman",
    "alejandro ao",
    "krish naik",
    "kodecloud",
    "google cloud",
    "cognition",
    "y combinator",
    "freecodecamp",
    "chris raroque",
    "owain lewis",
    "leon van zyl",
    "pragmatic",
    "lex fridman",
    "ibm technology",
    "syntax",
    "how i ai",
    "tina huang",
)
ARTICLES, VIDEOS, TOTAL, PER_DOMAIN, MIN_ARTICLES = 16, 8, 24, 3, 6


@dataclass(frozen=True)
class Candidate:
    title: str
    url: str
    source: str
    item_type: str  # 'article' | 'video'
    date: str = ""
    score: int = 0
    channel: str = ""
    archived: bool = False


def host_of(url: str) -> str:
    m = re.match(r"^https?://([^/]+)", url or "", re.IGNORECASE)
    return m.group(1).lower().removeprefix("www.") if m else ""


def _keep_title(title: str) -> bool:
    return bool(title) and bool(KW.search(title)) and not JUNK.search(title)


def parse_youtube(responses: Sequence[dict[str, Any]]) -> list[Candidate]:
    out: list[Candidate] = []
    seen: set[str] = set()
    for resp in responses:
        for v in resp.get("items") or []:
            vid = (v.get("id") or {}).get("videoId")
            if not vid or vid in seen:
                continue
            sn = v.get("snippet") or {}
            title = html_lib.unescape(sn.get("title") or "")
            if JUNK.search(title):
                continue
            seen.add(vid)
            channel = sn.get("channelTitle") or ""
            out.append(
                Candidate(
                    title,
                    f"https://www.youtube.com/watch?v={vid}",
                    f"{channel or 'YouTube'} (YouTube)",
                    "video",
                    sn.get("publishedAt") or "",
                    0,
                    channel,
                )
            )
    return out


def parse_hn(responses: Sequence[dict[str, Any]]) -> list[Candidate]:
    out: list[Candidate] = []
    seen: set[str] = set()
    for resp in responses:
        for h in resp.get("hits") or []:
            url, title = h.get("url"), h.get("title")
            if not url or not title or url in seen or not _keep_title(title):
                continue
            host = host_of(url)
            if BADHOST.search(host):
                continue
            seen.add(url)
            out.append(
                Candidate(
                    title, url, host or "web", "article", h.get("created_at") or "", int(h.get("points") or 0)
                )
            )
    return out


def select(candidates: Sequence[Candidate]) -> list[Candidate]:
    """n8n `Select 24`. Empty when fewer than 6 articles survive (keep last week's slate)."""
    ordered = sorted(candidates, key=lambda c: c.score, reverse=True)

    def norm(u: str) -> str:
        return re.sub(r"/+$", "", re.sub(r"#.*$", "", (u or "").lower()))

    def tnorm(t: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()

    seen_u: set[str] = set()
    seen_t: set[str] = set()
    uniq: list[Candidate] = []
    for c in ordered:
        if not c.url:
            continue
        k, tk = norm(c.url), tnorm(c.title)
        if k in seen_u or (tk and tk in seen_t):
            continue
        seen_u.add(k)
        if tk:
            seen_t.add(tk)
        uniq.append(c)

    articles = sorted(
        (c for c in uniq if c.item_type == "article"),
        key=lambda c: (c.score + (120 if PREF.search(c.source or "") else 0), c.date or ""),
        reverse=True,
    )
    if len(articles) < MIN_ARTICLES:
        return []

    def boost(c: Candidate) -> int:
        return 1 if any(x in (c.channel or c.source).lower() for x in CHANNELS) else 0

    videos = [c for c in uniq if c.item_type == "video"]
    videos.sort(key=lambda c: c.date or "", reverse=True)
    videos.sort(key=boost, reverse=True)
    videos.sort(key=lambda c: c.archived)

    per_domain: dict[str, int] = {}
    picked_articles: list[Candidate] = []
    for c in articles:
        d = (c.source or "").lower()
        if per_domain.get(d, 0) >= PER_DOMAIN:
            continue
        per_domain[d] = per_domain.get(d, 0) + 1
        picked_articles.append(c)
        if len(picked_articles) >= ARTICLES:
            break
    if len(picked_articles) < ARTICLES:
        chosen = {c.url for c in picked_articles}
        picked_articles += [c for c in articles if c.url not in chosen][: ARTICLES - len(picked_articles)]
    pick = picked_articles[:ARTICLES] + videos[:VIDEOS]
    if len(pick) < TOTAL:
        chosen = {c.url for c in pick}
        pick += [c for c in uniq if c.url not in chosen][: TOTAL - len(pick)]
    return pick[:TOTAL]


def category_for(title: str) -> str:
    s = (title or "").lower()
    if re.search(r"agent|autonomous", s):
        return "agents"
    if re.search(r"agents\.md|claude\.md|context|spec|prompt", s):
        return "spec-context"
    if re.search(r"claude code|cursor|codex|copilot|windsurf|replit|\btool", s):
        return "tools"
    if re.search(r"\bmodel|llm|gpt|benchmark", s):
        return "models"
    if re.search(r"tutorial|how to|\bbuild\b|guide|course", s):
        return "tutorial"
    return "general"


def angle_for(c: Candidate) -> str:
    if c.item_type == "video":
        return f"Video — {c.source or 'YouTube'}"
    return (
        f"Trending dev article ({c.score} pts on Hacker News)" if c.score else f"From {c.source or 'the web'}"
    )


def topic_rows(pick: Sequence[Candidate]) -> list[dict[str, Any]]:
    return [
        {
            "rank": n + 1,
            "title": c.title[:300],
            "url": c.url,
            "source": c.source[:120],
            "item_type": c.item_type,
            "angle": angle_for(c),
            "category": category_for(c.title),
            "score": c.score or None,
            "summary": "",
            "published_at": c.date or None,
        }
        for n, c in enumerate(pick)
    ]


async def gather(
    http: httpx.AsyncClient,
    *,
    feeds: Sequence[str],
    youtube_queries: Sequence[str],
    hn_queries: Sequence[str],
    youtube_key: str,
    archive: Sequence[dict[str, Any]],
    now: datetime,
) -> tuple[list[Candidate], list[Candidate], dict[str, Any]]:
    """Every candidate, plus the fresh videos to archive, plus counts. One source failing is counted, not fatal."""
    from writer_engine.ingestion import feeds as feedlib

    stats: dict[str, Any] = {"errors": []}
    yt: list[dict[str, Any]] = []
    if youtube_key:
        after = (now - timedelta(days=8)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        for q in youtube_queries:
            try:
                r = await http.get(
                    "https://www.googleapis.com/youtube/v3/search",
                    timeout=20.0,
                    params={
                        "part": "snippet",
                        "type": "video",
                        "order": "viewCount",
                        "maxResults": 8,
                        "relevanceLanguage": "en",
                        "q": q,
                        "publishedAfter": after,
                        "key": youtube_key,
                    },
                )
                if r.status_code < 400:
                    yt.append(r.json())
                else:
                    stats["errors"].append(f"youtube {q!r}: HTTP {r.status_code}")
            except Exception as exc:
                stats["errors"].append(f"youtube {q!r}: {type(exc).__name__}")
    else:
        stats["errors"].append("youtube: YOUTUBE_API_KEY not set (archive videos only)")
    videos = parse_youtube(yt)

    hn: list[dict[str, Any]] = []
    cutoff = int((now - timedelta(days=8)).timestamp())
    for q in hn_queries:
        try:
            r = await http.get(
                "https://hn.algolia.com/api/v1/search_by_date",
                timeout=20.0,
                params={
                    "tags": "story",
                    "query": q,
                    "numericFilters": f"created_at_i>{cutoff}",
                    "hitsPerPage": 30,
                },
            )
            if r.status_code < 400:
                hn.append(r.json())
        except Exception as exc:
            stats["errors"].append(f"hn {q!r}: {type(exc).__name__}")
    articles = parse_hn(hn)

    rss: list[Candidate] = []
    rss_cutoff = now - timedelta(days=14)
    seen: set[str] = set()
    for url in feeds:
        try:
            entries = await feedlib.fetch_feed(url, url_type="rss", client=http)
        except Exception as exc:
            stats["errors"].append(f"rss {url}: {type(exc).__name__}")
            continue
        for e in entries:
            title, link = (e.title or "").strip(), (e.url or "").strip()
            if not link or link in seen or not _keep_title(title):
                continue
            host = host_of(link)
            if not host or BADHOST.search(host):
                continue
            date_s = str(e.published or "")
            try:
                if date_s and datetime.fromisoformat(date_s.replace("Z", "+00:00")) < rss_cutoff:
                    continue
            except ValueError:
                pass
            seen.add(link)
            rss.append(Candidate(title[:300], link, host, "article", date_s))

    arch_cutoff = now - timedelta(days=45)
    archived: list[Candidate] = []
    for a in archive:
        pulled = str(a.get("pulled_at") or "")
        try:
            if pulled and datetime.fromisoformat(pulled.replace("Z", "+00:00")) < arch_cutoff:
                continue
        except ValueError:
            pass
        archived.append(
            Candidate(
                str(a.get("title") or ""),
                str(a.get("url") or ""),
                str(a.get("source") or ""),
                "video",
                str(a.get("published_at") or ""),
                0,
                str(a.get("channel") or ""),
                True,
            )
        )
    stats.update({"youtube": len(videos), "hn": len(articles), "rss": len(rss), "archive": len(archived)})
    fresh_urls = {v.url for v in videos}
    pool = videos + articles + rss + [replace(a) for a in archived if a.url not in fresh_urls]
    return pool, videos, stats


def archive_rows(user_id: str, videos: Sequence[Candidate], now: datetime) -> list[dict[str, Any]]:
    rows = []
    for v in videos:
        m = re.search(r"[?&]v=([^&]+)", v.url)
        rows.append(
            {
                "user_id": user_id,
                "video_id": m.group(1) if m else v.url,
                "title": v.title,
                "url": v.url,
                "source": v.source,
                "channel": v.channel,
                "published_at": v.date or None,
                "pulled_at": now.isoformat(),
            }
        )
    return rows
