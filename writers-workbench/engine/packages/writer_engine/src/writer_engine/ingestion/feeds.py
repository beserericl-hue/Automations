"""Fetching and parsing feeds (E1).

``newsletter_feed_sources_v2.url_type`` has four values and the live DEV rows use three of them, in
five actual wire formats:

===============  ======================================================================
``url_type``     what the URL actually serves
===============  ======================================================================
``rss``          rss.app JSON Feed (``/feeds/v1.1/<id>.json``) — 10 of the ai-news rows
``rss``          RSS 2.0 XML (``/feeds/<id>.xml``, beehiiv, medium, clarkesworld, …)
``rss``          Atom (some publisher feeds)
``reddit``       rss.app JSON Feed of a subreddit, OR reddit's own ``/r/<x>/.json`` listing
``source``       an HTML page, scraped — see ``pipeline``
===============  ======================================================================

n8n handled exactly one of those five. ``DEV - Newsletter Ingestion (Multi-User Cron)`` fetched with
``responseFormat: autodetect`` and then did ``Array.isArray(payload.items) ? payload.items : []``,
which is true for a JSON Feed and false for every XML feed on the list — so the 7 XML feeds among
the 32 rows yielded zero items on every tick and nobody noticed, because zero items is not an error.
That is a second silent hole alongside J6, and it is why this module sniffs the body instead of
trusting the extension.

Parsing is stdlib ``xml.etree`` rather than a feed library: the three shapes are small, and adding a
dependency to the engine image for ~60 lines is a worse trade than owning them. ``XMLParser`` is used
with the default settings, which do not resolve external entities — feeds are untrusted input.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree

import httpx

from writer_engine.telemetry.logging import get_logger

logger = get_logger("ingestion.feeds")

USER_AGENT = "writers-workbench/1.0 (newsletter ingestion)"
"""Reddit 429s a default client UA, and the n8n nodes set exactly this string."""

FETCH_TIMEOUT_S = 30.0

ARTICLE = "article"
REDDIT_POST = "reddit_post"
NEWSLETTER = "newsletter"
TWEET = "tweet"
ITEM_TYPES = frozenset({ARTICLE, REDDIT_POST, NEWSLETTER, TWEET})
"""The ``content_ingestion_v2.type`` values. Not a DB constraint — migration 009 documents them in a
comment only — but ``gather_step`` filters on ``type != 'newsletter'``, so a typo here would quietly
drop an item out of every edition."""

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "dc": "http://purl.org/dc/elements/1.1/",
    "content": "http://purl.org/rss/1.0/modules/content/",
    "media": "http://search.yahoo.com/mrss/",
}

_ENTITIES = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#039;": "'",
    "&#39;": "'",
    "&#x200B;": "",
}

_TAG_RE = re.compile(r"<[^>]+>")

# Elements whose *contents* are code, not prose. Stripping tags alone leaves the code behind: the
# first live DEV run ingested a Strange Horizons story whose `content:encoded` opens with an inline
# content-warning widget, and the markdown blob started
# "function showWarning_enUS() { var content_warning_list = document." — 39KB of JavaScript filed as
# the body of a short story, which is then what the newsletter would summarise.
_CODE_ELEMENTS = re.compile(r"<(script|style|noscript)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
# An unclosed <script> (truncated feed, malformed markup) would otherwise survive the rule above.
_OPEN_CODE_ELEMENT = re.compile(r"<(script|style|noscript)\b[^>]*>.*", re.IGNORECASE | re.DOTALL)
_BLANK_LINES = re.compile(r"\n{3,}")


@dataclass
class FeedItem:
    """One normalized feed entry, before a key or a scrape.

    ``published`` stays raw on purpose — ``keys.parse_published_date`` knows all four shapes the
    feeds produce and is the single place that decides what an unreadable date means.
    """

    title: str
    url: str
    published: object = None
    authors: str = ""
    body_html: str = ""
    body_text: str = ""
    image_urls: list[str] = field(default_factory=list)
    item_type: str = ARTICLE
    reddit: dict[str, Any] | None = None
    is_self_post: bool = False

    @property
    def has_body(self) -> bool:
        return bool(self.body_text.strip() or self.body_html.strip())


def decode_entities(text: str) -> str:
    """Decode the handful of entities Reddit embeds in ``selftext_html``.

    Same limited set as the n8n ``decodeHtmlEntities`` helper. Deliberately not
    ``html.unescape``: that would also turn ``&lt;script&gt;`` into live markup inside a blob the
    renderer may inline, and the n8n baseline did not do that either.
    """
    out = str(text or "")
    for entity, char in _ENTITIES.items():
        out = out.replace(entity, char)
    return out


def strip_code_elements(markup: str) -> str:
    """Remove ``<script>`` / ``<style>`` / ``<noscript>`` elements *and their contents*.

    Applied to both halves of a feed-supplied body, so the stored ``.html`` blob does not carry
    executable markup either.
    """
    out = _CODE_ELEMENTS.sub(" ", markup or "")
    return _OPEN_CODE_ELEMENT.sub(" ", out)


def strip_html(text: str) -> str:
    """Tags out, code elements and all, for the plain-text body.

    Order matters: the code elements have to go before the tags do — once ``<script>`` has been
    stripped as a tag there is nothing left to tell its body from prose.
    """
    markup = strip_code_elements(decode_entities(text or ""))
    return _BLANK_LINES.sub("\n\n", _TAG_RE.sub("", markup)).strip()


# ---------------------------------------------------------------------------
# format sniffing
# ---------------------------------------------------------------------------


def sniff(body: str, content_type: str = "") -> str:
    """``"json"``, ``"xml"`` or ``"unknown"`` — from the body, not the URL.

    The URL lies: the 32 live feed rows include ``.json`` URLs that are JSON Feeds, ``.json`` URLs
    that are Reddit listings, ``.xml`` URLs, and extensionless publisher feeds. The body does not.
    """
    ct = (content_type or "").lower()
    head = (body or "").lstrip()[:400]
    if "json" in ct or head.startswith(("{", "[")):
        return "json"
    if "xml" in ct or "rss" in ct or head.startswith("<"):
        return "xml"
    return "unknown"


# ---------------------------------------------------------------------------
# parsers
# ---------------------------------------------------------------------------


def _as_list(value: object) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def _authors_of(raw: object) -> str:
    """JSON Feed ``authors: [{name}]``, or the legacy singular ``author``."""
    if isinstance(raw, dict):
        return str(raw.get("name") or "")
    names = [str(a.get("name") or "") for a in _as_list(raw) if isinstance(a, dict)]
    return ", ".join(n for n in names if n)


def parse_json_feed(payload: Any) -> list[FeedItem]:
    """JSON Feed 1.1 — what every ``rss.app/feeds/v1.1/*.json`` URL serves."""
    items = payload.get("items") if isinstance(payload, dict) else payload
    out: list[FeedItem] = []
    for raw in _as_list(items):
        if not isinstance(raw, dict):
            continue
        images = [str(raw["image"])] if raw.get("image") else []
        images += [
            str(a.get("url"))
            for a in _as_list(raw.get("attachments"))
            if isinstance(a, dict) and a.get("url") and str(a.get("mime_type") or "").startswith("image")
        ]
        out.append(
            FeedItem(
                title=str(raw.get("title") or ""),
                url=str(raw.get("url") or raw.get("external_url") or raw.get("id") or ""),
                published=raw.get("date_published") or raw.get("date_modified"),
                authors=_authors_of(raw.get("authors") or raw.get("author")),
                body_html=strip_code_elements(str(raw.get("content_html") or "")),
                body_text=strip_html(str(raw.get("content_text") or raw.get("summary") or "")),
                image_urls=[i for i in images if i],
            )
        )
    return out


def _text(node: Any, *paths: str) -> str:
    for path in paths:
        found = node.find(path, _NS) if path else None
        if found is not None and (found.text or "").strip():
            return str(found.text).strip()
    return ""


def parse_rss_xml(body: str) -> list[FeedItem]:
    """RSS 2.0 and Atom. Returns [] on malformed XML rather than raising.

    A feed that serves a 502 HTML error page is a routine event, and it must cost one feed's run,
    not the tick.
    """
    try:
        root = ElementTree.fromstring(body)
    except ElementTree.ParseError as exc:
        logger.warning("ingestion.feed_xml_unparseable", error=str(exc)[:160])
        return []

    out: list[FeedItem] = []

    for item in root.findall(".//item"):
        body_html = strip_code_elements(_text(item, "content:encoded", "description"))
        out.append(
            FeedItem(
                title=_text(item, "title"),
                url=_text(item, "link", "guid"),
                published=_text(item, "pubDate", "dc:date") or None,
                authors=_text(item, "dc:creator", "author"),
                body_html=body_html,
                body_text=strip_html(body_html),
                image_urls=[
                    str(m.get("url"))
                    for m in item.findall("media:content", _NS)
                    if str(m.get("type") or "image").startswith("image") and m.get("url")
                ],
            )
        )

    for entry in root.findall(".//atom:entry", _NS):
        link = ""
        for candidate in entry.findall("atom:link", _NS):
            rel = candidate.get("rel") or "alternate"
            if rel == "alternate" and candidate.get("href"):
                link = str(candidate.get("href"))
                break
        body_html = strip_code_elements(_text(entry, "atom:content", "atom:summary"))
        out.append(
            FeedItem(
                title=_text(entry, "atom:title"),
                url=link or _text(entry, "atom:id"),
                published=_text(entry, "atom:published", "atom:updated") or None,
                authors=_text(entry, "atom:author/atom:name"),
                body_html=body_html,
                body_text=strip_html(body_html),
            )
        )

    return out


def _reddit_post(data: dict[str, Any], *, subreddit_label: str = "") -> FeedItem:
    """One Reddit post record (``t3``) → a FeedItem.

    A *self* post carries its own body, so it is ingestible as-is. A *link* post is a pointer, and
    its body has to come from scraping ``url_overridden_by_dest``. The n8n workflow split these into
    two branches; ``is_self_post`` is that split, carried on the item.
    """
    permalink = str(data.get("permalink") or "")
    is_self = bool(data.get("is_self"))
    dest = str(data.get("url_overridden_by_dest") or "")
    selftext = str(data.get("selftext") or "")
    return FeedItem(
        title=str(data.get("title") or ""),
        # A self post's canonical URL is the thread; a link post's is the destination, because that
        # is what gets scraped and what `source_name` should name.
        url=(f"https://reddit.com{permalink}" if is_self or not dest else dest),
        published=data.get("created_utc"),
        authors=str(data.get("author") or ""),
        body_html=decode_entities(str(data.get("selftext_html") or "")) if is_self else "",
        body_text=selftext if is_self else "",
        item_type=REDDIT_POST if is_self else ARTICLE,
        is_self_post=is_self,
        reddit={
            "score": data.get("score"),
            "num_comments": data.get("num_comments"),
            "author": data.get("author"),
            "subreddit": data.get("subreddit") or subreddit_label,
            "reddit_id": data.get("id"),
            "flair": data.get("link_flair_text") or None,
        },
    )


def parse_reddit_listing(payload: Any, *, subreddit_label: str = "") -> list[FeedItem]:
    """Reddit's own JSON — either a listing (``/r/x/.json``) or a post page (``/comments/id.json``).

    The post-page form is a two-element array whose first element is the post listing, which is the
    shape the n8n ``extract_reddit_*_items`` nodes reached into.
    """
    listing = payload[0] if isinstance(payload, list) and payload else payload
    children = ((listing or {}).get("data") or {}).get("children") if isinstance(listing, dict) else None
    out: list[FeedItem] = []
    for child in _as_list(children):
        data = child.get("data") if isinstance(child, dict) else None
        if isinstance(data, dict) and data.get("title"):
            out.append(_reddit_post(data, subreddit_label=subreddit_label))
    return out


# Link-post destinations that are not articles: the n8n `filter_reddit_*_items` node excluded these
# before scraping, because Firecrawl on a YouTube page or a bare image burns a credit for nothing.
UNSCRAPEABLE_HOSTS = (
    "reddit.com",
    "youtube.com",
    "youtu.be",
    "x.com",
    "github.com",
    "i.redd.it",
    "v.redd.it",
)


def is_scrapeable_destination(url: str) -> bool:
    low = (url or "").lower()
    return bool(low) and not any(host in low for host in UNSCRAPEABLE_HOSTS)


# ---------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------


def is_reddit_feed(url: str) -> bool:
    """Is this URL one of Reddit's own feeds (rather than an rss.app mirror of one)?"""
    host = urlparse(str(url or "")).netloc.lower()
    return host.endswith("reddit.com")


def _mark_reddit_rss_self_posts(items: list[FeedItem], *, feed_url: str) -> list[FeedItem]:
    """Treat a Reddit Atom entry that carries a body as the self post it is.

    Reddit 403s its own ``/.json`` listing from datacenter IPs — measured on all four
    wasteland-wire subreddit rows — but serves ``/.rss`` from the same address. Those four feeds
    were therefore recorded as dead when the endpoint, not the feed, was the problem.

    Pointing them at ``/.rss`` fetches, but on its own it ingests almost nothing: the Atom path
    never sets ``is_self_post``, a Reddit self post is well under
    ``pipeline.INLINE_BODY_MIN_WORDS``, and reddit.com is on the unscrapeable list — so every
    self post fell through to "skipped, unscrapeable". Measured on r/apocalypse: 25 items
    fetched, 24 skipped, 1 kept.

    Reddit's Atom ``<content>`` IS the post body for a self post (for a link post it is a short
    "submitted by" stub with the outbound link), so an entry with a body on a Reddit feed is
    exactly the case the pipeline already handles directly and without a relevance gate.
    """
    if not is_reddit_feed(feed_url):
        return items
    for item in items:
        if item.has_body and not is_scrapeable_destination(item.url):
            item.is_self_post = True
            item.item_type = REDDIT_POST
    return items


async def fetch_feed(
    url: str, *, url_type: str = "rss", client: httpx.AsyncClient | None = None
) -> list[FeedItem]:
    """Fetch one feed URL and return its items, whatever format it turns out to be.

    Raises on a transport error or a non-2xx — the caller records that against the feed row so a
    dead feed is visible in ``last_error`` instead of looking like a quiet one.
    """
    owned = client is None
    http = client or httpx.AsyncClient(timeout=FETCH_TIMEOUT_S, follow_redirects=True)
    try:
        resp = await http.get(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
        resp.raise_for_status()
        body = resp.text
        kind = sniff(body, resp.headers.get("content-type", ""))
    finally:
        if owned:
            await http.aclose()

    if kind == "json":
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            logger.warning("ingestion.feed_json_unparseable", url=url[:120], error=str(exc)[:120])
            return []
        # A Reddit listing and a JSON Feed are told apart by shape, not by url_type: the `reddit`
        # rows in DEV point at BOTH an rss.app JSON Feed (ai-news) and reddit's own listing
        # (wasteland-wire), and n8n's single `reddit` branch silently handled only one.
        if isinstance(payload, dict) and isinstance(payload.get("items"), list):
            items = parse_json_feed(payload)
            if url_type == "reddit":
                for item in items:
                    item.item_type = ARTICLE  # an rss.app subreddit feed carries link posts
            return items
        return parse_reddit_listing(payload)

    if kind == "xml":
        items = parse_rss_xml(body)
        return _mark_reddit_rss_self_posts(items, feed_url=url)

    logger.warning("ingestion.feed_unknown_format", url=url[:120], head=body[:80])
    return []


async def fetch_reddit_post(url: str, *, client: httpx.AsyncClient | None = None) -> FeedItem | None:
    """Fetch the full post record behind a subreddit feed entry.

    An rss.app subreddit feed gives a title and a permalink and no body, no score and no ``is_self``
    — so the n8n pipeline followed every entry to ``reddit.com/comments/<id>.json`` to find out
    whether it was a self post worth ingesting directly. Returns ``None`` when the URL is not a
    Reddit thread or the thread has gone.
    """
    match = re.search(r"comments/([A-Za-z0-9]+)", url or "")
    if not match:
        return None
    owned = client is None
    http = client or httpx.AsyncClient(timeout=FETCH_TIMEOUT_S, follow_redirects=True)
    try:
        resp = await http.get(
            f"https://www.reddit.com/comments/{match.group(1)}.json?raw_json=1",
            headers={"User-Agent": USER_AGENT},
        )
        resp.raise_for_status()
        items = parse_reddit_listing(resp.json())
    except Exception as exc:
        logger.warning(
            "ingestion.reddit_post_failed", url=url[:120], error=f"{type(exc).__name__}: {exc}"[:140]
        )
        return None
    finally:
        if owned:
            await http.aclose()
    return items[0] if items else None


__all__ = [
    "ARTICLE",
    "FETCH_TIMEOUT_S",
    "ITEM_TYPES",
    "NEWSLETTER",
    "REDDIT_POST",
    "TWEET",
    "UNSCRAPEABLE_HOSTS",
    "USER_AGENT",
    "FeedItem",
    "decode_entities",
    "fetch_feed",
    "fetch_reddit_post",
    "is_scrapeable_destination",
    "parse_json_feed",
    "parse_reddit_listing",
    "parse_rss_xml",
    "sniff",
    "strip_code_elements",
    "strip_html",
]
