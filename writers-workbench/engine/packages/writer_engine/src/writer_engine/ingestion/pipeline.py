"""One feed, end to end (E1).

This is the trunk the 87-node ``AI News Data Ingestion V2`` workflow converged on, and the loop the
13-node ``DEV - Newsletter Ingestion (Multi-User Cron)`` was supposed to be:

    fetch → normalize → key → dedupe → route → scrape → judge → extract → upload → log

Four things differ from the n8n baseline, each because the baseline was measurably broken:

* **A bad item costs one item.** n8n's ``get_identity`` built the key in an expression, so an entry
  with no ``isoDate`` emptied the key and the 400 from ``search_existing`` aborted the whole
  execution — J6, every four hours from 2026-09-24 to 2026-10-17. Here every per-item failure is
  caught and counted.
* **Every feed in the list gets processed.** The multi-user cron's ``split_per_feed`` loop was never
  wired back from ``report_run``, so it handled the first feed and stopped — while ``/feeds/due``
  had already stamped ``last_fetched_at`` on all 32. Explaining why it ran "successfully" twice an
  hour for months and uploaded nothing.
* **XML feeds work.** See ``feeds.sniff``.
* **A feed that already carries its body is not scraped.** n8n scraped every candidate
  unconditionally. Several live feeds (Medium tags, Clarkesworld, Escape Pod) syndicate the full
  post in ``content:encoded``, so scraping spent a Firecrawl credit to get a worse copy of text we
  already had. See :data:`INLINE_BODY_MIN_WORDS`.

What is deliberately kept: the Firecrawl extraction prompt, the relevance gate, the external-source
extractor, the unscrapeable-destination list, and the key convention. Those encode what the corpus
is, and 3,926 rows already depend on them.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

import httpx

from writer_engine.config import get_settings
from writer_engine.ingestion import enrich, feeds, keys, sources, store
from writer_engine.telemetry.logging import get_logger

logger = get_logger("ingestion.pipeline")

INLINE_BODY_MIN_WORDS = 400
"""Words of feed-supplied body above which the item is ingested as-is instead of scraped.

Chosen from the live feeds: an rss.app newsletter entry is a 40-120 word teaser, while a Medium or
Clarkesworld ``content:encoded`` is the whole piece. 400 is comfortably above the teasers and well
below any real article, so the rule never swaps a full scrape for a summary.
"""

MAX_ITEMS_PER_FEED = 25
"""Per-run ceiling. A busy aggregator can list hundreds; the scrape + 2 LLM calls per item is the
cost, so this bounds one tick's spend at a known number rather than whatever the feed felt like."""


@dataclass
class FeedRunResult:
    feed_id: str
    feed_name: str
    items_fetched: int = 0
    items_uploaded: int = 0
    items_skipped_existing: int = 0
    items_skipped_unkeyable: int = 0
    items_skipped_irrelevant: int = 0
    items_skipped_unscrapeable: int = 0
    items_deferred_no_scraper: int = 0
    """Items that need a scrape while no scraper is available. Counted apart from
    `items_skipped_unscrapeable` on purpose: one means the destination cannot be read, the other
    means we are not reading anything today. Reporting a billing state as a bad destination is how
    62 lost items looked like a feed problem."""
    items_failed: int = 0
    items_kept_ungated: int = 0
    """Items kept only because the relevance gate could not run (it fails open). Non-zero means the
    gate's model is down, not that the feed is clean."""
    error: str | None = None
    uploaded_keys: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def _word_count(text: str) -> int:
    return len((text or "").split())


async def _resolve_reddit_items(
    items: list[feeds.FeedItem], *, client: httpx.AsyncClient
) -> list[feeds.FeedItem]:
    """Follow an rss.app subreddit entry to Reddit's own JSON for the fields it omits.

    An rss.app subreddit feed gives a title and a permalink. Whether the post is a self post worth
    ingesting whole, or a link post whose body lives elsewhere, is only visible in Reddit's API —
    which is why n8n hit ``reddit.com/comments/<id>.json`` for every entry before deciding.
    """
    resolved: list[feeds.FeedItem] = []
    for item in items:
        if "comments/" not in (item.url or "") or item.has_body:
            resolved.append(item)
            continue
        full = await feeds.fetch_reddit_post(item.url, client=client)
        resolved.append(full or item)
    return resolved


