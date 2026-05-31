"""research-step — derive questions, query Perplexity, synthesize, persist."""

from __future__ import annotations

from uuid import uuid4

from writer_engine.config import get_settings
from writer_engine.llm import ProviderNotRegistered, get_router
from writer_engine.prompt_store import seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.chapter import ResearchReportRow, ResearchRequest
from writer_engine.step_service import build_step_app

STEP_NAME = "research"
seed_default_prompts()


async def _derive(topic: str, context: str) -> list[str]:
    # F1 stub — Sprint 17 wires the real Claude chainLlm.
    return [f"What recent developments shape {topic}?", f"What are the open debates around {topic}?"]


async def _query(question: str) -> str:
    settings = get_settings()
    if not settings.perplexity_api_key:
        return f"(stub answer for: {question})"
    router = get_router(service=STEP_NAME)
    try:
        resp = await router.complete(
            provider="perplexity",
            model="llama-3.1-sonar-large-128k-online",
            system="You are a research assistant. Return a concise factual summary.",
            prompt=question,
            max_tokens=800,
            temperature=0.2,
        )
        return resp.text
    except ProviderNotRegistered:
        return f"(perplexity adapter not registered for: {question})"


async def _op_run(payload: dict) -> dict:
    req = ResearchRequest.model_validate(payload)
    questions = await _derive(req.topic, payload.get("context") or "")
    qa: list[dict[str, str]] = []
    for q in questions:
        qa.append({"question": q, "answer": await _query(q)})
    report = "\n\n".join(f"## {item['question']}\n\n{item['answer']}" for item in qa)
    row = ResearchReportRow(id=uuid4(), topic=req.topic, questions=questions, report_markdown=report)
    return {"row": row.model_dump(mode="json"), "qa": qa}


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
