"""segment-svc — write one newsletter section per selected story (called once per story for fan-out)."""

from __future__ import annotations

from writer_engine.llm import LLMRouter, ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import get_prompt_store, seed_default_prompts
from writer_engine.prompt_store.n8n_translate import render_live_prompt
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
    router: LLMRouter,
    story: dict,
    sources: list[dict],
    image_options: list[str],
    model: str,
    *,
    ctx: dict | None = None,
) -> StorySegment:
    store = get_prompt_store()
    system = store.get("newsletter.segment.system")
    ctx = ctx or {}
    src_text = "\n\n".join(f"# {s.get('title', '')}\n{s.get('markdown', '')}" for s in sources)[:8000]
    # A2: the real n8n segment brief (16.5k chars) instead of the placeholder. Image options are not
    # part of the n8n prompt's field set, so they are appended rather than interpolated.
    user = render_live_prompt(
        "newsletter.segment.user_template",
        store,
        story_title=str(story.get("title") or ""),
        story_summary=str(story.get("summary") or ""),
        segment_sources=src_text,
        external_sources=src_text,
        subject_line=str(ctx.get("subject_line") or ""),
        pre_header=str(ctx.get("pre_header") or ""),
        newsletter_date=str(ctx.get("newsletter_date") or ""),
    )
    if image_options:
        user += "\n\nAVAILABLE IMAGE URLS (choose at most one):\n" + "\n".join(image_options)
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
        seg = await _write(
            router,
            story,
            sources,
            image_options,
            model,
            ctx={
                "subject_line": inp.payload.get("subject_line"),
                "pre_header": inp.payload.get("pre_header"),
                "newsletter_date": inp.payload.get("newsletter_date"),
            },
        )
    except ProviderNotRegistered:
        seg = _fixture(story)
    # The model sometimes omits the title; backfill the authoritative story title so downstream
    # stages (image gate, chosen-image matching, assemble) can key on it reliably.
    if not seg.story_title:
        seg.story_title = str(story.get("title") or "Story")
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=seg.model_dump(mode="json"),
    )


app = build_step_app(STEP_NAME, handler)
