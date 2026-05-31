"""persist-svc — idempotent UPSERT of the newsletter_sends_v2 row."""

from __future__ import annotations

from typing import Any

from writer_engine.config import get_settings
from writer_engine.idempotency import idempotent_call
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import NewsletterSendRow
from writer_engine.step_service import build_step_app

STEP_NAME = "persist"


async def _upsert(row: NewsletterSendRow, execution_id: str) -> dict[str, Any]:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        # Local-only echo when Supabase isn't configured.
        return {"id": f"local-{execution_id}", **row.model_dump(mode="json")}
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    payload = row.model_dump(mode="json")
    payload["metadata"] = {**(payload.get("metadata") or {}), "execution_id": execution_id}
    resp = await (
        client.table("newsletter_sends_v2").upsert(payload, on_conflict="edition_id,send_date").execute()
    )
    rows = getattr(resp, "data", None) or [payload]
    return rows[0]


async def handler(inp: StepInput) -> StepOutput:
    row = NewsletterSendRow.model_validate(inp.payload.get("row") or inp.payload)
    key = inp.idempotency_key or f"{inp.execution_id}:{STEP_NAME}"
    saved = await idempotent_call(key, ttl_seconds=300, func=lambda: _upsert(row, str(inp.execution_id)))
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"send_row": saved},
    )


app = build_step_app(STEP_NAME, handler)
