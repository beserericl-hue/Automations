"""Default sources of the two radars, verbatim from the n8n Code nodes.

A subscription can override any of these in ``radar_subscriptions_v2.settings`` (``feeds``,
``youtube_queries``, ``hn_queries``); these are what the n8n workflows used on 2026-10-27.
"""

from __future__ import annotations

# Trend Radar (q1yDjiztjdGRDblT) `Build Feed List`: (source label, feed URL).
TREND_FEEDS: tuple[tuple[str, str], ...] = (
    ("TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/"),
    ("Hugging Face", "https://huggingface.co/blog/feed.xml"),
    ("InfoQ", "https://feed.infoq.com/"),
    ("The GitHub Blog", "https://github.blog/feed/"),
    ("TechCrunch Startups", "https://techcrunch.com/category/startups/feed/"),
    ("TechCrunch Venture", "https://techcrunch.com/category/venture/feed/"),
    ("Crunchbase News", "https://news.crunchbase.com/feed/"),
    ("Hacker News: Show HN", "https://hnrss.org/show"),
    ("Product Hunt", "https://www.producthunt.com/feed"),
    ("Lenny's Newsletter", "https://www.lennysnewsletter.com/feed"),
    ("Y Combinator", "https://www.ycombinator.com/blog/rss"),
    ("SaaStr", "https://www.saastr.com/feed/"),
    ("Tomasz Tunguz", "https://tomtunguz.com/index.xml"),
    ("The Generalist", "https://www.generalist.com/feed"),
    ("Not Boring", "https://www.notboring.co/feed"),
)

# Dev Radar (czBKvhON08FzFydK) `RSS Feeds`, `YT Queries`, `HN Queries`.
DEV_FEEDS: tuple[str, ...] = (
    "https://github.blog/feed/",
    "https://github.blog/changelog/feed/",
    "https://openai.com/news/rss.xml",
    "https://feed.infoq.com/",
    "https://simonwillison.net/atom/everything/",
    "https://www.latent.space/feed",
    "https://www.interconnects.ai/feed",
    "https://addyosmani.com/rss.xml",
    "https://newsletter.kentbeck.com/feed",
    "https://martinfowler.com/feed.atom",
    "https://newsletter.pragmaticengineer.com/feed",
    "https://thenewstack.io/feed/",
    "https://www.theregister.com/software/headlines.atom",
    "https://feeds.arstechnica.com/arstechnica/technology-lab",
    "https://lobste.rs/t/ai.rss",
)

YOUTUBE_QUERIES: tuple[str, ...] = (
    "Claude Code tutorial",
    "Cursor AI coding",
    "AI coding agents",
    "Codex agent coding",
    "MCP model context protocol",
    "AGENTS.md AI coding",
    "AI software engineering",
    "vibe coding app",
)

HN_QUERIES: tuple[str, ...] = (
    "Claude Code",
    "Cursor",
    "Codex",
    "GitHub Copilot",
    "coding agent",
    "AI coding",
    "agentic",
    "MCP server",
    "context engineering",
    "AI software engineering",
)
