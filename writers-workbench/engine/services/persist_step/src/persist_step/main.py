"""persist-svc — idempotent UPSERT of the newsletter_sends_v2 row."""

from __future__ import annotations

from typing import Any

from writer_engine.config import get_settings
from writer_engine.idempotency import idempotent_call
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import NewsletterSendRow
from writer_engine.step_service import build_step_app

STEP_NAME = "persist"

# Engine domain status → the newsletter_sends_v2 CHECK enum
# (draft|scheduled|sending|sent|failed|cancelled). The saga persists a freshly rendered-but-unsent
# row as "saved"; that is a "draft" in table terms until deliver-svc sends it.
_DB_STATUS = {
    "saved": "draft",
    "draft": "draft",
    "scheduled": "scheduled",
    "sending": "sending",
    "sent": "sent",
    "failed": "failed",
    "cancelled": "cancelled",
}


def _to_db_row(row: NewsletterSendRow, execution_id: str) -> dict[str, Any]:
    """Translate the engine domain row to actual ``newsletter_sends_v2`` columns.

    The table column is ``preheader`` (not ``pre_header_text``), ``status`` is a constrained enum,
    and ``user_id`` is ``NOT NULL``. Idempotency key for the upsert is ``(edition_id, send_date)``
    (unique index added in migration 024).
    """
    return {
        "user_id": row.user_id,
        "edition_id": row.edition_id,
        "send_date": row.send_date,
        "subject": row.subject,
        "preheader": row.pre_header_text,
        "markdown_body": row.markdown_body,
        "html_body": row.html_body,
        "status": _DB_STATUS.get(row.status, "draft"),
        "metadata": {**(row.metadata or {}), "execution_id": execution_id},
    }


async def _upsert(row: NewsletterSendRow, execution_id: str) -> dict[str, Any]:
    settings = get_settings()
    db_row = _to_db_row(row, execution_id)
    if not settings.supabase_url or not settings.supabase_service_role_key:
        # Local-only echo when Supabase isn't configured.
        return {"id": f"local-{execution_id}", **db_row}
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    resp = await (
        client.table("newsletter_sends_v2").upsert(db_row, on_conflict="edition_id,send_date").execute()
    )
    rows = getattr(resp, "data", None) or [db_row]
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