def _label_items(items: list[feeds.FeedItem], feed: store.FeedSource) -> list[tuple[feeds.FeedItem, str]]:
    """Pair each item with its ``source_name`` — the publisher label the reader sees.

    Four cases, in order, each derived from data rather than from per-feed configuration (n8n had one
    hardcoded constant per feed node, and the engine reads its feed list from a table):

    1. **A subreddit feed** is labelled from the feed name, because the "publisher" is the subreddit
       and every item's domain is reddit.com. ``r/artificial`` -> ``reddit-artificial``, which is the
       spelling already in the corpus.
    2. **A competitor newsletter** is labelled from the feed name, because a newsletter *is* its
       brand: "The Neuron" -> ``the-neuron``, not ``theneurondaily``. Four of the six baseline
       newsletter feeds match the corpus exactly this way.
    3. **An aggregator** — 3+ distinct item domains — is labelled per item, so a Google News entry
       reads ``reuters`` rather than ``google-news-ai``. This is what n8n did and what the 3,930 rows
       were written with.
    4. **Anything else** is a single publisher, labelled from its modal item domain. See
       ``sources.modal_domain`` for why the feed name cannot be trusted here.
    """
    feed_label = sources.source_name_for_feed(feed.name)
    urls = [i.url for i in items]

    if feed.url_type == "reddit" or feed_item_type(feed) == feeds.NEWSLETTER:
        return [(item, feed_label or "feed") for item in items]

    if sources.is_aggregator(urls):
        return [
            (item, sources.source_name_for_domain(sources.domain_of(item.url)) or feed_label or "feed")
            for item in items
        ]

    label = sources.modal_domain(urls) or feed_label or "feed"
    return [(item, label) for item in items]


async def _ingest_item(
    item: feeds.FeedItem,
    *,
    key: str,
    source_name: str,
    feed: store.FeedSource,
    item_type: str,
    genre: str,
    client: httpx.AsyncClient,
    result: FeedRunResult,
) -> None:
    """Scrape/judge/upload one deduped candidate. Mutates ``result``; never raises."""
    published = item.published
    published_iso: str | None = None
    if published is not None:
        published_iso = keys.parse_published_date(published).isoformat()

    # A Reddit self post is its own body — the n8n `route_scrape_or_self` branch. Nothing to scrape,
    # and no relevance gate either: the baseline uploaded these directly, and a subreddit the user
    # subscribed to is already the editorial filter.
    if item.is_self_post and item.has_body:
        await store.upload_item(
            key=key,
            user_id=feed.user_id,
            item_type=feeds.REDDIT_POST,
            title=item.title,
            authors=item.authors,
            source_name=source_name,
            source_url=item.url,
            markdown=item.body_text,
            html=item.body_html,
            reddit_metadata=item.reddit,
            published_timestamp=published_iso,
            feed_url=feed.url,
        )
        result.items_uploaded += 1
        result.uploaded_keys.append(key)
        return

    # The feed already syndicates the whole piece — take it rather than paying to scrape a copy.
    if _word_count(item.body_text) >= INLINE_BODY_MIN_WORDS:
        keep, reason = await enrich.judge_relevance(item.body_text, title=item.title, genre=genre)
        if not keep:
            result.items_skipped_irrelevant += 1
            logger.info("ingestion.item_irrelevant", key=key, reason=reason[:120])
            return
        if reason == enrich.GATE_UNAVAILABLE:
            result.items_kept_ungated += 1
        await store.upload_item(
            key=key,
            user_id=feed.user_id,
            item_type=item_type,
            title=item.title,
            authors=item.authors,
            source_name=source_name,
            source_url=item.url,
            markdown=item.body_text,
            html=item.body_html,
            image_urls=item.image_urls,
            published_timestamp=published_iso,
            feed_url=feed.url,
        )
        result.items_uploaded += 1
        result.uploaded_keys.append(key)
        return

    if not feeds.is_scrapeable_destination(item.url):
        result.items_skipped_unscrapeable += 1
        return

    if not enrich.scraper_available():
        # Deferred, not failed, and not an error log per item: with 25 items a feed that would
        # produce 25 identical ERROR lines teaches people to ignore the log.
        result.items_deferred_no_scraper += 1
        return

    scraped = await enrich.scrape(item.url, client=client)
    if not scraped.ok:
        result.items_skipped_unscrapeable += 1
        logger.info("ingestion.scrape_failed", key=key, error=(scraped.error or "empty body")[:140])
        return

    keep, reason = await enrich.judge_relevance(
        scraped.markdown, title=item.title or scraped.title, genre=genre
    )
    if not keep:
        result.items_skipped_irrelevant += 1
        logger.info("ingestion.item_irrelevant", key=key, reason=reason[:120])
        return
    if reason == enrich.GATE_UNAVAILABLE:
        result.items_kept_ungated += 1

    external = await enrich.extract_external_sources(scraped)
    await store.upload_item(
        key=key,
        user_id=feed.user_id,
        item_type=item_type,
        title=item.title or scraped.title,
        authors=item.authors,
        source_name=source_name,
        source_url=item.url,
        markdown=scraped.markdown,
        html=scraped.html,
        external_source_urls=external,
        image_urls=scraped.image_urls or item.image_urls,
        reddit_metadata=item.reddit,
        published_timestamp=published_iso,
        feed_url=feed.url,
    )
    result.items_uploaded += 1
    result.uploaded_keys.append(key)


