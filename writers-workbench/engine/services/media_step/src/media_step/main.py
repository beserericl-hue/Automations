"""media-step — cover-art / social-posts / scrape-url."""

from __future__ import annotations

from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "media"


async def _op_cover_art(payload: dict) -> dict:
    project_id = payload.get("project_id", "unknown")
    return {"image_url": f"https://placehold.co/1600x2400?text={project_id}", "provider": "stub"}


async def _op_social_posts(payload: dict) -> dict:
    platforms = list(payload.get("platforms") or ["twitter", "linkedin"])
    return {p: f"(F1 placeholder post for {p})" for p in platforms}


async def _op_scrape_url(payload: dict) -> dict:
    return {"url": payload.get("url"), "markdown": "(F1 placeholder)", "html": "", "metadata": {}}


OPS = {"cover-art": _op_cover_art, "social-posts": _op_social_posts, "scrape-url": _op_scrape_url}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "cover-art")
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
