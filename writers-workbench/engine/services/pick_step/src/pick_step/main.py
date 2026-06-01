"""pick-svc — Gemini 2.5 Pro picks the top stories (decision #2)."""

from __future__ import annotations

from writer_engine.config import get_settings
from writer_engine.llm import LLMRouter, ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import get_prompt_store, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import PickedStories
from writer_engine.step_service import build_step_app

STEP_NAME = "pick"
seed_default_prompts()


def _fixture(max_stories: int) -> PickedStories:
    return PickedStories(
        top_selected_stories=[
            {
                "title": f"Fixture story {i}",
                "summary": "Placeholder summary.",
                "identifiers": [f"fx-{i}"],
                "external_source_links": [],
            }
            for i in range(min(3, max_stories))
        ],
        chain_of_thought="fixture",
    )


async def _pick(
    router: LLMRouter, articles: list[dict], max_stories: int, feedback: str | None
) -> PickedStories:
    settings = get_settings()
    store = get_prompt_store()
    system = store.get("newsletter.pick_top_stories.system")
    user_template = store.get("newsletter.pick_top_stories.user_template")
    articles_text = "\n\n".join(
        f"- ({a.get('id')}) {a.get('title')} — {a.get('source_name')}" for a in articles
    )
    user = user_template.format(articles=articles_text, max_stories=max_stories)
    if feedback:
        user += f"\n\nOperator feedback from prior round (incorporate): {feedback}"
    picked, _resp = await complete_structured(
        router,
        provider="gemini",
        model=settings.picker_model,
        system=system,
        prompt=user,
        schema=PickedStories,
        # Output scales with max_stories (each story carries a detailed summary). Give generous
        # headroom so the JSON is never truncated mid-string ("Unterminated string").
        max_tokens=max(8192, 2048 * max_stories),
    )
    return picked


async def handler(inp: StepInput) -> StepOutput:
    articles = list(inp.payload.get("articles") or [])
    max_stories = int(inp.payload.get("max_stories") or 5)
    feedback = inp.payload.get("feedback")
    router = get_router(service=STEP_NAME)
    try:
        picked = await _pick(router, articles, max_stories, feedback)
    except ProviderNotRegistered:
        picked = _fixture(max_stories)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=picked.model_dump(mode="json"),
    )


app = build_step_app(STEP_NAME, handler)
