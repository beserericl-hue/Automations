"""media-step — cover-art / social-posts / scrape-url.

social-posts runs real craft-composed generation (transparent prose + snappy voice). cover-art
(KIE.AI) and scrape-url (Firecrawl) need dedicated HTTP clients with polling/cleanup and are wired
in a follow-up (keys are present on the runtime). All ops fixture-fall back without a provider.
"""

from __future__ import annotations

import json

from writer_engine.config import get_settings
from writer_engine.llm import ProviderNotRegistered, get_router
from writer_engine.llm.structured import extract_json
from writer_engine.prompt_store import compose_craft_system, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "media"
seed_default_prompts()


async def _op_cover_art(payload: dict) -> dict:
    # TODO(F1-A.6b): KIE.AI image generation (submit -> poll -> URL) + DALL-E fallback. Keys present.
    project_id = payload.get("project_id", "unknown")
    return {"image_url": f"https://placehold.co/1600x2400?text={project_id}", "provider": "stub"}


def _social_system() -> str:
    """Craft-composed voice for social copy — transparent prose + snappy, no-fluff lines."""
    return compose_craft_system(
        seed_keys=["follett_seeds.prose.transparent", "follett_seeds.prose.dialogue"]
    ) + (
        "\n\nWrite ONE social post per requested platform promoting the work. Match each platform's "
        "norms (length, tone). Transparent, concrete, hook-first. Return strict JSON: an object "
        "mapping each platform name to its post string."
    )


async def _op_social_posts(payload: dict) -> dict:
    platforms = list(payload.get("platforms") or ["twitter", "linkedin"])
    summary = str(payload.get("summary") or payload.get("title") or "")
    router = get_router(service=STEP_NAME)
    try:
        resp = await router.complete(
            provider="anthropic",
            model=get_settings().model_cheap,
            system=_social_system(),
            prompt=f"WORK:\n{summary}\n\nPLATFORMS: {', '.join(platforms)}\nReturn JSON only.",
            max_tokens=1200,
        )
        data = json.loads(extract_json(resp.text))
        return {p: str(data.get(p, "")) for p in platforms}
    except (ProviderNotRegistered, json.JSONDecodeError, ValueError):
        return {p: f"(fixture) social post for {p}: {summary[:60]}" for p in platforms}


async def _op_scrape_url(payload: dict) -> dict:
    # TODO(F1-A.6b): Firecrawl scrape (POST /scrape -> markdown). Key present.
    return {"url": payload.get("url"), "markdown": "(stub — Firecrawl client pending)", "html": "", "metadata": {}}


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
