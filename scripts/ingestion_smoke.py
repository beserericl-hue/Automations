#!/usr/bin/env python3
"""E1 — run the engine's ingestion against DEV for real, one feed at a time.

Ingestion is the last hard dependency on n8n: ``content_ingestion_v2`` is the newsletter's raw
material, ``gather_step`` reads it by date prefix, and until the engine could write it, turning the
DEV workflows off would have quietly emptied the corpus.

Both n8n producers were broken when this was written, which is why a smoke run matters more than
usual — there is no "it worked yesterday" to fall back on:

* ``AI News Data Ingestion V2`` (``2T3TwGHhdGQlTpQ5``): errored every 4h from 2026-09-24, at
  ``search_existing``, with ``prefix: key is required``. 23 days, zero rows.
* ``DEV - Newsletter Ingestion (Multi-User Cron)`` (``JAQ8rmCaDoddqt2k``): "succeeded" every 30
  minutes in under 2 seconds, uploading nothing, while still stamping ``last_fetched_at`` on all 32
  feed rows so the feed table looked healthy.

COST. Each item that is not already ingested and does not arrive with its own body costs one
Firecrawl scrape plus two Gemini Flash calls. ``--max-items`` is therefore low by default and
``--list`` makes no network calls at all. ``--feed`` matches on the feed row's name.

This writes to whatever ``SUPABASE_URL`` the engine's ``.env`` points at. It refuses to run against
PROD (``faklxfakgzkpkbxfihzh``) — ingestion is additive, but PROD's corpus is still n8n's to write
until the cutover.

Usage::

    python3 scripts/ingestion_smoke.py --list
    python3 scripts/ingestion_smoke.py --feed Clarkesworld --max-items 2
    python3 scripts/ingestion_smoke.py --due --max-items 2      # one real tick, every due feed
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

ENGINE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "writers-workbench",
    "engine",
)
ENGINE_SRC = os.path.join(ENGINE, "packages", "writer_engine", "src")
if ENGINE_SRC not in sys.path:
    sys.path.insert(0, ENGINE_SRC)

PROD_PROJECT = "faklxfakgzkpkbxfihzh"
DEV_PROJECT = "gvbvwcnmjkdpclcisqrr"


def _load_env() -> None:
    """Read the engine's own ``.env`` so this runs with the same config the engine does."""
    path = os.path.join(ENGINE, ".env")
    if not os.path.exists(path):
        return
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


async def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="run engine ingestion against the configured Supabase")
    ap.add_argument("--list", action="store_true", help="print the feed list and exit (no network)")
    # Matched against the URL as well as the name: the nine wasteland-wire rows the genre importer
    # created all share the name "Post-Apocalyptic Science Fiction — RSS", so the URL is the only
    # thing that tells them apart.
    ap.add_argument("--feed", default="", help="only feeds whose name OR url contains this")
    ap.add_argument("--due", action="store_true", help="run a real tick: claim and ingest every due feed")
    ap.add_argument("--max-items", type=int, default=3, help="per-feed item ceiling (default 3)")
    ap.add_argument("--allow-prod", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    _load_env()
    url = os.environ.get("SUPABASE_URL", "")
    if not url:
        print("SUPABASE_URL is unset — nothing to talk to", file=sys.stderr)
        return 2
    if PROD_PROJECT in url and not args.allow_prod:
        print(f"REFUSING: {url} is PROD. PROD ingestion is still n8n's until the cutover.", file=sys.stderr)
        return 2
    tier = "DEV" if DEV_PROJECT in url else "UNKNOWN"
    print(f"target: {url}  ({tier})\n")

    from writer_engine.config import get_settings
    from writer_engine.ingestion import ingest_due_feeds, ingest_feed
    from writer_engine.ingestion.pipeline import feed_item_type
    from writer_engine.ingestion.store import FEED_COLUMNS, FEEDS_TABLE, FeedSource
    from writer_engine.supabase.client import get_supabase_admin

    settings = get_settings()
    print(
        f"firecrawl={'set' if settings.firecrawl_api_key else 'MISSING'} "
        f"gemini={'set' if settings.gemini_api_key else 'MISSING'} "
        f"max_items={args.max_items}\n"
    )

    if args.due:
        results = await ingest_due_feeds(max_items=args.max_items)
        if not results:
            print("no feeds due — every row's fetch_interval_minutes has not elapsed yet")
            return 0
    else:
        client = await get_supabase_admin()
        resp = await (
            client.table(FEEDS_TABLE).select(FEED_COLUMNS).eq("active", True).limit(200).execute()
        )
        rows = list(getattr(resp, "data", None) or [])
        feeds = [FeedSource.from_row(r) for r in rows]
        if args.feed:
            needle = args.feed.lower()
            feeds = [f for f in feeds if needle in f.name.lower() or needle in f.url.lower()]

        if args.list or not args.feed:
            print(f"{'edition':16} {'url_type':10} {'item_type':12} {'name':34} url")
            for f in sorted(feeds, key=lambda f: (f.edition_id, f.name)):
                print(
                    f"{f.edition_id:16} {f.url_type:10} {feed_item_type(f):12} "
                    f"{f.name[:32]:34} {f.url[:64]}"
                )
            print(f"\n{len(feeds)} active feeds")
            if args.list:
                return 0
            if not args.feed:
                print("\npass --feed <name substring> to ingest one, or --due for a real tick")
                return 0

        if not feeds:
            print(f"no active feed matches {args.feed!r}", file=sys.stderr)
            return 2
        results = []
        for feed in feeds:
            print(f"--- {feed.name}  ({feed.url_type} / {feed_item_type(feed)})")
            results.append(await ingest_feed(feed, max_items=args.max_items))

    print(f"\n{'feed':34} {'fetch':>6} {'up':>4} {'exist':>6} {'irrel':>6} {'unkey':>6} {'noscr':>6} {'fail':>5}")
    for r in results:
        print(
            f"{r.feed_name[:32]:34} {r.items_fetched:>6} {r.items_uploaded:>4} "
            f"{r.items_skipped_existing:>6} {r.items_skipped_irrelevant:>6} "
            f"{r.items_skipped_unkeyable:>6} {r.items_skipped_unscrapeable:>6} {r.items_failed:>5}"
        )
        if r.error:
            print(f"    error: {r.error}")
        for key in r.uploaded_keys:
            print(f"    + {key}")

    total = sum(r.items_uploaded for r in results)
    print(f"\n{len(results)} feed(s) · {total} row(s) written")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
