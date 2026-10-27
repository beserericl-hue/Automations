"""pick-svc — Gemini 2.5 Pro picks the top stories (decision #2)."""

from __future__ import annotations

from datetime import date

from writer_engine.config import get_settings
from writer_engine.llm import LLMRouter, ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import get_prompt_store, seed_default_prompts
from writer_engine.prompt_store.n8n_translate import render_live_prompt
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import PickedStories
from writer_engine.step_service import build_step_app
from writer_engine.telemetry.logging import get_logger

PICK_KEY = "newsletter.pick_top_stories.user_template"


STEP_NAME = "pick"
logger = get_logger(STEP_NAME)
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


def _audience_directive(genre: str | None) -> str:
    """A genre-specific audience line so the picker selects on-theme stories.

    The default seed prompt targets a generic "technical reader"; for a themed edition
    (e.g. a post-apocalyptic fiction newsletter) that filters out exactly the stories the
    reader wants. When the edition carries a genre we override the audience here.
    """
    g = (genre or "").strip()
    if not g:
        return ""
    label = g.replace("-", " ").replace("_", " ")
    return (
        f"\n\nAUDIENCE OVERRIDE: This newsletter is a {label} publication. Pick the stories that "
        f"matter most to readers who love {label} — prioritise on-theme articles and de-prioritise "
        f"off-topic items. Ignore any earlier instruction to select for a generic technical reader."
    )


async def _pick(
    router: LLMRouter,
    articles: list[dict],
    max_stories: int,
    feedback: str | None,
    genre: str | None = None,
    newsletter_date: str | None = None,
) -> PickedStories:
    settings = get_settings()
    store = get_prompt_store()
    system = store.get("newsletter.pick_top_stories.system") + _audience_directive(genre)
    articles_text = "\n\n".join(
        f"- ({a.get('id')}) {a.get('title')} — {a.get('source_name')}" for a in articles
    )
    # A2: render the REAL n8n editorial brief, not the 2-line placeholder seed. The baseline brief
    # (15.7k chars) is what encodes catchiest-first ordering, "avoid AI-safety stories", "avoid
    # course ads", no duplicate company/subject, and source-dedup into one story slot — 18 months of
    # editorial tuning that the placeholder threw away. See prompt_store.n8n_translate.
    user = render_live_prompt(
        PICK_KEY,
        store,
        articles=articles_text,
        max_stories=max_stories,
        newsletter_date=newsletter_date or date.today().isoformat(),
    )
    if feedback:
        user += f"\n\nOperator feedback from prior round (incorporate): {feedback}"
    # Output scales with max_stories (each story carries a detailed summary). Give generous headroom
    # so the JSON is never truncated mid-string ("Unterminated string").
    max_tokens = max(8192, 2048 * max_stories)
    try:
        picked, _resp = await complete_structured(
            router,
            provider="gemini",
            model=settings.picker_model,
            system=system,
            prompt=user,
            schema=PickedStories,
            max_tokens=max_tokens,
        )
        # Logged on success too, so a run's log says which provider picked it. Without this line a
        # healthy pick and a silent fallback looked the same until the fallback's warning appeared.
        _log_picked(picked, provider="gemini", model=settings.picker_model, fallback=False)
        return picked
    except ProviderNotRegistered:
        raise
    except Exception as exc:
        # One provider's failure must not stop the newsletter. On DEV 2026-10-27 the Gemini key was
        # rejected ("API key not valid") and every newsletter died at the pick step before its first
        # approval gate. The same brief goes to Anthropic, and the failure is mailed once so the key
        # gets replaced rather than the fallback quietly becoming the way it works.
        logger.warning("pick.gemini_failed_falling_back", error=f"{type(exc).__name__}: {exc}"[:240])
        await _alert_gemini_failed(exc)
        picked, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=settings.model_default,
            system=system,
            prompt=user,
            schema=PickedStories,
            max_tokens=max_tokens,
        )
        _log_picked(picked, provider="anthropic", model=settings.model_default, fallback=True)
        return picked


def _log_picked(picked: PickedStories, *, provider: str, model: str, fallback: bool) -> None:
    logger.info(
        "pick.done",
        provider=provider,
        model=model,
        fallback=fallback,
        stories=len(picked.top_selected_stories),
    )


async def _alert_gemini_failed(exc: Exception) -> None:
    try:
        from writer_engine.alerting import LEVEL_WARNING, Alert, send_alert

        await send_alert(
            Alert(
                key="provider:gemini:pick_failed",
                level=LEVEL_WARNING,
                title="Gemini failed for the newsletter story pick; Anthropic picked instead",
                detail=f"{type(exc).__name__}: {exc}"[:400],
                context={"service": STEP_NAME, "provider": "gemini"},
            )
        )
    except Exception:
        return


async def handler(inp: StepInput) -> StepOutput:
    articles = list(inp.payload.get("articles") or [])
    max_stories = int(inp.payload.get("max_stories") or 5)
    feedback = inp.payload.get("feedback")
    genre = inp.payload.get("genre")
    router = get_router(service=STEP_NAME)
    try:
        picked = await _pick(
            router,
            articles,
            max_stories,
            feedback,
            genre=genre,
            newsletter_date=inp.payload.get("newsletter_date"),
        )
    except ProviderNotRegistered:
        picked = _fixture(max_stories)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=picked.model_dump(mode="json"),
    )


app = build_step_app(STEP_NAME, handler)
