"""research-step — derive questions, query Perplexity, synthesize, persist.

Runs on the Follett research craft layer (``follett_seeds.research.*``): the derive step generates
scene-generating questions across the craft categories, each Perplexity query is shaped to elicit
period numbers + misconception corrections + a "surprise a modern reader" angle, and the synthesis
applies the Sal-and-the-potatoes test to turn findings into scene seeds. Falls back to deterministic
stubs when no provider is registered.
"""

from __future__ import annotations

from uuid import uuid4

from writer_engine.config import get_settings
from writer_engine.llm import ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import compose_craft_system, get_prompt_store, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.chapter import ResearchPlan, ResearchReportRow, ResearchRequest
from writer_engine.step_service import build_step_app

STEP_NAME = "research"
seed_default_prompts()


def _build_derive_user(topic: str, genre: str, setting: str) -> str:
    """The derive instruction (follett_seeds.research.derive) formatted for this project."""
    return get_prompt_store().get("follett_seeds.research.derive").format(
        topic=topic or "(unspecified)", genre=genre or "(unspecified)", setting=setting or "(unspecified)"
    )


def _derive_system() -> str:
    return compose_craft_system(seed_keys=[]) + (
        "\n\nYou are a research planner for a novelist. Return strict JSON matching ResearchPlan "
        "(questions: list of {question, category, why})."
    )


async def _derive(topic: str, genre: str, setting: str) -> list[str]:
    router = get_router(service=STEP_NAME)
    try:
        plan, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_derive_system(),
            prompt=_build_derive_user(topic, genre, setting),
            schema=ResearchPlan,
        )
        return [q.question for q in plan.questions] or [f"What shapes {topic}?"]
    except ProviderNotRegistered:
        return [
            f"What recent developments shape {topic}?",
            f"What are the open debates around {topic}?",
        ]


def _build_query_prompt(question: str, period: str, place: str) -> str:
    """Shape the Perplexity query per follett_seeds.research.perplexity_query."""
    shape = get_prompt_store().get("follett_seeds.research.perplexity_query")
    return (
        f"{shape}\n\nNow research, for a novel set in {period or 'the present'} {place or ''}: "
        f"{question}"
    )


async def _query(question: str, period: str, place: str) -> str:
    settings = get_settings()
    if not settings.perplexity_api_key:
        return f"(stub answer for: {question})"
    router = get_router(service=STEP_NAME)
    try:
        resp = await router.complete(
            provider="perplexity",
            model="sonar-pro",  # llama-3.1-sonar-* models were retired by Perplexity (400)
            system="You are a citation-grounded research assistant. Surface source disagreement.",
            prompt=_build_query_prompt(question, period, place),
            max_tokens=900,
            temperature=0.2,
        )
        return resp.text
    except ProviderNotRegistered:
        return f"(perplexity adapter not registered for: {question})"


def _synthesis_system() -> str:
    """Sal-and-the-potatoes: turn findings into scene seeds for existing characters."""
    return compose_craft_system(
        seed_keys=["follett_seeds.research.scene_seed", "follett_seeds.research.setback_opportunity"]
    ) + "\n\nReturn a markdown research report: per finding give the fact, its citation, the 'surprise a modern reader' angle, and a scene seed (or mark BACKGROUND-ONLY)."


async def _synthesize(topic: str, qa: list[dict[str, str]], characters: str) -> str:
    router = get_router(service=STEP_NAME)
    body = "\n\n".join(f"## {item['question']}\n\n{item['answer']}" for item in qa)
    try:
        resp = await router.complete(
            provider="anthropic",
            model=get_settings().model_default,
            system=_synthesis_system(),
            prompt=f"TOPIC: {topic}\nEXISTING CHARACTERS:\n{characters or '(none)'}\n\nFINDINGS:\n{body}",
            max_tokens=4096,
        )
        return resp.text.strip()
    except ProviderNotRegistered:
        return body


async def _op_run(payload: dict) -> dict:
    req = ResearchRequest.model_validate(payload)
    genre = str(payload.get("genre_slug") or payload.get("genre") or "")  # G4: keep the genre slug
    setting = str(payload.get("setting") or "")
    period = str(payload.get("period") or setting)
    place = str(payload.get("place") or "")
    characters = str(payload.get("characters") or "")
    questions = await _derive(req.topic, genre, setting)
    qa: list[dict[str, str]] = [
        {"question": q, "answer": await _query(q, period, place)} for q in questions
    ]
    report = await _synthesize(req.topic, qa, characters)
    row = ResearchReportRow(id=uuid4(), topic=req.topic, questions=questions, report_markdown=report)
    persisted = await _persist_research_if_requested(payload, req.topic, report, genre)
    return {"row": row.model_dump(mode="json"), "qa": qa, "persist": persisted}


async def _persist_research_if_requested(
    payload: dict, topic: str, report: str, genre: str
) -> dict | None:
    """CR-001 (W5): when `persist` + user_id are supplied, save the report to research_reports_v2."""
    from writer_engine.config import get_settings

    if not payload.get("persist"):
        return None
    user_id = payload.get("user_id")
    project_id = payload.get("project_id")
    if not user_id:
        return {"persisted": False, "reason": "persist requested but user_id missing"}
    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return {"persisted": False, "reason": "supabase not configured"}
    try:
        from writer_engine.persist_helpers import persist_research
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        labelled = f"[project {project_id}] {topic}" if project_id else topic
        rid = await persist_research(
            client, project_id=str(project_id) if project_id else None, user_id=str(user_id),
            topic=labelled, content=report, genre_slug=genre,
        )
        return {"persisted": bool(rid), "research_id": rid}
    except Exception as exc:
        return {"persisted": False, "error": str(exc)[:200]}


OPS = {"run": _op_run}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "run")
    if op not in OPS:
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error={"code": "UNKNOWN_OP", "message": op},  # type: ignore[arg-type]
        )
    result = await OPS[op](inp.payload)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": result},
    )


app = build_step_app(STEP_NAME, handler)