async def ingest_feed(
    feed: store.FeedSource,
    *,
    max_items: int | None = None,
    genre: str | None = None,
    client: httpx.AsyncClient | None = None,
    log_run: bool = True,
    now: datetime | None = None,
) -> FeedRunResult:
    """Ingest one feed. Always returns a result; the only exception it lets out is cancellation."""
    started = now or datetime.now(UTC)
    settings = get_settings()
    # The edition's genre steers the relevance gate. Resolved here when the caller did not do it in
    # bulk, so a single-feed re-run judges by the same standard as the tick.
    if genre is None:
        genre = (await store.edition_genres([feed.edition_id])).get(feed.edition_id, "")
    limit = max_items or settings.ingestion_max_items_per_feed
    result = FeedRunResult(feed_id=feed.id, feed_name=feed.name)

    owned = client is None
    http = client or httpx.AsyncClient(timeout=feeds.FETCH_TIMEOUT_S, follow_redirects=True)
    try:
        try:
            if feed.url_type == "source":
                # A `source` row is a page, not a feed — the genre importer writes these from
                # `genre_config_v2.source_urls`. n8n routed them into the RSS branch, where they
                # parsed as zero items. Treating the page itself as one candidate is the reading
                # that produces something: the key is date-prefixed and the write is an upsert, so
                # re-polling the same page inside a day refreshes one row instead of growing.
                items = [feeds.FeedItem(title=feed.name, url=feed.url, published=started)]
            else:
                items = await feeds.fetch_feed(feed.url, url_type=feed.url_type, client=http)
                if feed.url_type == "reddit":
                    items = await _resolve_reddit_items(items, client=http)
        except Exception as exc:
            result.error = f"{type(exc).__name__}: {exc}"[:300]
            logger.warning("ingestion.feed_fetch_failed", feed=feed.name[:48], error=result.error)
            if log_run:
                await store.record_run(
                    feed=feed,
                    items_fetched=0,
                    items_uploaded=0,
                    items_skipped_existing=0,
                    error_message=result.error,
                    started_at=started,
                )
            return result

        items = [i for i in items if (i.title or "").strip()][:limit]
        result.items_fetched = len(items)
        if not items:
            if log_run:
                await store.record_run(
                    feed=feed, items_fetched=0, items_uploaded=0, items_skipped_existing=0, started_at=started
                )
            return result

        labelled = _label_items(items, feed)
        keyed: list[tuple[feeds.FeedItem, str, str]] = []
        for item, label in labelled:
            key = keys.build_key(title=item.title, source_name=label, published=item.published, now=started)
            if key is None:
                result.items_skipped_unkeyable += 1
                logger.info("ingestion.item_unkeyable", feed=feed.name[:48], title=(item.title or "")[:80])
                continue
            keyed.append((item, label, key))

        already = await store.existing_keys([k for _, _, k in keyed], user_id=feed.user_id)

        def _type_of(item: feeds.FeedItem) -> str:
            """Per-item ``content_ingestion_v2.type``.

            A Reddit feed is the one case where the feed cannot decide: a **self** post is a
            ``reddit_post`` (its body is the post) while a **link** post is an ``article`` (its body
            is the destination site's). The parser already worked that out per item, so for reddit
            the item wins over the feed's declared type.
            """
            if feed.url_type == "reddit":
                return feeds.REDDIT_POST if item.is_self_post else feeds.ARTICLE
            return feed_item_type(feed)

        # Two entries in one fetch can slug to the same key (a feed that lists an update twice).
        # Without this the second upsert would overwrite the first and both would count as uploaded.
        seen_this_run: set[str] = set()

        for item, label, key in keyed:
            if key in already or key in seen_this_run:
                result.items_skipped_existing += 1
                continue
            seen_this_run.add(key)
            try:
                await _ingest_item(
                    item,
                    key=key,
                    source_name=label,
                    feed=feed,
                    item_type=_type_of(item),
                    genre=genre or "",
                    client=http,
                    result=result,
                )
            except Exception as exc:
                result.items_failed += 1
                logger.warning("ingestion.item_failed", key=key, error=f"{type(exc).__name__}: {exc}"[:200])
    finally:
        if owned:
            await http.aclose()

    if result.items_failed and not result.error:
        result.error = f"{result.items_failed} item(s) failed to ingest"
    if log_run:
        await store.record_run(
            feed=feed,
            items_fetched=result.items_fetched,
            items_uploaded=result.items_uploaded,
            items_skipped_existing=result.items_skipped_existing,
            error_message=result.error,
            started_at=started,
        )
    logger.info(
        "ingestion.feed_done",
        feed=feed.name[:48],
        fetched=result.items_fetched,
        uploaded=result.items_uploaded,
        existing=result.items_skipped_existing,
        irrelevant=result.items_skipped_irrelevant,
        unkeyable=result.items_skipped_unkeyable,
        unscrapeable=result.items_skipped_unscrapeable,
        deferred_no_scraper=result.items_deferred_no_scraper,
        failed=result.items_failed,
        ungated=result.items_kept_ungated,
    )
    return result


