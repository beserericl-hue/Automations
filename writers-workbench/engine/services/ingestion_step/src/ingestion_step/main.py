"""ingestion-svc — poll the feed list and write ``content_ingestion_v2`` (E1).

The step the engine never had. ``gather_step`` has always read ``content_ingestion_v2``; nothing in
the engine wrote it, so the newsletter's raw material came entirely from two n8n workflows. This
closes that loop, which is the one hard dependency between "DEV runs on the engine" and "n8n can be
switched off" (Gate 4).

Ops, mirroring how the other steps are addressed:

``run``   (default) claim every due feed and ingest each — what the scheduler calls every tick
``feed``  ingest one feed by ``feed_id``, ignoring its interval — the manual re-run / debug path

The handler never fails the step for a feed-level problem. A dead feed, an unparseable body, a
Firecrawl outage: each is recorded against its own feed row and counted in the payload, and the step
still returns ``ok``. The alternative — one bad feed failing the tick — is exactly the J6 behaviour
this replaces.
"""

from __future__ import annotations

from typing import Any

from writer_engine.ingestion import ingest_due_feeds, ingest_feed
from writer_engine.ingestion.store import get_feed
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app
from writer_engine.telemetry.logging import get_logger

STEP_NAME = "ingestion"

logger = get_logger(STEP_NAME)


def _totals(results: list[Any]) -> dict[str, Any]:
    return {
        "feeds": len(results),
        "items_fetched": sum(r.items_fetched for r in results),
        "items_uploaded": sum(r.items_uploaded for r in results),
        "items_skipped_existing": sum(r.items_skipped_existing for r in results),
        "items_skipped_irrelevant": sum(r.items_skipped_irrelevant for r in results),
        "items_skipped_unkeyable": sum(r.items_skipped_unkeyable for r in results),
        "items_skipped_unscrapeable": sum(r.items_skipped_unscrapeable for r in results),
        # Separate from unscrapeable: these are items we DID want and chose not to fetch because no
        # scraper is switched on. They are recoverable by re-running once one is.
        "items_deferred_no_scraper": sum(r.items_deferred_no_scraper for r in results),
        "items_failed": sum(r.items_failed for r in results),
        "feeds_with_errors": [{"feed": r.feed_name, "error": r.error} for r in results if r.error],
        "feeds_detail": [r.as_dict() for r in results],
    }


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "run").strip().lower()
    max_items = inp.payload.get("max_items")
    limit = int(inp.payload.get("limit") or 100)

    if op == "feed":
        feed_id = str(inp.payload.get("feed_id") or "").strip()
        if not feed_id:
            return StepOutput(
                execution_id=inp.execution_id,
                step_name=STEP_NAME,
                status=StepStatus.ERROR,
                error="op=feed requires feed_id",
            )
        feed = await get_feed(feed_id)
        if feed is None:
            return StepOutput(
                execution_id=inp.execution_id,
                step_name=STEP_NAME,
                status=StepStatus.ERROR,
                error=f"no feed source with id {feed_id}",
            )
        results = [await ingest_feed(feed, max_items=int(max_items) if max_items else None)]
    else:
        results = await ingest_due_feeds(limit=limit, max_items=int(max_items) if max_items else None)

    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=_totals(results),
    )


app = build_step_app(STEP_NAME, handler)
