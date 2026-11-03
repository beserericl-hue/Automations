"""Fetching a web page and reading its main content (ScraperAPI, replacing Firecrawl 2026-11-01).

Firecrawl did two jobs in one call: it fetched the page past bot protection, and a model on its side
read the "main content" back out — the newsletter's ``json`` extraction prompt asked it to return the
article body *verbatim*. ScraperAPI does only the first job, so the two are split here:

* **Fetch** — ``GET https://api.scraperapi.com/?url=…`` returns the page's HTML. A plain
  request costs 1 credit; ``render=true`` (JavaScript) costs 10. ScraperAPI bills only 200 and 404,
  and retries internally for up to 70 seconds before answering 500, which is why the client timeout
  is above 70s and why a 500 gets one retry here rather than the four every other provider gets.
* **Read** — ``trafilatura`` pulls the main body out of that HTML as markdown. This is
  deterministic, free, and verbatim by construction: it can only return text that is in the page,
  where a model asked to copy an article "verbatim" can paraphrase it and nobody notices.

A page that comes back as a JavaScript shell has almost no readable body. When that happens the page
is fetched once more with ``render=true`` — ten times the price, so only on that evidence, and
``SCRAPER_RENDER_FALLBACK=false`` turns it off.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urljoin, urlparse

import httpx

from writer_engine.config import get_settings
from writer_engine.rate_limit.provider_budget import call_provider
from writer_engine.telemetry.logging import get_logger

logger = get_logger("scraping")

SCRAPERAPI_URL = "https://api.scraperapi.com/"

FETCH_TIMEOUT_S = 80.0
"""ScraperAPI keeps retrying a hard page for up to 70s before it answers; cutting it off sooner throws
away the attempt that was about to succeed. Its docs recommend 70s; this leaves room for the transfer."""

FETCH_ATTEMPTS = 2
"""A 500 from ScraperAPI already means 70s of its own retries failed, so one more try, not four."""

MIN_MAIN_CHARS = 800
"""Below this the extractor found no real body — usually a JavaScript shell, sometimes a paywall or
a consent wall. Worth one rendered fetch; not worth calling the page empty yet. Measured on DEV's
corpus 2026-11-01: abc.xyz's JS-built press release read as 637 chars of navigation, while the
shortest real articles (9to5mac, 404 Media) read at ~1,300."""

MIN_IMAGE_WIDTH = 600
"""Carried over from the Firecrawl prompt: images under 600px wide are not used in content."""

_IMAGE_NOISE = re.compile(r"(?i)(logo|icon|avatar|sprite|badge|pixel|spacer|gravatar|emoji)")
_MD_IMAGE = re.compile(r"!\[[^\]]*\]\(\s*<?([^)\s>]+)")
_TITLE_TAG = re.compile(r"(?is)<title[^>]*>(.*?)</title>")


@dataclass
class Page:
    """One fetched page. ``markdown`` is the main body only, not the whole page."""

    url: str
    markdown: str = ""
    html: str = ""
    title: str = ""
    links: list[str] = field(default_factory=list)
    image_urls: list[str] = field(default_factory=list)
    rendered: bool = False
    credits: int = 0
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error and bool(self.markdown.strip())


def scraper_available() -> bool:
    """Is a scraper configured AND switched on? ``SCRAPER_ENABLED=false`` keeps the key but stops
    spending; a missing key means the same thing."""
    settings = get_settings()
    return bool(settings.scraper_enabled and settings.scraperapi_api_key)


def scraper_unavailable_reason() -> str:
    settings = get_settings()
    if not settings.scraperapi_api_key:
        return "scraper_not_configured"
    return "scraper_disabled" if not settings.scraper_enabled else ""


async def fetch_html(
    url: str, *, render: bool = False, client: httpx.AsyncClient | None = None
) -> tuple[str, int]:
    """``(html, credits)`` for one page through ScraperAPI. Raises on any failure.

    ``credits`` is ScraperAPI's own ``sa-credit-cost`` header for the request, 0 when absent.
    """
    settings = get_settings()
    # The key goes in ScraperAPI's header form, not the documented ?api_key= query parameter: httpx
    # puts the request URL into every HTTPStatusError message, and those messages are stored on feed
    # rows and returned in step payloads.
    headers = {"x-sapi-api_key": settings.scraperapi_api_key}
    params = {"url": url}
    if render:
        params["render"] = "true"
    if settings.scraperapi_country_code:
        params["country_code"] = settings.scraperapi_country_code

    owned = client is None
    http = client or httpx.AsyncClient(timeout=FETCH_TIMEOUT_S)
    try:

        async def _get() -> httpx.Response:
            async with _in_flight():
                resp = await http.get(SCRAPERAPI_URL, params=params, headers=headers, timeout=FETCH_TIMEOUT_S)
            resp.raise_for_status()
            return resp

        resp = await call_provider("scraperapi", _get, attempts=FETCH_ATTEMPTS)
    finally:
        if owned:
            await http.aclose()

    try:
        credits = int(resp.headers.get("sa-credit-cost") or 0)
    except ValueError:
        credits = 0
    _record_scrape_cost(credits, render=render, status=resp.status_code)
    return resp.text, credits


def _record_scrape_cost(credits: int, *, render: bool, status: int) -> None:
    """One cost row per billed ScraperAPI request (the render fallback is its own request and row).

    ``sa-credit-cost`` is ScraperAPI's own count. Without it the documented price is assumed (1 plain,
    10 render=true) and the row is marked estimated.
    """
    from writer_engine.telemetry import pricing, token_accounting

    if credits > 0:
        token_accounting.record_units(
            provider="scraperapi",
            model="api",
            units=credits,
            unit_type="credits",
            credits=credits,
            metadata={"render": render, "status": status},
        )
        return
    assumed = 10 if render else 1
    base = pricing.unit_cost("scraperapi", "api", units=assumed, credits=assumed)
    token_accounting.record_units(
        provider="scraperapi",
        model="api",
        units=assumed,
        unit_type="credits",
        cost=pricing.Cost(
            base.cost_usd, pricing.COST_ESTIMATED, {**base.unit_prices, "assumed_credits": assumed}
        ),
        metadata={"render": render, "status": status, "credit_header": False},
    )


_semaphores: dict[int, asyncio.Semaphore] = {}


def _in_flight() -> asyncio.Semaphore:
    """The plan caps concurrent requests (5) and answers 429 past it, and a newsletter's scrape step
    starts every source of a story at once. One semaphore per event loop, since a semaphore is bound
    to the loop it first waits on."""
    loop_id = id(asyncio.get_running_loop())
    sem = _semaphores.get(loop_id)
    if sem is None:
        sem = _semaphores[loop_id] = asyncio.Semaphore(max(1, get_settings().scraperapi_max_concurrency))
    return sem


def read_page(html: str, url: str) -> Page:
    """The main body of ``html`` as markdown, plus its title, links and content images."""
    import trafilatura

    markdown = (
        trafilatura.extract(
            html,
            url=url,
            output_format="markdown",
            include_comments=False,
            include_tables=True,
            include_images=True,
            include_formatting=True,
            include_links=False,
        )
        or ""
    )
    title = ""
    try:
        meta = trafilatura.extract_metadata(html, default_url=url)
        title = str(getattr(meta, "title", "") or "")
    except Exception:  # noqa: BLE001 - trafilatura on untrusted HTML; a page without readable metadata still has a body
        title = ""
    if not title:
        found = _TITLE_TAG.search(html)
        title = re.sub(r"\s+", " ", found.group(1)).strip() if found else ""
    links, narrow = _links_and_narrow_images(html, url)
    return Page(
        url=url,
        markdown=markdown.strip(),
        html=html,
        title=title,
        links=links,
        image_urls=_content_images(markdown, url, narrow),
    )


async def fetch_page(url: str, *, client: httpx.AsyncClient | None = None) -> Page:
    """Fetch and read one page. Never raises — a failed page comes back with ``error`` set."""
    reason = scraper_unavailable_reason()
    if reason:
        return Page(url=url, error=reason)
    try:
        html, credits = await fetch_html(url, client=client)
        page = read_page(html, url)
        page.credits = credits
        if len(page.markdown) < MIN_MAIN_CHARS and get_settings().scraper_render_fallback:
            html, more = await fetch_html(url, render=True, client=client)
            rendered = read_page(html, url)
            rendered.credits = credits + more
            rendered.rendered = True
            logger.info(
                "scraping.rendered_fallback",
                url=url,
                plain_chars=len(page.markdown),
                rendered_chars=len(rendered.markdown),
            )
            # Keep whichever read more; a render can fail to help (paywalls, consent walls).
            if len(rendered.markdown) >= len(page.markdown):
                page = rendered
            else:
                page.credits = rendered.credits
    except Exception as exc:  # noqa: BLE001 - fetch_page returns any scrape/parse failure as Page.error for the caller; it never raises
        return Page(url=url, error=f"{type(exc).__name__}: {exc}"[:200])
    if not page.markdown:
        page.error = "no_main_content"
    return page


def _links_and_narrow_images(html: str, base: str) -> tuple[list[str], set[str]]:
    """Every http(s) link on the page (deduped, in order) and the images whose markup says they are
    narrower than ``MIN_IMAGE_WIDTH``."""
    links: list[str] = []
    narrow: set[str] = set()
    try:
        import lxml.html

        tree = lxml.html.fromstring(html)
    except Exception:  # noqa: BLE001 - lxml on untrusted HTML (ParserError, XMLSyntaxError, ValueError, ...); no links is the fallback
        return links, narrow
    seen: set[str] = set()
    for href in tree.xpath("//a/@href"):
        absolute = urljoin(base, str(href).strip())
        if urlparse(absolute).scheme in ("http", "https") and absolute not in seen:
            seen.add(absolute)
            links.append(absolute)
    for img in tree.xpath("//img[@src and @width]"):
        try:
            width = int(str(img.get("width")).strip().rstrip("px"))
        except ValueError:
            continue
        if width < MIN_IMAGE_WIDTH:
            narrow.add(urljoin(base, str(img.get("src")).strip()))
    return links, narrow


def _narrow_by_query(src: str) -> bool:
    """WordPress and most image CDNs size a thumbnail in the URL (``?w=160``), not in the markup."""
    for key, value in parse_qsl(urlparse(src).query):
        if key.lower() in ("w", "width") and value.isdigit() and int(value) < MIN_IMAGE_WIDTH:
            return True
    return False


def _content_images(markdown: str, base: str, narrow: set[str]) -> list[str]:
    out: list[str] = []
    for raw in _MD_IMAGE.findall(markdown):
        src = urljoin(base, raw)
        if (
            urlparse(src).scheme not in ("http", "https")
            or src in narrow
            or src in out
            or src.lower().split("?")[0].endswith(".svg")
            or _IMAGE_NOISE.search(urlparse(src).path)
            or _narrow_by_query(src)
        ):
            continue
        out.append(src)
    return out


__all__ = [
    "FETCH_TIMEOUT_S",
    "MIN_MAIN_CHARS",
    "Page",
    "fetch_html",
    "fetch_page",
    "read_page",
    "scraper_available",
    "scraper_unavailable_reason",
]
