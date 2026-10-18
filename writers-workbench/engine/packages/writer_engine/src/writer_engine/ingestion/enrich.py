"""Scraping and judging one candidate item (E1).

A feed entry is a title, a link and — if you are lucky — a summary. The newsletter needs the article
body, so between "deduped candidate" and "ingested row" the n8n pipeline ran three calls:

1. **Firecrawl** ``/v1/scrape`` with a ``json`` extraction prompt, for the verbatim main content and
   the in-content image URLs
2. an **LLM relevance gate** — "is this a full piece of content relevant to an AI newsletter?" —
   which is what kept job postings and unrelated-industry filler out of the corpus
3. an **LLM link extractor** for ``external_source_urls``, the primary sources the writing step
   later cites

All three prompts are ported verbatim, because they are the editorial judgement embodied in 3,926
rows of corpus and rewriting them would change what the newsletter is about. The one substantive
change is the model: n8n called ``o3-mini``, and the engine has no OpenAI chat adapter (OpenAI is
registered for embeddings only), so both LLM calls run on Gemini Flash through the normal router —
same budget, same retry, same concurrency cap as every other engine LLM call.

The relevance gate **fails open**. If the model is unreachable or returns junk, the item is kept and
flagged rather than dropped: a day of slightly noisier candidates is recoverable by the picker
downstream, while a day of silently discarded articles is not recoverable at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx
from pydantic import BaseModel, Field

from writer_engine.config import get_settings
from writer_engine.llm import complete_structured, get_router
from writer_engine.rate_limit.provider_budget import call_provider
from writer_engine.telemetry.logging import get_logger

logger = get_logger("ingestion.enrich")

SCRAPE_TIMEOUT_S = 120.0
"""Firecrawl's json extraction runs a model server-side, so this is minutes-scale, not seconds."""

MAX_JUDGE_CHARS = 24_000
"""How much of the body the relevance gate sees. The verdict is decided in the first page or two."""

MAX_LINKS_FOR_EXTRACTION = 120
"""Cap on the link list handed to the extractor. A news page can carry hundreds of nav links."""

# Verbatim from the `scrape_url` node of `Node - Scrape Url V2` (workflow BJaUNEt6PPIqbWLa).
FIRECRAWL_JSON_PROMPT = (
    "Identify the main content of the text (i.e., the article or newsletter body). Provide the "
    "exact text for that main content verbatim, without summarizing or rewriting any part of it. "
    "Exclude all non-essential elements such as banners, headers, footers, calls to action, ads, "
    "or purely navigational text. Format this output as markdown using appropriate '#' characters "
    "as heading levels. Exclude any promotional or sponsored content on your output. Additionally, "
    "you must identify and extract the image urls within this main content. These images must be "
    "inside the main content of the page so you must exclude small logo images, icons, avatars and "
    "other images which aren't a core part of the main content. The images you extract should at "
    "least have a width of 600 pixels (px) so it can be included on our content."
)

FIRECRAWL_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "content": {
            "type": "string",
            "description": "The exact verbatim main text content of the web page in markdown format.",
        },
        "main_content_image_urls": {
            "type": "array",
            "items": {"type": "string", "description": "An image url inside the main content."},
        },
    },
}

# Verbatim from the `evaluate_content` chainLlm node.
RELEVANCE_PROMPT = (
    "Given content fetched from a web page, analyze this content to determine if it is a full "
    "piece of content that would be considered relevent to our AI Newsletter which features "
    "stories, advancements, and other interesting happenings in the tech and AI space.\n\n"
    "- Job postings are not relevant content\n"
    "- Content centered around unrelated industries is not relevant\n"
    "- Only AI and AI Adjacent content should be considered relevant\n\n---\n"
)

AI_GENRES = frozenset({"", "ai", "ai-marketing", "ai-news", "tech"})
"""Genres the verbatim AI prompt is already right for. The n8n baseline only ever ran the ai-news
feeds, so its prompt hardcodes "Only AI and AI Adjacent content should be considered relevant"."""


def relevance_prompt_for(genre: str | None) -> str:
    """The relevance gate's prompt for one edition's genre.

    The ported prompt is kept **byte-for-byte** for the AI edition, because it is the judgement
    behind 3,926 existing rows and changing it would change what that newsletter is about.

    But it cannot be used for every edition. ``newsletter_feed_sources_v2`` now also carries the
    ``wasteland-wire`` edition — nine post-apocalyptic fiction feeds (Clarkesworld, Escape Pod,
    Strange Horizons, Medium tags) whose genre is ``post-apocalyptic``. Run the AI prompt over those
    and the gate correctly answers "not AI content" for every single item, silently discarding the
    entire edition's corpus. That never showed up in n8n because n8n never polled those feeds — the
    multi-user cron that read the feed table uploaded nothing at all.

    So a non-AI genre gets the same structure with its own subject. This mirrors
    ``pick_step._audience_directive``, which had to solve exactly this for the same reason.
    """
    slug = (genre or "").strip().lower()
    if slug in AI_GENRES:
        return RELEVANCE_PROMPT
    label = slug.replace("-", " ").replace("_", " ")
    return (
        "Given content fetched from a web page, analyze this content to determine if it is a full "
        f"piece of content that would be considered relevant to our {label} newsletter, which "
        f"features stories, releases, reviews and other interesting happenings in the {label} "
        "space.\n\n"
        "- Job postings, store listings and pure navigation pages are not relevant content\n"
        f"- Content centered on unrelated subjects is not relevant\n"
        f"- Only {label} and closely adjacent content should be considered relevant\n"
        "- A complete article, story, review or essay is relevant; a stub, index or teaser is not\n\n"
        "---\n"
    )


