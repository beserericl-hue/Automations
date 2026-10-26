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
    """Add or update one entry, de-duped on (project_id, entry_type, name).

    Was ``upsert(on_conflict="project_id,entry_type,name")``, which needs a UNIQUE constraint the
    table does not have: on DEV every call raised 42P10, so "add X to the story bible" never saved.
    Goes through ``persist_bible`` now, the same select-then-write the chapter path uses.
    """
    client = await _supabase_or_none()
    entry = payload.get("entry") or {}
    if client is None:
        return {"entry": entry, "deduped": False}
    project_id = str(entry.get("project_id") or payload.get("project_id") or "")
    user_id = str(entry.get("user_id") or payload.get("user_id") or "")
    if not project_id or not user_id or not entry.get("name"):
        return {
            "entry": entry,
            "deduped": False,
            "saved": False,
            "reason": "project_id, user_id and name required",
        }
    from writer_engine.persist_helpers import persist_bible

    saved = await persist_bible(client, project_id=project_id, user_id=user_id, entries=[entry])
    return {"entry": entry, "deduped": True, "saved": bool(saved)}


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
            return {
                "entries": [],
                "found": False,
                "message": f"No project matching '{payload['project_title']}' found.",
            }
    resp = await (
        client.table("story_bible_v2")
        .select("*")
        .eq("project_id", project_id)
        .is_("deleted_at", None)  # trashed entries are not part of the bible
        .execute()
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
