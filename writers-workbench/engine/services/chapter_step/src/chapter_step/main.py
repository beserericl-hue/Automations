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
    # Craft-revision loop: the DB regression showed a single pass leaves boring paragraphs / dialogue
    # below the guide bar (avg ~0.87, no_boring dominant). After the draft, QA it and — if any
    # dimension is under threshold — revise targeting the findings, bounded by max_craft_passes.
    max_passes = int(payload.get("max_craft_passes", 1))
    period = str(payload.get("period") or "contemporary")
    try:
        resp = await router.complete(
            provider="anthropic", model=model, system=system, prompt=user, max_tokens=8192
        )
        text = resp.text.strip()
        passes = 0
        final_qa: ChapterCraftQa | None = None
        while passes < max_passes:
            qa = await _score_chapter(text, period)
            final_qa = qa
            low = _low_dims(qa)
            if not low:
                break
            text = await _revise_chapter(
                text, low_dims=low, findings=qa.findings, model=model, genre_slug=ctx["genre_slug"]
            )
            passes += 1
            final_qa = None  # re-score on next iteration; if loop ends here, score once more below
        if max_passes > 0 and final_qa is None:
            final_qa = await _score_chapter(text, period)
        scores = (
            {k: v for k, v in final_qa.model_dump(mode="json").items() if k in QA_DIMS}
            if final_qa
            else None
        )
        out = WriteChapterResponse(
            chapter_id=uuid4(),
            chapter_run_id=req.chapter_run_id,
            content_text=text,
            word_count=len(text.split()),
            sub_chapter_count=req.sub_chapter_count_override or 5,
            craft_passes=passes,
            craft_qa=scores,
        )
    except ProviderNotRegistered:
        out = _fixture_chapter(req)
    return out.model_dump(mode="json")


_DIM_TO_SEEDS = {
    "no_boring_paragraphs": ["follett_seeds.prose.no_boring"],
    "dialogue_follows_guide": ["follett_seeds.prose.dialogue"],
    "prose_transparent": ["follett_seeds.prose.transparent", "follett_seeds.prose.diction"],
    "story_turn_density": ["follett_seeds.scene.turn_density"],
    "period_language_ok": ["follett_seeds.research.period_language"],
    "character_follows_guide": ["follett_seeds.character.no_milk_and_water"],
    "outline_follows_guide": ["follett_seeds.plot.outline_gate"],
}


async def _revise_chapter(
    text: str, *, low_dims: list[str], findings: list[dict], model: str, genre_slug: str
) -> str:
    """Targeted craft-revision pass: rewrite the chapter to fix the dimensions that scored low.

    Composes only the seeds for the failing dimensions plus the revision meta-directives
    (fix-now + daily-rewrite), so the model focuses on the actual gaps without re-litigating the
    whole craft. Preserves story, characters, and events — this is a polish, not a rewrite.
    """
    seeds: list[str] = ["follett_seeds.scene.fix_now", "follett_seeds.prose.daily_rewrite"]
    for dim in low_dims:
        seeds.extend(_DIM_TO_SEEDS.get(dim, []))
    # de-dup, preserve order
    seeds = list(dict.fromkeys(seeds))
    system = compose_craft_system(seed_keys=seeds, genre_block=_genre_block(genre_slug))
    findings_text = "\n".join(
        f"- [{f.get('dimension', '?')}] {f.get('problem', '')} -> FIX: {f.get('fix', '')}"
        for f in findings
    ) or "(no specific findings; apply the craft rules above)"
    user = (
        "Revise the chapter below to fix these craft issues, applying the rules in the system "
        "prompt. PRESERVE the story, characters, events, and POV exactly — improve only the prose, "
        f"dialogue, pacing, and language. Return the full revised chapter.\n\n"
        f"CRAFT ISSUES TO FIX ({', '.join(low_dims)}):\n{findings_text}\n\nCHAPTER:\n{text}"
    )
    router = get_router(service=STEP_NAME)
    resp = await router.complete(
        provider="anthropic", model=model, system=system, prompt=user, max_tokens=8192
    )
    return resp.text.strip()


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


QA_DIMS = (
    "character_follows_guide",
    "outline_follows_guide",
    "dialogue_follows_guide",
    "prose_transparent",
    "story_turn_density",
    "no_boring_paragraphs",
    "period_language_ok",
)
CRAFT_THRESHOLD = 0.8


async def _score_chapter(text: str, period: str) -> ChapterCraftQa:
    """Run the craft-QA over a chapter. Fixture when no provider is registered."""
    from writer_engine.config import get_settings

    router = get_router(service=STEP_NAME)
    try:
        qa, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_build_qa_system(),
            prompt=f"PERIOD: {period}\n\nCHAPTER:\n{text}",
            schema=ChapterCraftQa,
        )
        return qa
    except ProviderNotRegistered:
        return _fixture_qa()


def _low_dims(qa: ChapterCraftQa, threshold: float = CRAFT_THRESHOLD) -> list[str]:
    d = qa.model_dump(mode="json")
    return [dim for dim in QA_DIMS if d.get(dim, 0.0) < threshold]


async def _op_qa(payload: dict) -> dict:
    chapter_text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    period = str(payload.get("period") or "contemporary")
    qa = await _score_chapter(chapter_text, period)
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