# Verbatim from the `try_extract_external_sources` informationExtractor node.
EXTERNAL_SOURCES_PROMPT = """You are given:

1. **Content Website**: The domain hosting the content.
2. **Content Title and Body**: Text or markdown content extracted from a web page.
3. **Links Found on Content Page**: A list of hyperlinks that appear in or around the same article.

## Your Task

- Identify any **external source links** that are most relevant to the main topic of the content. \
It is possible there are NOT ANY good external source links.
- **External** means the link must be on a domain *different* from the Content Website's domain.
- **Relevance** means it must directly reference a primary source (e.g., a product announcement, \
study, press release, etc.) that underpins the main topic.
- **Exclude** links that are:
  - On the same domain as the Content Website
  - Generic homepages, profile pages, or unrelated side links
  - Not clearly connected to the main focus of the article
  - To storefront pages like eCommerce sites, to bookstore pages, to direct product listings, or \
other place to order a product directly.
  - To shopping websites like bookstores and other retail stores.
- If no external links meet these criteria, return an empty list.

It is critical that your source link is relevant to the main content and would be useful context to \
evaluate when writing a newsletter overview about this content targeted towards AI enthusiasts."""


class RelevanceVerdict(BaseModel):
    """The ``is_revelant_content_parser`` schema, with the n8n typo corrected in the field name."""

    chain_of_thought: str = Field(default="", description="Sequential reasoning behind the verdict.")
    is_relevant_content: bool = Field(description="Is this relevant to this newsletter's subject?")


class ExternalSources(BaseModel):
    external_source_urls: list[str] = Field(default_factory=list)


# n8n's `outputParserStructured` node injected the JSON schema into the request for you.
# `complete_structured` does not — it appends "Reply with strict JSON only" and validates whatever
# comes back — so the caller's prompt has to name the keys. Dropping this in the port did not break
# loudly: the gate fails OPEN, so it logged `relevance_unavailable` and kept every item, and the
# only symptom was a filter that silently stopped filtering. Measured on the first live DEV run.
RELEVANCE_SHAPE = (
    "\n\nRespond with exactly this JSON object and no other keys:\n"
    '{"chain_of_thought": "<your reasoning, at most 50 words>", "is_relevant_content": true or false}\n'
    "Keep chain_of_thought short. A long one gets truncated mid-JSON and the verdict is lost.\n"
)

EXTERNAL_SOURCES_SHAPE = (
    "\n\nRespond with exactly this JSON object and no other keys:\n"
    '{"external_source_urls": ["https://example.com/primary-source"]}\n'
    "Use an empty array when no link meets the criteria.\n"
)


@dataclass
class Scraped:
    markdown: str = ""
    html: str = ""
    image_urls: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    title: str = ""
    url: str = ""
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error and bool(self.markdown.strip())


def scraper_available() -> bool:
    """Is a scraper configured AND switched on?

    Asked by the pipeline BEFORE it reaches for one, so a run with no scraper reports its items as
    deferred instead of attempting 62 calls that will all answer 402 and then calling them
    unscrapeable. `FIRECRAWL_ENABLED=false` is the switch; a missing key means the same thing.
    """
    settings = get_settings()
    return bool(settings.firecrawl_enabled and settings.firecrawl_api_key)


async def scrape(url: str, *, client: httpx.AsyncClient | None = None) -> Scraped:
    """Firecrawl the article. Never raises — a failed scrape is one skipped item.

    ``formats`` and ``excludeTags`` match the n8n node exactly. ``markdown`` is taken from the json
    extraction's ``content`` (the verbatim main body) and not from Firecrawl's own ``markdown``,
    which still carries nav and CTA text; that is the distinction the extraction prompt exists for.
    """
    settings = get_settings()
    if not settings.firecrawl_api_key:
        return Scraped(error="firecrawl_not_configured")
    if not settings.firecrawl_enabled:
        return Scraped(error="firecrawl_disabled")

    owned = client is None
    http = client or httpx.AsyncClient(timeout=SCRAPE_TIMEOUT_S)
    try:

        async def _post() -> httpx.Response:
            resp = await http.post(
                "https://api.firecrawl.dev/v1/scrape",
                headers={
                    "authorization": f"Bearer {settings.firecrawl_api_key}",
                    "content-type": "application/json",
                },
                json={
                    "url": url,
                    "formats": ["json", "markdown", "rawHtml", "links"],
                    "excludeTags": ["iframe", "nav", "header", "footer"],
                    "onlyMainContent": True,
                    "jsonOptions": {"prompt": FIRECRAWL_JSON_PROMPT, "schema": FIRECRAWL_JSON_SCHEMA},
                },
            )
            resp.raise_for_status()
            return resp

        resp = await call_provider("firecrawl", _post)
        data = (resp.json() or {}).get("data") or {}
    except Exception as exc:
        return Scraped(error=f"{type(exc).__name__}: {exc}"[:200])
    finally:
        if owned:
            await http.aclose()

    extracted = data.get("json") or {}
    metadata = data.get("metadata") or {}
    return Scraped(
        markdown=str(extracted.get("content") or data.get("markdown") or ""),
        html=str(data.get("rawHtml") or ""),
        image_urls=[str(u) for u in (extracted.get("main_content_image_urls") or []) if u],
        # Strip query strings, as the n8n extractor prompt did, so tracking params do not make two
        # links to the same page look like two sources.
        links=[str(link).split("?")[0] for link in (data.get("links") or []) if link],
        title=str(metadata.get("title") or ""),
        url=str(metadata.get("url") or url),
    )


