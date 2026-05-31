"""gather-svc — pull the day's ingested articles from content_ingestion_v2 (md-only via ?include_html=0)."""

from __future__ import annotations

from writer_engine.config import get_settings
from writer_engine.idempotency import idempotent_call
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import IngestedArticle
from writer_engine.step_service import build_step_app

STEP_NAME = "gather"


async def _fetch(send_date: str, user_id: str, limit: int) -> list[dict]:
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
