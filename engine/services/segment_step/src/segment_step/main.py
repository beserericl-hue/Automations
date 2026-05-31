"""segment-svc — write one newsletter section per selected story (called once per story for fan-out)."""

from __future__ import annotations

import json

from writer_engine.llm import LLMRouter, ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import get_prompt_store, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import StorySegment
from writer_engine.step_service import build_step_app

STEP_NAME = "segment"
seed_default_prompts()
DEFAULT_MODEL = "claude-sonnet-4-6"


def _fixture(story: dict) -> StorySegment:
    return StorySegment(
        story_title=str(story.get("title") or "Story"),
        newsletter_section_content="Placeholder section content — segment-svc fixture.",
        chosen_image_url=None,
        image_options=[],
    )


async def _write(
    router: LLMRouter, story: dict, sources: list[dict], image_options: list[str], model: str
) -> StorySegment:
    store = get_prompt_store()
    system = store.get("newsletter.segment.system")
    user_template = store.get("newsletter.segment.user_template")
    user = user_template.format(
        story_json=json.dumps(story, ensure_ascii=False),
        sources="\n\n".join(f"# {s.get('title', '')}\n{s.get('markdown', '')}" for s in sources)[:8000],
        images="\n".join(image_options) or "(none)",
    )
    segment, _ = await complete_structured(
        router,
        provider="anthropic",
        model=model,
        system=system,
        prompt=user,
        schema=StorySegment,
    )
    return segment


async def handler(inp: StepInput) -> StepOutput:
    story = dict(inp.payload.get("story") or {})
    sources = list(inp.payload.get("sources") or [])
    image_options = [str(u) for u in (inp.payload.get("image_options") or [])]
    model = str(inp.payload.get("model") or DEFAULT_MODEL)
    router = get_router(service=STEP_NAME)
    try:
        seg = await _write(router, story, sources, image_options, model)
    except ProviderNotRegistered:
        seg = _fixture(story)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=seg.model_dump(mode="json"),
    )


app = build_step_app(STEP_NAME, handler)