async def judge_relevance(body: str, *, title: str = "", genre: str = "") -> tuple[bool, str]:
    """``(keep, reason)`` for one scraped body, judged for ``genre``'s newsletter.

    Fails **open**: an unreachable model or unparseable output keeps the item. The gate exists to
    trim noise, and a trimmer that deletes the corpus when it breaks is worse than no trimmer.
    """
    text = (body or "").strip()
    if not text:
        return False, "empty body"

    settings = get_settings()
    heading = f"{title}\n\n" if title else ""
    try:
        verdict, _ = await complete_structured(
            get_router("ingestion"),
            provider="gemini",
            model=settings.hub_router_model,
            system="You are a precise editorial classifier. Answer only with the JSON schema.",
            prompt=f"{relevance_prompt_for(genre)}{heading}{text[:MAX_JUDGE_CHARS]}{RELEVANCE_SHAPE}",
            schema=RelevanceVerdict,
            # 2048, not 1024: the first live run truncated a verdict mid-string ("Unterminated
            # string"), which fails json.loads and — because the gate fails open — silently kept an
            # item it had not actually judged. The word cap in RELEVANCE_SHAPE is the real fix; this
            # is the headroom behind it.
            max_tokens=2048,
            temperature=0.0,
        )
    except Exception as exc:
        logger.warning("ingestion.relevance_unavailable", error=f"{type(exc).__name__}: {exc}"[:140])
        return True, "relevance gate unavailable — kept"
    reason = (verdict.chain_of_thought or "").strip()[:200]
    return verdict.is_relevant_content, reason or (
        "relevant" if verdict.is_relevant_content else "not relevant"
    )


async def extract_external_sources(scraped: Scraped) -> list[str]:
    """The primary sources this article points at, on other domains. [] on any failure."""
    if not scraped.links or not scraped.markdown.strip():
        return []
    settings = get_settings()
    prompt = (
        f"{EXTERNAL_SOURCES_PROMPT}\n\n---\nContent Website:\n{scraped.url}\n\n"
        f"Content Title:\n{scraped.title}\n\nContent:\n{scraped.markdown[:MAX_JUDGE_CHARS]}\n\n"
        f"Links Found on Content Page:\n"
        + "\n".join(scraped.links[:MAX_LINKS_FOR_EXTRACTION])
        + EXTERNAL_SOURCES_SHAPE
    )
    try:
        result, _ = await complete_structured(
            get_router("ingestion"),
            provider="gemini",
            model=settings.hub_router_model,
            system="You are an expert extraction algorithm. Only extract information present in the text.",
            prompt=prompt,
            schema=ExternalSources,
            max_tokens=1024,
            temperature=0.0,
        )
    except Exception as exc:
        logger.warning("ingestion.external_sources_unavailable", error=f"{type(exc).__name__}: {exc}"[:140])
        return []

    from writer_engine.ingestion.sources import domain_of

    own = domain_of(scraped.url)
    seen: set[str] = set()
    out: list[str] = []
    for raw in result.external_source_urls:
        url = str(raw or "").strip().split("?")[0]
        # The model is asked for external links and sometimes returns same-domain ones anyway.
        # Enforcing it here is cheaper than a reprompt and cannot be argued with.
        if not url.startswith("http") or url in seen or (own and domain_of(url) == own):
            continue
        seen.add(url)
        out.append(url)
    return out


__all__ = [
    "AI_GENRES",
    "EXTERNAL_SOURCES_PROMPT",
    "EXTERNAL_SOURCES_SHAPE",
    "FIRECRAWL_JSON_PROMPT",
    "FIRECRAWL_JSON_SCHEMA",
    "MAX_JUDGE_CHARS",
    "RELEVANCE_PROMPT",
    "RELEVANCE_SHAPE",
    "ExternalSources",
    "RelevanceVerdict",
    "Scraped",
    "extract_external_sources",
    "judge_relevance",
    "relevance_prompt_for",
    "scrape",
]
