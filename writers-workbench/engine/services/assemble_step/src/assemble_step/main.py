"""assemble-svc — write the intro + other-stories roundup and concatenate the full markdown body."""

from __future__ import annotations

from writer_engine.llm import LLMRouter, ProviderNotRegistered, get_router
from writer_engine.prompt_store import get_prompt_store, seed_default_prompts
from writer_engine.prompt_store.n8n_translate import render_live_prompt
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import AssembledNewsletter, StorySegment
from writer_engine.step_service import build_step_app

STEP_NAME = "assemble"
seed_default_prompts()
DEFAULT_MODEL = "claude-haiku-4-5"


async def _short(router: LLMRouter, system_key: str, user_key: str, model: str, **vars_: str) -> str:
    store = get_prompt_store()
    system = store.get(system_key)
    # A2: render the real n8n brief for this key when one exists (intro 6.9k chars,
    # other_top_stories 10.8k) instead of the placeholder seed.
    user = render_live_prompt(user_key, store, **vars_)
    resp = await router.complete(
        provider="anthropic", model=model, system=system, prompt=user, max_tokens=600, temperature=0.5
    )
    return resp.text.strip()


def _fixture_intro(stories: list[StorySegment]) -> str:
    titles = ", ".join(s.story_title for s in stories[:3]) or "today's news"
    return f"Today: {titles}."


def _fixture_other(remaining: list[dict]) -> str:
    bullets = "\n".join(f"- {r.get('title', '')}" for r in remaining[:5])
    return bullets or "(none)"


async def handler(inp: StepInput) -> StepOutput:
    segments = [StorySegment.model_validate(s) for s in (inp.payload.get("segments") or [])]
    remaining_items = list(inp.payload.get("remaining_items") or [])
    model = str(inp.payload.get("model") or DEFAULT_MODEL)
    router = get_router(service=STEP_NAME)

    try:
        intro = await _short(
            router,
            "newsletter.intro.system",
            "newsletter.intro.user_template",
            model,
            story_sections="\n\n".join(
                f"## {s.story_title}\n{s.newsletter_section_content}" for s in segments
            ),
            subject_line=str(inp.payload.get("subject_line") or ""),
            pre_header=str(inp.payload.get("pre_header") or ""),
            newsletter_date=str(inp.payload.get("newsletter_date") or ""),
        )
    except ProviderNotRegistered:
        intro = _fixture_intro(segments)

    try:
        other = await _short(
            router,
            "newsletter.other_top_stories.system",
            "newsletter.other_top_stories.user_template",
            model,
            story_sections="\n".join(s.story_title for s in segments),
            articles="\n".join(
                f"- ({r.get('id')}) {r.get('title')} — {r.get('source_name')}" for r in remaining_items
            ),
            subject_line=str(inp.payload.get("subject_line") or ""),
            newsletter_date=str(inp.payload.get("newsletter_date") or ""),
        )
    except ProviderNotRegistered:
        other = _fixture_other(remaining_items)

    body_parts: list[str] = [intro, ""]
    for seg in segments:
        body_parts.append(f"## {seg.story_title}\n")
        if seg.chosen_image_url:
            body_parts.append(f"![]({seg.chosen_image_url})\n")
        body_parts.append(seg.newsletter_section_content + "\n")
    if other:
        body_parts.append("\n## Other top stories\n")
        body_parts.append(other + "\n")
    markdown = "\n".join(body_parts).strip()

    result = AssembledNewsletter(
        intro=intro, segments=segments, other_top_stories=other, markdown_body=markdown
    )
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=result.model_dump(mode="json"),
    )


app = build_step_app(STEP_NAME, handler)
