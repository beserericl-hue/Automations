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
from writer_engine.prompt_store import compose_craft_system, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.chapter import (
    BibleEntry,
    ChapterCraftQa,
    DriftFinding,
    DriftScanResult,
    SubChapterBrief,
    SubChapterPlan,
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


def _chapter_header(ctx: dict[str, Any], roster: list, req: WriteChapterRequest) -> str:
    """Shared context block (project + outline + roster) for the chapter / sub-chapter prompts."""
    lines = [
        f"PROJECT: {ctx['title']}",
        f"CHAPTER NUMBER: {req.chapter_number}",
        "",
        f"OUTLINE:\n{ctx['outline']}",
        "",
        f"CHARACTER ROSTER:\n{_roster_text(roster)}",
    ]
    if req.style_directives:
        lines += ["", "STYLE DIRECTIVES:", *req.style_directives]
    return "\n".join(lines)


def _plan_system(genre_slug: str, outline: dict[str, Any]) -> str:
    """System prompt for splitting a chapter into sub-chapter beats (scene-list + escalation seeds)."""
    return compose_craft_system(
        seed_keys=["follett_seeds.scene.event_list", "follett_seeds.scene.escalating_turn",
                   "follett_seeds.scene.bme_check"],
        genre_block=_genre_block(genre_slug),
        arc_block=_arc_block(outline),
    ) + (
        "\n\nReturn strict JSON matching SubChapterPlan: a list of sub-chapters, each with a title, a "
        "concrete beat (what happens — a discrete movement of the chapter, NOT a summary), and the POV "
        "character. The sub-chapters together must cover the whole chapter with a beginning/middle/end "
        "and at least one story turn each."
    )


async def _plan_subchapters(
    ctx: dict[str, Any], req: WriteChapterRequest, n: int, model: str
) -> list[SubChapterBrief]:
    """Plan up to n sub-chapters for the chapter. Fixture briefs when no provider."""
    router = get_router(service=STEP_NAME)
    try:
        plan, _ = await complete_structured(
            router,
            provider="anthropic",
            model=model,
            system=_plan_system(ctx["genre_slug"], ctx["outline"]),
            prompt=(
                f"{_chapter_header(ctx, ctx['roster'], req)}\n\n"
                f"Split chapter {req.chapter_number} into {n} sub-chapters."
            ),
            schema=SubChapterPlan,
            max_tokens=4096,
        )
        briefs = plan.subchapters[:n]
        return briefs or [SubChapterBrief(beat=f"Part {i + 1} of chapter {req.chapter_number}") for i in range(n)]
    except ProviderNotRegistered:
        return [SubChapterBrief(beat=f"Part {i + 1}") for i in range(n)]


async def _write_subchapter(
    *, system: str, header: str, brief: SubChapterBrief, idx: int, total: int,
    prior_tail: str, chapter_number: int, model: str,
) -> str:
    """Write one sub-chapter (~2-3k words) with continuity from the prior sub-chapter's tail."""
    continuity = (
        f"\n\nCONTINUE SEAMLESSLY from the end of the previous sub-chapter (do NOT restate it; pick up "
        f"the thread). Tail of the previous sub-chapter:\n…{prior_tail}" if prior_tail else ""
    )
    user = (
        f"{header}\n\nYou are writing SUB-CHAPTER {idx + 1} of {total} of chapter {chapter_number}.\n"
        f"This sub-chapter's beat: {brief.title} — {brief.beat}"
        f"{(' (POV: ' + brief.pov_character + ')') if brief.pov_character else ''}\n"
        f"Write this sub-chapter in full (rich, scene-driven prose, not a summary), following the craft "
        f"rules in the system prompt. Do NOT write a chapter heading or 'Sub-chapter N' label — write the "
        f"prose only.{continuity}"
    )
    router = get_router(service=STEP_NAME)
    resp = await router.complete(provider="anthropic", model=model, system=system, prompt=user, max_tokens=8192)
    return resp.text.strip()


async def _op_write(payload: dict) -> dict:
    from writer_engine.config import get_settings

    req = WriteChapterRequest.model_validate(payload)
    ctx = await _load_context(str(req.project_id))
    roster = ctx["roster"]
    revision = bool(payload.get("revision") or req.use_qa_report_as_input)
    system = _build_write_system(genre_slug=ctx["genre_slug"], outline=ctx["outline"], revision=revision)
    header = _chapter_header(ctx, roster, req)
    settings = get_settings()
    model = {"haiku": settings.model_cheap, "sonnet": settings.model_default}.get(
        req.llm_strategy, settings.model_default
    )
    period = str(payload.get("period") or "contemporary")
    # Sub-chapter fan-out (F1-1): a chapter is written as N sub-chapters (~2-3k words each) for depth,
    # so a full chapter reaches n8n-scale length. Default 5; 1 = single-call (short) path.
    n_sub = max(1, min(int(req.sub_chapter_count_override or 5), 6))
    router = get_router(service=STEP_NAME)
    try:
        if n_sub > 1:
            briefs = await _plan_subchapters(ctx, req, n_sub, model)
            sub_texts: list[str] = []
            prior_tail = ""
            for i, brief in enumerate(briefs):
                t = await _write_subchapter(
                    system=system, header=header, brief=brief, idx=i, total=len(briefs),
                    prior_tail=prior_tail, chapter_number=req.chapter_number, model=model,
                )
                sub_texts.append(t)
                prior_tail = " ".join(t.split()[-800:])
            text = "\n\n".join(sub_texts)
            passes = 0
            # QA the assembled chapter for the score report (the per-sub-chapter craft seeds enforce
            # quality during writing; a full-chapter revision pass would truncate a ~12k-word chapter).
            final_qa = await _score_chapter(text, period, _roster_text(roster))
            sub_count = len(briefs)
        else:
            resp = await router.complete(
                provider="anthropic", model=model, system=system,
                prompt=f"{header}\n\nWrite chapter {req.chapter_number} in full, following the craft rules.",
                max_tokens=8192,
            )
            text = resp.text.strip()
            passes = 0
            final_qa = None
            max_passes = int(payload.get("max_craft_passes", 1))
            while passes < max_passes:
                qa = await _score_chapter(text, period, _roster_text(roster))
                if qa is None:
                    break
                final_qa = qa
                low = _low_dims(qa)
                if not low:
                    break
                text = await _revise_chapter(text, low_dims=low, findings=qa.findings, model=model, genre_slug=ctx["genre_slug"])
                passes += 1
                final_qa = None
            if max_passes > 0 and final_qa is None:
                final_qa = await _score_chapter(text, period, _roster_text(roster))
            sub_count = 1
        scores = (
            {k: v for k, v in final_qa.model_dump(mode="json").items() if k in QA_DIMS}
            if final_qa else None
        )
        out = WriteChapterResponse(
            chapter_id=uuid4(),
            chapter_run_id=req.chapter_run_id,
            content_text=text,
            word_count=len(text.split()),
            sub_chapter_count=sub_count,
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
    "character_consistency": ["follett_seeds.character.locked_roster"],
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
    """Pure: the craft-QA system prompt — score the chapter against the Follett guide rubrics +
    character consistency + research gaps."""
    return compose_craft_system(
        seed_keys=[
            "follett_seeds.scene.turn_density",
            "follett_seeds.prose.no_boring",
            "follett_seeds.prose.dialogue",
            "follett_seeds.research.period_language",
            "follett_seeds.character.no_milk_and_water",
            "follett_seeds.character.locked_roster",
            "follett_seeds.research.no_dumping",
            "follett_seeds.plot.outline_gate",
        ],
    ) + (
        "\n\nYou are the craft-QA reviewer. Score the chapter below from 0.0 to 1.0 on each dimension "
        "(1.0 = fully follows the guide): character_follows_guide, outline_follows_guide, "
        "dialogue_follows_guide, prose_transparent, story_turn_density, no_boring_paragraphs, "
        "period_language_ok, and character_consistency.\n"
        "- character_consistency: do the characters stay consistent with the CHARACTER ROSTER given "
        "in the user prompt and with each other — names, ages, relationships, traits, established "
        "voice? Any drift (a renamed character, a changed trait, an out-of-character action) lowers "
        "this score; cite it in findings.\n"
        "- research_gaps: list short phrases for any historical/period fact the chapter ASSERTS that "
        "should be verified by research, OR any scene where a researched period detail (a tool, food, "
        "ritual, price, word) would deepen it. This drives 'add research if needed'.\n"
        "For every score under 0.8, add a finding {dimension, problem, fix}. "
        "Return strict JSON matching ChapterCraftQa (include character_consistency and research_gaps)."
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
        character_consistency=0.9,
        research_gaps=[],
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
    "character_consistency",
)
CRAFT_THRESHOLD = 0.8


async def _score_chapter(text: str, period: str, roster_text: str = "") -> ChapterCraftQa | None:
    """Run the craft-QA over a chapter (incl. character-consistency vs the roster). None when no
    provider OR the QA JSON can't be parsed.

    A QA parse failure must NOT lose the drafted chapter — the caller treats None as "couldn't
    score" (skip the revision) rather than erroring the whole write.
    """
    from writer_engine.config import get_settings

    router = get_router(service=STEP_NAME)
    roster_block = f"CHARACTER ROSTER (check consistency against this):\n{roster_text}\n\n" if roster_text else ""
    try:
        qa, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_build_qa_system(),
            prompt=f"PERIOD: {period}\n\n{roster_block}CHAPTER:\n{text}",
            schema=ChapterCraftQa,
        )
        return qa
    except ProviderNotRegistered:
        return _fixture_qa()
    except ValueError:
        return None  # QA JSON failed schema — don't lose the chapter


def _low_dims(qa: ChapterCraftQa, threshold: float = CRAFT_THRESHOLD) -> list[str]:
    d = qa.model_dump(mode="json")
    return [dim for dim in QA_DIMS if d.get(dim, 0.0) < threshold]


async def _op_qa(payload: dict) -> dict:
    chapter_text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    period = str(payload.get("period") or "contemporary")
    roster_text = _roster_text(payload.get("roster") or []) if payload.get("roster") else ""
    qa = await _score_chapter(chapter_text, period, roster_text)
    if qa is None:
        return {"chapter_id": payload.get("chapter_id"), "scores": None, "findings": [],
                "note": "craft-QA JSON could not be parsed"}
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
