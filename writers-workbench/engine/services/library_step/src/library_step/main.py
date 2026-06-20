"""library-step — content lifecycle CRUD: insert / approve / publish / reject / schedule / retrieve / versions."""

from __future__ import annotations

from datetime import UTC

from writer_engine.config import get_settings
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app
from writer_engine.telemetry.logging import get_logger

STEP_NAME = "library"
logger = get_logger("library_step")


async def _supabase_or_none():
    s = get_settings()
    if not s.supabase_url:
        return None
    from writer_engine.supabase.client import get_supabase_admin

    return await get_supabase_admin()


async def _op_insert_draft(payload: dict) -> dict:
    client = await _supabase_or_none()
    if client is None:
        return {"id": "local-draft", **payload, "status": "draft"}
    resp = await client.table("published_content_v2").insert({**payload, "status": "draft"}).execute()
    return (getattr(resp, "data", None) or [{}])[0]


async def _op_lifecycle(payload: dict) -> dict:
    """Approve / publish / reject / schedule / unschedule a piece of content.

    n8n parity (manage_library): on approve/publish snapshot the current text into
    ``content_versions_v2`` first (so the state before the lifecycle change is reversible), then flip
    the status, and email the user on approve/publish/reject/schedule. ``draft`` (back-to-draft) and
    ``unschedule`` change status silently. Best-effort email — never blocks the DB write."""
    from datetime import datetime

    action = str(payload.get("action") or "approve")
    content_id = payload.get("content_id")
    user_id = payload.get("user_id")
    valid = {"approve", "publish", "reject", "schedule", "unschedule", "draft"}
    if action not in valid:
        return {"error": f"unknown action {action}"}
    new_status = {
        "approve": "approved", "publish": "published", "reject": "rejected",
        "unschedule": "draft", "draft": "draft",
    }.get(action, "scheduled")
    client = await _supabase_or_none()
    if client is None:
        return {"id": content_id, "status": new_status}

    # Load the current row so we can snapshot it (approve/publish) and email with its title/type.
    cur = await (
        client.table("published_content_v2")
        .select("id,user_id,title,content_type,content_text,status,project_id,chapter_number,metadata")
        .eq("id", content_id).limit(1).execute()
    )
    rows = getattr(cur, "data", None) or []
    if not rows:
        return {"error": "content not found", "id": content_id}
    row = rows[0]
    row_user = row.get("user_id") or user_id

    # Snapshot before mutating on approve/publish — the auto-version n8n took at these gates.
    if action in {"approve", "publish"} and row.get("content_text"):
        try:
            last = await (
                client.table("content_versions_v2").select("version_number")
                .eq("content_id", content_id).order("version_number", desc=True).limit(1).execute()
            )
            last_rows = getattr(last, "data", None) or []
            next_version = int((last_rows[0].get("version_number") if last_rows else 0) or 0) + 1
            await client.table("content_versions_v2").insert({
                "content_id": content_id, "user_id": row_user, "version_number": next_version,
                "content_text": row.get("content_text"), "changed_by": f"lifecycle_{action}",
                "change_note": f"auto-snapshot before {action}",
            }).execute()
        except Exception as exc:  # snapshot is best-effort; never block the lifecycle change
            logger.warning("lifecycle.snapshot_failed", action=action, error=str(exc)[:200])

    updates: dict = {"status": new_status, "updated_at": datetime.now(UTC).isoformat()}
    meta = dict(row.get("metadata") or {})
    if action == "publish":
        updates["published_at"] = datetime.now(UTC).isoformat()
    if action == "schedule" and payload.get("schedule_date"):
        meta["schedule_date"] = payload["schedule_date"]
        updates["metadata"] = meta
    if action == "unschedule" and "schedule_date" in meta:
        meta.pop("schedule_date", None)
        updates["metadata"] = meta

    resp = await (
        client.table("published_content_v2").update(updates).eq("id", content_id).execute()
    )
    out = (getattr(resp, "data", None) or [{**row, **updates}])[0]

    # Email the user (approve/publish/reject/schedule) — best-effort, mirrors n8n's Gmail node.
    try:
        from writer_engine.notifications.task_email import send_lifecycle_email

        await send_lifecycle_email(client, row_user, {**row, **updates}, new_status)
    except Exception as exc:
        logger.warning("lifecycle.email_failed", action=action, error=str(exc)[:200])
    return out


async def _op_retrieve(payload: dict) -> dict:
    client = await _supabase_or_none()
    if client is None:
        return {"items": [], "fixture": True}
    q = client.table("published_content_v2").select(
        "id,title,status,content_type,project_id,chapter_number,created_at"
    )
    # project_id scopes the query to one project (the UI's project view); content_type narrows it
    # (e.g. just chapters). When a project_id is given, order by chapter so the UI lists them in order.
    if payload.get("project_id"):
        q = q.eq("project_id", payload["project_id"])
    if payload.get("user_id"):
        q = q.eq("user_id", payload["user_id"])
    if payload.get("content_type"):
        q = q.eq("content_type", payload["content_type"])
    if payload.get("status"):
        q = q.eq("status", payload["status"])
    if payload.get("project_id"):
        q = q.order("chapter_number", desc=False)
    resp = await q.limit(int(payload.get("limit") or 50)).execute()
    return {"items": getattr(resp, "data", None) or []}


async def _op_list_outlines(payload: dict) -> dict:
    client = await _supabase_or_none()
    if client is None:
        return {"items": []}
    resp = await (
        client.table("writing_projects_v2")
        .select("id,title,outline")
        .neq("outline", "{}")
        .limit(int(payload.get("limit") or 50))
        .execute()
    )
    return {"items": getattr(resp, "data", None) or []}


OPS = {
    "insert-draft": _op_insert_draft,
    "lifecycle": _op_lifecycle,
    "retrieve": _op_retrieve,
    "list-outlines": _op_list_outlines,
}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "retrieve")
    if op not in OPS:
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error={"code": "UNKNOWN_OP", "message": op},  # type: ignore[arg-type]
        )
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": await OPS[op](inp.payload)},
    )


app = build_step_app(STEP_NAME, handler)
