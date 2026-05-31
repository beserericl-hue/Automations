"""chapter-step — write / qa / scan-drift / evaluate-genre / extract-bible / format-kindle.

Operations dispatch via ``payload["op"]``. Real LLM logic and Sprint-15 model selection arrive in F1-1/F1-2.
"""

from __future__ import annotations

from uuid import uuid4

from writer_engine.prompt_store import seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.chapter import (
    BibleEntry,
    DriftFinding,
    DriftScanResult,
    WriteChapterRequest,
    WriteChapterResponse,
)
from writer_engine.step_service import build_step_app

STEP_NAME = "chapter"
seed_default_prompts()


async def _op_write(payload: dict) -> dict:
    req = WriteChapterRequest.model_validate(payload)
    resp = WriteChapterResponse(
        chapter_id=uuid4(),
        chapter_run_id=req.chapter_run_id,
        content_text=f"(F1 placeholder) chapter {req.chapter_number} for project {req.project_id}",
        word_count=12,
        sub_chapter_count=req.sub_chapter_count_override or 5,
        bible_entries_added=0,
    )
    return resp.model_dump(mode="json")


async def _op_qa(payload: dict) -> dict:
    return {
        "chapter_id": payload.get("chapter_id"),
        "scores": {"voice": 0.92, "pacing": 0.88, "continuity": 0.94},
        "findings": [],
    }


async def _op_scan_drift(payload: dict) -> dict:
    return DriftScanResult(
        chapter_id=payload.get("chapter_id") or uuid4(),
        findings=[DriftFinding(kind="placeholder", detail="no drift detected (F1 stub)")],
    ).model_dump(mode="json")


async def _op_evaluate_genre(payload: dict) -> dict:
    return {"genre_score": 0.91, "notes": ["F1 placeholder"]}


async def _op_extract_bible(payload: dict) -> dict:
    entries = [
        BibleEntry(entry_type="character", name="Placeholder", description="F1 stub").model_dump(mode="json")
    ]
    return {"entries": entries, "added": len(entries)}


async def _op_format_kindle(payload: dict) -> dict:
    return {"docx_storage_path": f"kindle/{payload.get('chapter_id', 'unknown')}.docx"}


OPS = {
    "write": _op_write,
    "qa": _op_qa,
    "scan-drift": _op_scan_drift,
    "evaluate-genre": _op_evaluate_genre,
    "extract-bible": _op_extract_bible,
    "format-kindle": _op_format_kindle,
}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "write")
    if op not in OPS:
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error={"code": "UNKNOWN_OP", "message": f"unknown op '{op}'"},  # type: ignore[arg-type]
        )
    result = await OPS[op](inp.payload)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": result},
    )


app = build_step_app(STEP_NAME, handler)
