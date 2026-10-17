"""Where did this item come from? (E1)

``content_ingestion_v2.source_name`` is the publisher label. It goes into the key, and the newsletter
shows it to the reader ("— TechCrunch"), so it wants to be the *publisher*, not the plumbing.

n8n answered this twice, differently:

* ``AI News Data Ingestion V2`` hardcoded a constant per feed node (``the-neuron``, ``blog-open-ai``)
  and, for the two aggregator feeds, mapped the item's own domain through :data:`DOMAIN_SOURCE_MAP`
  with a TLD-stripping fallback. The 3,926 rows in DEV were written this way — hence ``bbc``,
  ``yahoo-finance``, ``i-programmer``.
* ``DEV - Newsletter Ingestion (Multi-User Cron)`` slugged the feed *row name* for everything, so a
  Google News item would have been filed under ``google-news-ai`` rather than ``reuters``.

The second loses the publisher, which is the thing a reader recognises. But the first cannot be
ported literally, because the engine reads its feed list from ``newsletter_feed_sources_v2`` and
there are no per-feed code nodes to hardcode any more.

So the rule here derives it from the data instead of from config: **a feed whose items span
:data:`AGGREGATOR_DOMAIN_THRESHOLD` or more distinct domains is an aggregator**, and its items are
labelled by their own domain; a feed that keeps landing on one domain is a single publisher, and its
items are labelled by :func:`modal_domain`. Google News (41 domains in the map), Hacker News and the
Reddit link feeds fall on the first side; a vendor blog or a magazine on the second. No per-feed
configuration, and it stays right when someone adds a feed nobody wrote code for.

Two kinds of feed are labelled from the feed's **name** instead, because for them the name is the
publisher and the domain is not: a subreddit (every item is on reddit.com) and a competitor
newsletter (a newsletter is its brand — "The Neuron", not ``theneurondaily``). The ordering lives in
``pipeline._label_items``.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from writer_engine.ingestion.keys import slugify_source

AGGREGATOR_DOMAIN_THRESHOLD = 3
"""Distinct item domains at or above which a feed is treated as an aggregator.

Three, not two: a single-publisher feed routinely carries one syndicated or cross-posted item, and
at two that one item would flip the whole feed to domain labelling.
"""

# Ported verbatim from the `normalize_google_news_articles` code node. Not decoration: these are the
# labels already written into 3,926 rows, and the only way a new row joins the same history as an
# old one is to spell the publisher the same way.
DOMAIN_SOURCE_MAP: dict[str, str] = {
    "engadget.com": "engadget",
    "gizmodo.com": "gizmodo",
    "techcrunch.com": "techcrunch",
    "theverge.com": "the-verge",
    "cnbc.com": "cnbc",
    "forbes.com": "forbes",
    "tradingview.com": "trading-view",
    "economist.com": "economist",
    "tomshardware.com": "toms-hardware",
    "timesofindia.indiatimes.com": "times-of-india",
    "seekingalpha.com": "seeking-alpha",
    "fool.com": "the-motley-fool",
    "sherwood.news": "sherwood-news",
    "theregister.com": "the-register",
    "yahoo.com": "yahoo",
    "finance.yahoo.com": "yahoo-finance",
    "venturebeat.com": "venture-beat",
    "gurufocus.com": "guru-focus",
    "yourstory.com": "your-story",
    "theguardian.com": "the-guardian",
    "spectrum.ieee.org": "spectrum-ieee",
    "nasdaq.com": "nasdaq",
    "euractiv.com": "euractiv",
    "fortune.com": "fortune",
    "indexbox.io": "indexbox",
    "phys.org": "phys",
    "reuters.com": "reuters",
    "bloomberg.com": "bloomberg",
    "ign.com": "ign",
    "japantimes.co.jp": "japan-times",
    "thehindu.com": "the-hindu",
    "ft.com": "financial-times",
    "nytimes.com": "the-new-york-times",
    "aftermath.site": "aftermath",
    "computerworld.com": "computer-world",
    "business.inquirer.net": "business-inquirer",
    "androidpolice.com": "android-police",
    "scmp.com": "scmp",
    "azure.microsoft.com": "microsoft-azure",
    "benzinga.com": "benzinga",
}

_SUBREDDIT = re.compile(r"^r/(?P<name>[A-Za-z0-9_]+)/?$")


def domain_of(url: str) -> str:
    """Hostname without a leading ``www.``, lowercased. "" when the URL has none."""
    raw = (url or "").strip()
    if not raw:
        return ""
    if "//" not in raw:
        raw = f"https://{raw}"
    host = (urlparse(raw).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def source_name_for_domain(domain: str) -> str:
    """Map a domain to a publisher label.

    The n8n fallback for an unmapped domain: drop the TLD, then dots to dashes. ``i-programmer.info``
    → ``i-programmer``, ``finance.yahoo.com`` → mapped to ``yahoo-finance``.
    """
    host = (domain or "").strip().lower()
    if not host:
        return ""
    if host in DOMAIN_SOURCE_MAP:
        return DOMAIN_SOURCE_MAP[host]
    stem = re.sub(r"\.[^.]+$", "", host)  # strip the TLD
    return slugify_source(stem.replace(".", "-"))


def source_name_for_feed(name: str) -> str:
    """Publisher label for a single-publisher feed, from its row ``name``.

    ``r/artificial`` becomes ``reddit-artificial`` rather than ``r-artificial``, which is the spelling
    the n8n self-post normalizers used and so the spelling already in the corpus.
    """
    match = _SUBREDDIT.match((name or "").strip())
    if match:
        return slugify_source(f"reddit {match.group('name')}")
    return slugify_source(name)


def is_aggregator(urls: list[str]) -> bool:
    """Does this batch of item URLs span enough domains to call the feed an aggregator?"""
    domains = {d for d in (domain_of(u) for u in urls) if d}
    return len(domains) >= AGGREGATOR_DOMAIN_THRESHOLD


def modal_domain(urls: list[str]) -> str:
    """The domain most of these items come from. "" when there is none.

    This is the label for a single-publisher feed, and it exists because the feed's **name** is not
    reliably one. The genre importer (``/feeds/import-from-genre``) names every row it creates
    ``"<genre name> — RSS"``, so all nine ``wasteland-wire`` RSS feeds — Strange Horizons,
    Clarkesworld, Escape Pod, three Medium tags, Dystopic, Rising Shadow — carry the *same* name.
    Labelling by name would file all of them as ``post-apocalyptic-science-fiction-rss``: the wrong
    publisher on every row, and two different magazines publishing the same title would collide on
    one key.

    Measured against the 3,930-row DEV corpus: this also changes the vendor blogs from n8n's
    ``blog-open-ai`` / ``blog-nvidia-ai`` (150 and 108 rows) to ``openai`` / ``nvidia``. That split is
    accepted rather than chosen — those labels were hardcoded constants in n8n code nodes and cannot
    be derived from the feed table at all (the row is named "OpenAI Blog", which slugs to
    ``openai-blog``, matching neither). Nothing joins on ``source_name``; it is a display label, so
    the cost is that one publisher reads under two names across the cutover.
    """
    counts: dict[str, int] = {}
    for url in urls:
        domain = domain_of(url)
        if domain:
            counts[domain] = counts.get(domain, 0) + 1
    if not counts:
        return ""
    best = max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]
    return source_name_for_domain(best)


__all__ = [
    "AGGREGATOR_DOMAIN_THRESHOLD",
    "DOMAIN_SOURCE_MAP",
    "domain_of",
    "is_aggregator",
    "modal_domain",
    "source_name_for_domain",
    "source_name_for_feed",
]
