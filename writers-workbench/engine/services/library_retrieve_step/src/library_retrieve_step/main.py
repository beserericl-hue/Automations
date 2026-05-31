"""The vertical-slice step service.

Returns a list of recent ``content_ingestion_v2`` rows for the given user_id (or an in-memory fixture when
Supabase isn't configured — so the local docker-compose demo works without secrets). This is intentionally simple
to prove the engine's plumbing without LLM/IO cost.
"""

from __future__ import annotations

from typing import Any

from writer_engine.config import get_settings
from writer_engine.idempotency import idempotent_call
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "library_retrieve"


async def _fetch_items(user_id: str, limit: int) -> list[dict[str, Any]]:
    """Pull recent items from Supabase, or return a small fixture if Supabase is not configured."""
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        return [
            {"id": "fixture-1", "title": "Hello, engine", "user_id": user_id},
            {"id": "fixture-2", "title": "Vertical slice", "user_id": user_id},
        ][:limit]
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    resp = await (
        client.table("content_ingestion_v2")
        .select("id,title,user_id,created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return list(getattr(resp, "data", None) or [])


async def handler(inp: StepInput) -> StepOutput:
    """Step entry point — uses ``idempotent_call`` so retries are free."""
    user_id = str(inp.payload.get("user_id") or "00000000-0000-0000-0000-000000000000")
    limit = int(inp.payload.get("limit") or 10)
    key = inp.idempotency_key or f"{inp.execution_id}:{STEP_NAME}"

    items = await idempotent_call(
        key,
        ttl_seconds=300,
        func=lambda: _fetch_items(user_id, limit),
    )
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"items": items, "count": len(items)},
    )


app = build_step_app(STEP_NAME, handler)
