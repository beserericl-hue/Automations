"""brainstorm-step — story / chapter / edit-outline."""

from __future__ import annotations

from writer_engine.prompt_store import seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "brainstorm"
seed_default_prompts()


async def _op_story(payload: dict) -> dict:
    return {
        "outline": {
            "title": payload.get("title", "Untitled"),
            "premise": "(F1 placeholder premise)",
            "themes": [],
            "characters": [],
            "chapters": [],
        }
    }


async def _op_chapter(payload: dict) -> dict:
    return {"chapter_outline": {"chapter_number": payload.get("chapter_number", 1), "beats": []}}


async def _op_edit_outline(payload: dict) -> dict:
    edits = list(payload.get("edits") or [])
    return {"applied": len(edits), "outline": payload.get("outline") or {}}


OPS = {"story": _op_story, "chapter": _op_chapter, "edit-outline": _op_edit_outline}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "story")
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
