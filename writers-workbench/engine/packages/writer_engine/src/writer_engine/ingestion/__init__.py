"""Content ingestion (E1) — the engine's replacement for the n8n ingestion workflows.

``content_ingestion_v2`` is the newsletter's raw material: ``gather_step`` reads a day's rows by key
prefix and everything downstream (pick → subject → segment → assemble → render → deliver) runs off
them. Until now the engine only ever *read* that table. The only things that ever *wrote* it were two
n8n workflows, which is what made "turn n8n off" impossible rather than merely unfinished.

Both of those producers were broken when this was built, in ways that explain the state of the DEV
corpus:

* ``AI News Data Ingestion V2`` (``2T3TwGHhdGQlTpQ5``, 87 nodes) — erroring every 4 hours since
  2026-09-24 at ``search_existing`` with ``prefix: key is required``. One feed entry missing an
  ``isoDate`` emptied the key, and the 400 aborted the whole execution. 23 days, no rows.
* ``DEV - Newsletter Ingestion (Multi-User Cron)`` (``JAQ8rmCaDoddqt2k``, 13 nodes) — "succeeding"
  every 30 minutes in under two seconds and uploading nothing, because its per-feed loop was never
  wired back and its item parser only understood JSON feeds. It still stamped ``last_fetched_at`` on
  all 32 feed rows each tick, so the feed table looked healthy throughout.

Module layout:

``keys``       the ``{date}/{slug}.{source}`` convention, and the J6 fix
``sources``    the publisher label, derived from the data instead of hardcoded per feed
``feeds``      fetch + parse: JSON Feed, RSS 2.0, Atom, Reddit listings
``enrich``     Firecrawl scrape, the relevance gate, the external-source extractor
``store``      the feed list, batch dedupe, and the storage + row write
``pipeline``   one feed end to end, and the due-feed tick
"""

from writer_engine.ingestion.pipeline import FeedRunResult, ingest_due_feeds, ingest_feed
from writer_engine.ingestion.store import FeedSource

__all__ = ["FeedRunResult", "FeedSource", "ingest_due_feeds", "ingest_feed"]
