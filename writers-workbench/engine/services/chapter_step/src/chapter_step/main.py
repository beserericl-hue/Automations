"""chapter-step — write / qa / scan-drift / evaluate-genre / extract-bible / format-kindle.

Operations dispatch via ``payload["op"]``. The ``write`` and ``qa`` ops compose the Follett
writing-craft layer (``follett_seeds.*``) on top of genre + story arc; the remaining ops are F1-2
follow-ups. Real-LLM calls fall back to deterministic fixtures when no provider is registered, so
the service boots and tests run without live keys.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from writer_engine.llm import ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import compose_craft_system, get_prompt_store, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.chapter import (
    BibleEntry,
    ChapterCraftQa,
    DriftFinding,
    DriftScanResult,
    WriteChapterRequest,
    WriteChapterResponse,
)
from writer_engine.step_service import build_step_app

STEP_NAME = "chapter"
seed_default_prompts()

# Craft seeds composed into a chapter WRITE (the load-bearing scene/prose/character guidance).
_WRITE_SEEDS = [
    "follett_seeds.character.pov_selector",
    "follett_seeds.scene.bme_check",
    "follett_seeds.scene.turn_density",
    "follett_seeds.scene.info_as_drama",
    "follett_seeds.scene.description",
    "follett_seeds.scene.pov_bridge",
    "follett_seeds.prose.transparent",
    "follett_seeds.prose.diction",
    "follett_seeds.prose.dialogue",
    "follett_seeds.research.no_dumping",
    "follett_seeds.research.local_color",
    "follett_seeds.scene.fix_now",
    "follett_seeds.prose.no_boring",
]


def _genre_block(genre_slug: str) -> str:
    return f"GENRE: {genre_slug}. Honour this genre's conventions, themes, and reader expectations." if genre_slug else ""


def _arc_block(outline: dict[str, Any]) -> str:
    arc = (outline or {}).get("story_arc") or (outline or {}).get("arc") or ""
    return f"STORY ARC: {arc}. Place this chapter's beats within this arc." if arc else ""


def _build_write_system(*, genre_slug: str, outline: dict[str, Any], revision: bool) -> str:
    """Pure: assemble the chapter-write system prompt from prime directive + genre + arc + seeds.

    In revision mode the locked-roster seed is prepended so existing characters are preserved.
    """
    seeds = (["follett_seeds.character.locked_roster"] if revision else []) + _WRITE_SEEDS
    return compose_craft_system(
        seed_keys=seeds, genre_block=_genre_block(genre_slug), arc_block=_arc_block(outline)
    )


async def _load_context(project_id: str) -> dict[str, Any]:
    """Load genre/outline/title + character roster from Supabase. Fixture when DB is unconfigured."""
    from writer_engine.config import get_settings

    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        return {"genre_slug": "post-apocalyptic", "title": "Untitled", "outline": {}, "roster": []}
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    proj_resp = await (
        client.table("writing_projects_v2")
        .select("title,genre_slug,outline")
        .eq("id", project_id)
        .limit(1)
        .execute()
    )
    proj_rows = getattr(proj_resp, "data", None) or [{}]
    proj = proj_rows[0]
    bible_resp = await (
        client.table("story_bible_v2")
        .select("name,description,entry_type")
        .eq("project_id", project_id)
        .eq("entry_type", "character")
        .execute()
    )
    roster = list(getattr(bible_resp, "data", None) or [])
    return {
        "genre_slug": proj.get("genre_slug") or "",
        "title": proj.get("title") or "Untitled",
        "outline": proj.get("outline") or {},
        "roster": roster,
    }


def _roster_text(roster: list[dict[str, Any]]) -> str:
    return "\n".join(f"- {c.get('name')}: {c.get('description', '')}" for c in roster) or "(none yet)"


def _fixture_chapter(req: WriteChapterRequest) -> WriteChapterResponse:
    text = f"(fixture) Chapter {req.chapter_number} for project {req.project_id}."
    return WriteChapterResponse(
        chapter_id=uuid4(),
        chapter_run_id=req.chapter_run_id,
        content_text=text,
        word_count=len(text.split()),
        sub_chapter_count=req.sub_chapter_count_override or 5,
    )


async def _op_write(payload: dict) -> dict:
    from writer_engine.config import get_settings

    req = WriteChapterRequest.model_validate(payload)
    ctx = await _load_context(str(req.project_id))
    roster = ctx["roster"]
    revision = bool(payload.get("revision") or req.use_qa_report_as_input)
    system = _build_write_system(
        genre_slug=ctx["genre_slug"], outline=ctx["outline"], revision=revision
    )
    store = get_prompt_store()
    parts = [
        f"PROJECT: {ctx['title']}",
        f"CHAPTER NUMBER: {req.chapter_number}",
        "",
        f"OUTLINE:\n{ctx['outline']}",
        "",
        f"CHARACTER ROSTER:\n{_roster_text(roster)}",
    ]
    if revision:
        parts += [
            "",
            store.get("follett_seeds.character.locked_roster").format(
                locked_character_roster=_roster_text(roster)
            ),
        ]
    if req.style_directives:
        parts += ["", "STYLE DIRECTIVES:", *req.style_directives]
    parts += [
        "",
        f"Write chapter {req.chapter_number} in full, following the craft rules in the system prompt.",
    ]
    user = "\n".join(parts)
    settings = get_settings()
    model = {
        "haiku": settings.model_cheap,
        "sonnet": settings.model_default,
    }.get(req.llm_strategy, settings.model_default)
    router = get_router(service=STEP_NAME)
    try:
        resp = await router.complete(
            provider="anthropic", model=model, system=system, prompt=user, max_tokens=8192
        )
        text = resp.text.strip()
        out = WriteChapterResponse(
            chapter_id=uuid4(),
            chapter_run_id=req.chapter_run_id,
            content_text=text,
            word_count=len(text.split()),
            sub_chapter_count=req.sub_chapter_count_override or 5,
        )
    except ProviderNotRegistered:
        out = _fixture_chapter(req)
    return out.model_dump(mode="json")


def _build_qa_system() -> str:
    """Pure: the craft-QA system prompt — score the chapter against the Follett guide rubrics."""
    return compose_craft_system(
        seed_keys=[
            "follett_seeds.scene.turn_density",
            "follett_seeds.prose.no_boring",
            "follett_seeds.prose.dialogue",
            "follett_seeds.research.period_language",
            "follett_seeds.character.no_milk_and_water",
            "follett_seeds.plot.outline_gate",
        ],
    ) + (
        "\n\nYou are the craft-QA reviewer. Score the chapter below on each dimension from 0.0 to 1.0 "
        "(1.0 = fully follows the guide): character_follows_guide, outline_follows_guide, "
        "dialogue_follows_guide, prose_transparent, story_turn_density, no_boring_paragraphs, "
        "period_language_ok. For every dimension under 0.8, add a finding {dimension, problem, fix}. "
        "Return strict JSON matching ChapterCraftQa."
    )


def _fixture_qa() -> ChapterCraftQa:
    return ChapterCraftQa(
        character_follows_guide=0.9,
        outline_follows_guide=0.9,
        dialogue_follows_guide=0.9,
        prose_transparent=0.9,
        story_turn_density=0.9,
        no_boring_paragraphs=0.9,
        period_language_ok=0.9,
        findings=[],
    )


async def _op_qa(payload: dict) -> dict:
    from writer_engine.config import get_settings

    chapter_text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    period = str(payload.get("period") or "contemporary")
    router = get_router(service=STEP_NAME)
    try:
        qa, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_build_qa_system(),
            prompt=f"PERIOD: {period}\n\nCHAPTER:\n{chapter_text}",
            schema=ChapterCraftQa,
        )
    except ProviderNotRegistered:
        qa = _fixture_qa()
    scores = qa.model_dump(mode="json")
    findings = scores.pop("findings", [])
    return {"chapter_id": payload.get("chapter_id"), "scores": scores, "findings": findings}


async def _op_scan_drift(payload: dict) -> dict:
    return DriftScanResult(
        chapter_id=payload.get("chapter_id") or uuid4(),
        findings=[DriftFinding(kind="placeholder", detail="no drift detected (F1-2 stub)")],
    ).model_dump(mode="json")


async def _op_evaluate_genre(payload: dict) -> dict:
    return {"genre_score": 0.91, "notes": ["F1-2 placeholder"]}


async def _op_extract_bible(payload: dict) -> dict:
    entries = [
        BibleEntry(entry_type="character", name="Placeholder", description="F1-2 stub").model_dump(mode="json")
    ]
    return {"entries": entries, "added": len(entries)}


async def _op_format_kindle(payload: dict) -> dict:
    return {"docx_storage_path": f"kindle/{payload.get('chapter_id', 'unknown')}.docx"}


OPS = {
    "write": _op_write,
    "qa": _op_qa,
    "scan-drift": _op_scan_drift,
    "evaluate-genre": _op_evaluate_genre,
    "extract-bible": _op_extract_bible,
    "format-kindle": _op_format_kindle,
}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "write")
    if op not in OPS:
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error={"code": "UNKNOWN_OP", "message": f"unknown op '{op}'"},  # type: ignore[arg-type]
        )
    result = await OPS[op](inp.payload)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": result},
    )


app = build_step_app(STEP_NAME, handler)
