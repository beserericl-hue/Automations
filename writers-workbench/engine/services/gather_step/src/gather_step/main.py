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


class Scope:
    """Which of a user's ingested rows belong to one edition, and how many days it reads.

    Ingested rows carry no edition: every edition a user owns used to read the same pool, so a
    post-apocalyptic edition's picker was handed AI news and the other way round, and only the
    genre line in the pick prompt kept them apart. A row is the edition's when its ``feed_url`` is
    one of the edition's fetched feeds, or when its key carries the edition's tag (the rows the
    engine writes for radar:// and social:// sources, see ``writer_engine.social.feed``).
    """

    def __init__(self, urls: set[str], tag: str, window_days: int) -> None:
        self.urls = urls
        self.tag = tag
        self.window_days = window_days

    def owns(self, row: dict) -> bool:
        if str(row.get("feed_url") or "").lower() in self.urls:
            return True
        return bool(self.tag) and str(row.get("key") or "").endswith(f".{self.tag}")


WINDOW_DAYS = {"weekly": 7, "biweekly": 14, "monthly": 31}
"""A weekly edition's issue covers the week: its radar slate lands on Sunday or Monday and its
posts go out across the week, so a Friday send that read only Friday would miss nearly all of it."""


async def _scope(edition_id: str, user_id: str) -> Scope | None:
    """The edition's scope, or None for "no edition / no feeds": then the user's whole pool, as before."""
    settings = get_settings()
    if not edition_id or not settings.supabase_url or not settings.supabase_service_role_key:
        return None
    from writer_engine.social.feed import ENGINE_URL_TYPES, edition_tag
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    feeds = await (
        client.table("newsletter_feed_sources_v2")
        .select("url,url_type")
        .eq("user_id", user_id)
        .eq("edition_id", edition_id)
        .execute()
    )
    rows = list(getattr(feeds, "data", None) or [])
    if not rows:
        return None
    editions = (
        await client.table("newsletter_editions_v2").select("cadence").eq("id", edition_id).limit(1).execute()
    )
    cadence = str(((getattr(editions, "data", None) or [{}])[0] or {}).get("cadence") or "")
    urls = {str(r.get("url") or "").lower() for r in rows if r.get("url_type") not in ENGINE_URL_TYPES}
    return Scope(urls, edition_tag(edition_id), WINDOW_DAYS.get(cadence, 1))


async def _fetch(send_date: str, user_id: str, limit: int, edition_id: str = "") -> list[dict]:
    """The send day's ingested articles; when it has none yet, the most recent earlier day's.

    Ingestion keys an article by the UTC day it was fetched, and the send date is a UTC day too, so
    a newsletter generated just after midnight UTC (evening in the Americas) looked at a day that had
    just begun and found nothing: the saga ended at ``skipped_no_content`` with six stories from the
    day before sitting unused. Measured on DEV 2026-10-27 00:05 UTC. Yesterday is used only when
    today is empty, because on a normal day its stories already went into yesterday's issue.

    With an ``edition_id`` whose edition has feeds, only that edition's rows count, and a weekly
    (biweekly, monthly) edition reads its whole window instead of one day.
    """
    scope = await _scope(edition_id, user_id) if edition_id else None
    if scope is not None and scope.window_days > 1:
        return await _fetch_window(send_date, user_id, limit, scope)
    extra = {"scope": scope} if scope is not None else {}
    rows = await _fetch_day(send_date, user_id, limit, **extra)
    if rows:
        return rows
    for day in _earlier_days(send_date, LOOKBACK_DAYS):
        rows = await _fetch_day(day, user_id, limit, **extra)
        if rows:
            return rows
    return []


_COLUMNS = "id,key,user_id,type,title,source_name,source_url,external_source_urls,image_urls,published_timestamp,feed_url"


async def _fetch_window(send_date: str, user_id: str, limit: int, scope: Scope) -> list[dict]:
    from datetime import date, timedelta

    try:
        end = date.fromisoformat(send_date)
    except ValueError:
        return []
    start = end - timedelta(days=scope.window_days - 1)
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    resp = await (
        client.table("content_ingestion_v2")
        .select(_COLUMNS)
        .gte("key", f"{start.isoformat()}/")
        .lt("key", f"{(end + timedelta(days=1)).isoformat()}/")
        .eq("user_id", user_id)
        .neq("type", "newsletter")
        .order("published_timestamp", desc=True)
        .limit(limit * 6)
        .execute()
    )
    rows = [r for r in (getattr(resp, "data", None) or []) if scope.owns(r)]
    return rows[:limit]


async def _fetch_day(send_date: str, user_id: str, limit: int, scope: Scope | None = None) -> list[dict]:
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
        .select(_COLUMNS)
        .like("key", f"{send_date}/%")
        .eq("user_id", user_id)
        .neq("type", "newsletter")
        .order("published_timestamp", desc=True)
        # Scoped, the edition's rows are found among the user's others; read past them.
        .limit(limit * 6 if scope is not None else limit)
        .execute()
    )
    rows = list(getattr(resp, "data", None) or [])
    if scope is not None:
        rows = [r for r in rows if scope.owns(r)][:limit]
    return rows


async def handler(inp: StepInput) -> StepOutput:
    send_date = str(inp.payload.get("send_date") or "")
    user_id = str(inp.payload.get("user_id") or "")
    limit = int(inp.payload.get("limit") or 50)
    edition_id = str(inp.payload.get("edition_id") or "")

    key = inp.idempotency_key or f"{inp.execution_id}:{STEP_NAME}"
    rows = await idempotent_call(
        key, ttl_seconds=300, func=lambda: _fetch(send_date, user_id, limit, edition_id=edition_id)
    )
    articles = [IngestedArticle.model_validate(r).model_dump(mode="json") for r in rows]
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"articles": articles, "count": len(articles)},
    )


app = build_step_app(STEP_NAME, handler)