def feed_item_type(feed: store.FeedSource) -> str:
    """The ``content_ingestion_v2.type`` for this feed's items.

    Migration 029 adds ``item_type`` to the feed row because the distinction is load-bearing and was
    previously hardcoded per n8n node: ``gather_step`` filters ``type != 'newsletter'``, so the six
    competitor-newsletter feeds must be marked ``newsletter`` or their archives start showing up as
    candidate stories inside our own edition. Rows written before 029 default to ``article``.
    """
    declared = str(getattr(feed, "item_type", "") or "").strip()
    if declared in feeds.ITEM_TYPES:
        return declared
    return feeds.REDDIT_POST if feed.url_type == "reddit" else feeds.ARTICLE


async def ingest_due_feeds(
    *, limit: int = 100, max_items: int | None = None, now: datetime | None = None
) -> list[FeedRunResult]:
    """Claim every due feed and ingest each one. Serial on purpose.

    Serial because the per-item work is already the expensive part (a Firecrawl scrape plus two LLM
    calls) and all of it is rate-limited per provider by ``call_provider``. Fanning out feeds would
    only move the queueing from this loop into the budget's wait.
    """
    claimed = await store.claim_due_feeds(limit=limit, now=now)
    if not claimed:
        logger.info("ingestion.no_feeds_due")
        return []
    logger.info("ingestion.tick", feeds=len(claimed))
    genres = await store.edition_genres([f.edition_id for f in claimed])
    results: list[FeedRunResult] = []
    async with httpx.AsyncClient(timeout=feeds.FETCH_TIMEOUT_S, follow_redirects=True) as client:
        for feed in claimed:
            results.append(
                await ingest_feed(
                    feed,
                    max_items=max_items,
                    genre=genres.get(feed.edition_id, ""),
                    client=client,
                    now=now,
                )
            )
    logger.info(
        "ingestion.tick_done",
        feeds=len(results),
        uploaded=sum(r.items_uploaded for r in results),
        failed=sum(1 for r in results if r.error),
    )
    return results


__all__ = [
    "INLINE_BODY_MIN_WORDS",
    "MAX_ITEMS_PER_FEED",
    "FeedRunResult",
    "feed_item_type",
    "ingest_due_feeds",
    "ingest_feed",
]
