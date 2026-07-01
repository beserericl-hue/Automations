"""story-bible-step — add / edit / delete / list with (entry_type, lower(name)) dedupe."""

from __future__ import annotations

from writer_engine.config import get_settings
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "story_bible"


async def _supabase_or_none():
    s = get_settings()
    if not s.supabase_url:
        return None
    from writer_engine.supabase.client import get_supabase_admin

    return await get_supabase_admin()


async def _op_add(payload: dict) -> dict:
    client = await _supabase_or_none()
    entry = payload.get("entry") or {}
    if client is None:
        return {"entry": entry, "deduped": False}
    resp = await (
        client.table("story_bible_v2").upsert(entry, on_conflict="project_id,entry_type,name").execute()
    )
    return {"entry": (getattr(resp, "data", None) or [entry])[0], "deduped": True}


async def _op_list(payload: dict) -> dict:
    client = await _supabase_or_none()
    if client is None:
        return {"entries": []}
    # G3: chat/voice supply a project TITLE ('get the story bible for X'), not an id — resolve it.
    project_id = payload.get("project_id")
    if not project_id and payload.get("project_title"):
        from writer_engine.persist_helpers import resolve_project_id

        project_id, _row = await resolve_project_id(
            client, user_id=payload.get("user_id"), title=str(payload["project_title"])
        )
        if not project_id:
            return {"entries": [], "found": False,
                    "message": f"No project matching '{payload['project_title']}' found."}
    resp = await (
        client.table("story_bible_v2").select("*").eq("project_id", project_id).execute()
    )
    rows = getattr(resp, "data", None) or []
    return {"entries": rows, "count": len(rows), "found": bool(rows), "project_id": project_id}


OPS = {"add": _op_add, "list": _op_list}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "list")
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
