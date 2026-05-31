"""library-step — content lifecycle CRUD: insert / approve / publish / reject / schedule / retrieve / versions."""

from __future__ import annotations

from writer_engine.config import get_settings
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "library"


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
    action = str(payload.get("action") or "approve")
    content_id = payload.get("content_id")
    valid = {"approve", "publish", "reject", "schedule", "unschedule"}
    if action not in valid:
        return {"error": f"unknown action {action}"}
    new_status = {"approve": "approved", "publish": "published", "reject": "rejected"}.get(
        action, "scheduled"
    )
    client = await _supabase_or_none()
    if client is None:
        return {"id": content_id, "status": new_status}
    resp = await (
        client.table("published_content_v2").update({"status": new_status}).eq("id", content_id).execute()
    )
    return (getattr(resp, "data", None) or [{}])[0]


async def _op_retrieve(payload: dict) -> dict:
    client = await _supabase_or_none()
    if client is None:
        return {"items": [], "fixture": True}
    q = client.table("published_content_v2").select("id,title,status,content_type,project_id,created_at")
    if payload.get("user_id"):
        q = q.eq("user_id", payload["user_id"])
    if payload.get("status"):
        q = q.eq("status", payload["status"])
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
