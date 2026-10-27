"""gather-svc — pull the day's ingested articles from content_ingestion_v2 (md-only via ?include_html=0)."""

from __future__ import annotations

from writer_engine.config import get_settings
from writer_engine.idempotency import idempotent_call
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import IngestedArticle
from writer_engine.step_service import build_step_app

STEP_NAME = "gather"


LOOKBACK_DAYS = 2
"""How many earlier days to fall back through when the send day has nothing ingested yet."""


def _earlier_days(send_date: str, days: int) -> list[str]:
    from datetime import date, timedelta

    try:
        d = date.fromisoformat(send_date)
    except ValueError:
        return []
    return [(d - timedelta(days=n)).isoformat() for n in range(1, days + 1)]


async def _fetch(send_date: str, user_id: str, limit: int) -> list[dict]:
    """The send day's ingested articles; when it has none yet, the most recent earlier day's.

    Ingestion keys an article by the UTC day it was fetched, and the send date is a UTC day too, so
    a newsletter generated just after midnight UTC (evening in the Americas) looked at a day that had
    just begun and found nothing: the saga ended at ``skipped_no_content`` with six stories from the
    day before sitting unused. Measured on DEV 2026-10-27 00:05 UTC. Yesterday is used only when
    today is empty, because on a normal day its stories already went into yesterday's issue.
    """
    rows = await _fetch_day(send_date, user_id, limit)
    if rows:
        return rows
    for day in _earlier_days(send_date, LOOKBACK_DAYS):
        rows = await _fetch_day(day, user_id, limit)
        if rows:
            return rows
    return []


async def _fetch_day(send_date: str, user_id: str, limit: int) -> list[dict]:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        # Local-demo fixture so the engine boots without Supabase.
        return [
            {
                "id": f"fx-{i}",
                "key": f"{send_date}/story-{i}",
                "user_id": user_id,
                "type": "article",
                "title": f"Fixture story {i}",
                "source_name": "fixture",
                "markdown": f"# Fixture {i}\n\nLorem ipsum.",
            }
            for i in range(min(3, limit))
        ]
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    resp = await (
        client.table("content_ingestion_v2")
        .select(
            "id,key,user_id,type,title,source_name,source_url,external_source_urls,image_urls,published_timestamp"
        )
        .like("key", f"{send_date}/%")
        .eq("user_id", user_id)
        .neq("type", "newsletter")
        .order("published_timestamp", desc=True)
        .limit(limit)
        .execute()
    )
    return list(getattr(resp, "data", None) or [])


async def handler(inp: StepInput) -> StepOutput:
    send_date = str(inp.payload.get("send_date") or "")
    user_id = str(inp.payload.get("user_id") or "")
    limit = int(inp.payload.get("limit") or 50)

    key = inp.idempotency_key or f"{inp.execution_id}:{STEP_NAME}"
    rows = await idempotent_call(key, ttl_seconds=300, func=lambda: _fetch(send_date, user_id, limit))
    articles = [IngestedArticle.model_validate(r).model_dump(mode="json") for r in rows]
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"articles": articles, "count": len(articles)},
    )


app = build_step_app(STEP_NAME, handler)
