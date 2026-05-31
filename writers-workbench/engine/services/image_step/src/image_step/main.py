"""image-svc — propose image options for one story (mirrors n8n `extract_image_urls`)."""

from __future__ import annotations

from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import ImageOptions
from writer_engine.step_service import build_step_app

STEP_NAME = "image"


async def handler(inp: StepInput) -> StepOutput:
    story = dict(inp.payload.get("story") or {})
    article_images = [str(u) for u in (story.get("image_urls") or [])]
    extra = [str(u) for u in (inp.payload.get("scraped_images") or [])]
    options = list(dict.fromkeys(article_images + extra))[:5]
    auto = options[0] if options else None
    result = ImageOptions(story_title=str(story.get("title") or "Story"), options=options, auto_pick=auto)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=result.model_dump(mode="json"),
    )


app = build_step_app(STEP_NAME, handler)
