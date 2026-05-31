"""subject-svc — Claude writes the subject line, preheader, and alternatives."""

from __future__ import annotations

import json

from writer_engine.llm import LLMRouter, ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import get_prompt_store, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import SubjectLineProposal
from writer_engine.step_service import build_step_app

STEP_NAME = "subject"
seed_default_prompts()
DEFAULT_MODEL = "claude-haiku-4-5"


def _fixture(stories: list[dict]) -> SubjectLineProposal:
    titles = ", ".join(s.get("title", "") for s in stories[:3]) or "today's news"
    return SubjectLineProposal(
        subject_line=f"AI Daily — {titles[:60]}",
        pre_header_text="Today's top stories at a glance.",
        additional_subject_lines=["Today's AI roundup", "AI moves you missed"],
        subject_line_reasoning="fixture",
        pre_header_text_reasoning="fixture",
    )


async def _write(
    router: LLMRouter, stories: list[dict], feedback: str | None, model: str
) -> SubjectLineProposal:
    store = get_prompt_store()
    system = store.get("newsletter.subject.system")
    user_template = store.get("newsletter.subject.user_template")
    user = user_template.format(stories=json.dumps(stories, ensure_ascii=False))
    if feedback:
        user += f"\n\nOperator feedback from prior round: {feedback}"
    proposal, _ = await complete_structured(
        router,
        provider="anthropic",
        model=model,
        system=system,
        prompt=user,
        schema=SubjectLineProposal,
    )
    return proposal


async def handler(inp: StepInput) -> StepOutput:
    stories = list(inp.payload.get("top_selected_stories") or [])
    feedback = inp.payload.get("feedback")
    model = str(inp.payload.get("model") or DEFAULT_MODEL)
    router = get_router(service=STEP_NAME)
    try:
        proposal = await _write(router, stories, feedback, model)
    except ProviderNotRegistered:
        proposal = _fixture(stories)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=proposal.model_dump(mode="json"),
    )


app = build_step_app(STEP_NAME, handler)
