"""chapter-step — write / qa / scan-drift / evaluate-genre / extract-bible / format-kindle.

Operations dispatch via ``payload["op"]``. The ``write`` and ``qa`` ops compose the Follett
writing-craft layer (``follett_seeds.*``) on top of genre + story arc; the remaining ops are F1-2
follow-ups. Real-LLM calls fall back to deterministic fixtures when no provider is registered, so
the service boots and tests run without live keys.
"""

from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

from writer_engine.llm import ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import compose_craft_system, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.chapter import (
    BibleEntry,
    ChapterCraftQa,
    DriftFinding,
    DriftReport,
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


# Meta/scaffolding the model sometimes prepends to prose despite "prose only" — a "Confirmed cast"
# block (from the locked_roster COPY-FIRST rule), a POV-selector preamble, draft/sub-chapter
# headings, or a chatty "Here is the revised chapter" lead-in. Stripped so only story prose ships.
# A leading paragraph is scaffolding if its first line begins with one of these meta labels — a
# "Confirmed cast" block (locked_roster COPY-FIRST rule), a POV-selector preamble, a draft/sub-chapter
# heading, or a chatty "Here is the revised chapter" lead-in. Matched at the TOP only.
_SCAFFOLD_PREFIX = re.compile(
    r"^\s*[#>*_(\-]*\s*"
    r"(?:confirmed cast|locked characters?|pov character|pov\b|cast\s*[:.]|"
    r"why\s+(?:her|his|their|the)\b.*?stake|no locked characters|all characters introduced|"
    r"this is the opening (?:chapter|scene)|chapter\s+\d+\s*[—:\-].*(?:revised|draft)|"
    r"full revised draft|revised chapter\b|sub-?chapter\s+\d+|"
    r"here(?:'s| is)\b[^.]*\b(?:revis|chapter|draft)|i(?:'ve| have)\b[^.]*\brevis)",
    re.IGNORECASE,
)


def _strip_scaffolding(text: str) -> str:
    """Drop leading meta/scaffolding paragraphs so the chapter starts on real story prose — not a
    'Confirmed cast' block, a 'POV CHARACTER: …' preamble, or a '## Chapter N — Revised Draft'
    heading. Only strips from the TOP and stops at the first real paragraph, never touching prose."""
    # split into paragraphs on blank lines, keeping it simple
    paras = re.split(r"\n\s*\n", text.strip())
    i = 0
    while i < len(paras):
        head = paras[i].strip().lstrip("*_>#- ").strip()
        if head in {"", "---", "***", "___"} or _SCAFFOLD_PREFIX.match(paras[i].strip()):
            i += 1
            continue
        break
    out = "\n\n".join(paras[i:]).strip()
    return out or text.strip()


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
    return _strip_scaffolding(resp.text.strip())


# ----------------------------------------------------------------------------------------------
# Two-cycle QA: (1) detect drift vs outline/arc/roster + research gaps; (1.5) research-fill the
# gaps; (2) correct the drift and weave the researched facts in. Runs after the fanned chapter is
# assembled so the correction sees the whole chapter.
# ----------------------------------------------------------------------------------------------


def _chapter_outline_beat(outline: dict[str, Any], chapter_number: int) -> str:
    """Pull the planned beat for this chapter out of the outline so QA can check drift against it."""
    chapters = (outline or {}).get("chapters") or []
    for ch in chapters:
        if isinstance(ch, dict) and str(ch.get("chapter_number")) == str(chapter_number):
            bits = [ch.get("title"), ch.get("act"), ch.get("arc_point"), ch.get("beat")]
            return " | ".join(str(b) for b in bits if b)
    # outlines without chapter_number: fall back to positional
    if 0 <= chapter_number < len(chapters) and isinstance(chapters[chapter_number], dict):
        c = chapters[chapter_number]
        return " | ".join(str(b) for b in (c.get("title"), c.get("beat")) if b)
    return "(no matching outline entry — check against premise + arc)"


def _arc_summary(outline: dict[str, Any]) -> str:
    o = outline or {}
    return " ".join(
        str(x) for x in (o.get("story_arc_name"), o.get("dramatic_question"), o.get("premise")) if x
    ) or "(arc not specified — infer from premise)"


def _build_drift_system() -> str:
    """QA cycle 1 — drift reviewer. Checks the chapter against outline+arc+roster."""
    return compose_craft_system(
        seed_keys=[
            "follett_seeds.plot.outline_gate",
            "follett_seeds.character.locked_roster",
            "follett_seeds.research.local_color",
            "follett_seeds.research.period_language",
            "follett_seeds.research.no_dumping",
        ],
    ) + (
        "\n\nYou are the DRIFT reviewer (QA cycle 1). You do NOT rewrite — you DETECT. Compare the "
        "CHAPTER against (a) the PLANNED OUTLINE BEAT for this chapter, (b) the overall STORY ARC, and "
        "(c) the CHARACTER ROSTER, all given in the user prompt. Report:\n"
        "- story_drift: concrete ways the chapter departs from the planned beat or the arc — a beat "
        "that's missing/changed, an event that contradicts the arc, a continuity break, a chapter that "
        "doesn't advance the through-line. Each item names the deviation specifically.\n"
        "- character_drift: concrete ways a character is inconsistent with the roster or with earlier "
        "behaviour — renamed, a changed age/trait/role/relationship, an out-of-character action, a "
        "voice that doesn't match. Name the character and the inconsistency.\n"
        "- research_gaps: short phrases for period facts / local color / material culture / events the "
        "chapter should add or verify to feel grounded in its time and place.\n"
        "Set aligned=true ONLY if story_drift and character_drift are both empty. Be exacting but do "
        "not invent drift that isn't there. Return strict JSON matching DriftReport."
    )


async def _detect_drift(
    text: str, *, outline: dict[str, Any], chapter_number: int, roster_text: str, period: str, model: str
) -> DriftReport | None:
    """QA cycle 1: structured drift report. None on parse failure (never lose the chapter)."""
    router = get_router(service=STEP_NAME)
    prompt = (
        f"PERIOD: {period}\n\n"
        f"PLANNED OUTLINE BEAT (chapter {chapter_number}):\n{_chapter_outline_beat(outline, chapter_number)}\n\n"
        f"STORY ARC:\n{_arc_summary(outline)}\n\n"
        f"CHARACTER ROSTER (consistency reference):\n{roster_text}\n\n"
        f"CHAPTER:\n{text}"
    )
    try:
        drift, _resp = await complete_structured(
            router, provider="anthropic", model=model,
            system=_build_drift_system(), prompt=prompt, schema=DriftReport, max_tokens=4096,
        )
        return drift
    except ProviderNotRegistered:
        return DriftReport()
    except ValueError:
        return None


async def _research_fill(gaps: list[str], *, period: str, title: str) -> str:
    """QA cycle 1.5: fetch concrete period facts / local color for the flagged gaps via Perplexity.

    Returns a compact, citable facts block to weave into the chapter, or "" when no gaps / no
    Perplexity provider. One batched call covers all gaps.
    """
    gaps = [g for g in (gaps or []) if str(g).strip()][:12]
    if not gaps:
        return ""
    router = get_router(service=STEP_NAME)
    shape = (
        f'For a historical novel "{title}" set in {period}, give SPECIFIC, period-accurate factual '
        "detail a novelist can weave into a scene for each item below — material culture, local color, "
        "real events, terminology, sensory specifics. 2-4 tight factual bullets per item, no preamble, "
        "no fiction. Items:\n" + "\n".join(f"- {g}" for g in gaps)
    )
    try:
        resp = await router.complete(
            provider="perplexity", model="sonar-pro", system=None, prompt=shape, max_tokens=2048,
        )
    except ProviderNotRegistered:
        return ""
    except Exception:
        return ""
    facts = resp.text.strip()
    if resp.citations:
        facts += "\n\nSOURCES: " + "; ".join(resp.citations[:8])
    return facts


def _build_correct_system(genre_slug: str) -> str:
    """QA cycle 2 — drift corrector + research weaver (a structural revision, not a polish).

    Note: the locked_roster seed is deliberately NOT composed here — its COPY-FIRST rule makes the
    model print a "Confirmed cast" block into the prose. The roster is supplied in the user prompt as
    a reference instead, and consistency is enforced by the instruction below.
    """
    return compose_craft_system(
        seed_keys=[
            "follett_seeds.scene.fix_now",
            "follett_seeds.plot.outline_gate",
            "follett_seeds.research.local_color",
            "follett_seeds.research.no_dumping",
            "follett_seeds.research.period_language",
            "follett_seeds.prose.daily_rewrite",
        ],
        genre_block=_genre_block(genre_slug),
    ) + (
        "\n\nYou are the CORRECTION pass (QA cycle 2). Revise the chapter to FIX the drift found in "
        "QA cycle 1 and to ground it in researched fact. You MUST:\n"
        "1. Correct every STORY DRIFT item so the chapter matches its planned outline beat and the "
        "arc — restore missing beats, remove contradictions, keep the through-line.\n"
        "2. Correct every CHARACTER DRIFT item so each character matches the CHARACTER ROSTER in the "
        "user prompt (name, age, traits, relationships, voice) and stays in character.\n"
        "3. Weave the RESEARCHED FACTS in as concrete sensory/material detail and accurate period "
        "language — dramatized, never an info-dump or a list.\n"
        "LENGTH — you are ADDING depth, not trimming. The revised chapter MUST be AT LEAST as long as "
        "the original and should be LONGER once the researched detail is dramatized. Do NOT summarize, "
        "condense, or drop scenes. PRESERVE the POV and the chapter's place in the story.\n"
        "OUTPUT — return ONLY the chapter prose. Do NOT print a cast list, a 'Confirmed cast' section, "
        "a 'POV character' line, chapter/sub-chapter headings, or any notes about what you changed."
    )


async def _correct_drift(
    text: str, *, drift: DriftReport, facts: str, roster_text: str, genre_slug: str, model: str
) -> str:
    """QA cycle 2: streamed full-chapter revision that corrects drift + weaves in facts."""
    router = get_router(service=STEP_NAME)
    sd = "\n".join(f"- {x}" for x in drift.story_drift) or "(none)"
    cd = "\n".join(f"- {x}" for x in drift.character_drift) or "(none)"
    facts_block = facts or "(no new research — keep existing detail accurate)"
    user = (
        f"CHARACTER ROSTER (consistency reference):\n{roster_text}\n\n"
        f"STORY DRIFT TO CORRECT:\n{sd}\n\n"
        f"CHARACTER DRIFT TO CORRECT:\n{cd}\n\n"
        f"RESEARCHED FACTS TO WEAVE IN:\n{facts_block}\n\n"
        f"CHAPTER TO REVISE:\n{text}"
    )
    resp = await router.complete(
        provider="anthropic", model=model, system=_build_correct_system(genre_slug),
        prompt=user, max_tokens=32768, stream=True,
    )
    return _strip_scaffolding(resp.text.strip())


async def _two_cycle_qa(
    text: str, *, ctx: dict[str, Any], req: WriteChapterRequest, roster_text: str, period: str, model: str
) -> tuple[str, DriftReport | None, list[str], int]:
    """Run QA cycle 1 (detect) -> research-fill -> QA cycle 2 (correct). Returns
    (possibly-revised text, the pre-correction drift report, gaps filled, passes)."""
    drift = await _detect_drift(
        text, outline=ctx["outline"], chapter_number=req.chapter_number,
        roster_text=roster_text, period=period, model=model,
    )
    if drift is None:
        return text, None, [], 0
    facts = ""
    gaps_filled: list[str] = []
    if drift.research_gaps:
        facts = await _research_fill(drift.research_gaps, period=period, title=ctx["title"])
        if facts:
            gaps_filled = list(drift.research_gaps)
    needs_fix = bool(drift.story_drift or drift.character_drift or facts)
    if not needs_fix:
        return text, drift, gaps_filled, 0
    revised = await _correct_drift(
        text, drift=drift, facts=facts, roster_text=roster_text,
        genre_slug=ctx["genre_slug"], model=model,
    )
    # The correction must ADD depth, never shorten. If the rewrite came back shorter than the
    # full-length fanned draft (the model condensed/truncated/refused), keep the draft — the user's
    # priority is long, deep chapters. A small tolerance absorbs whitespace/markup churn.
    if len(revised.split()) < 0.97 * len(text.split()):
        return text, drift, [], 0
    return revised, drift, gaps_filled, 1


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
    roster_text = _roster_text(roster)
    drift_report: DriftReport | None = None
    research_gaps_filled: list[str] = []
    sub_briefs: list[SubChapterBrief] = []
    router = get_router(service=STEP_NAME)
    try:
        if n_sub > 1:
            briefs = await _plan_subchapters(ctx, req, n_sub, model)
            sub_briefs = briefs
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
            # Two-cycle QA on the assembled chapter: cycle 1 detects drift vs outline/arc/roster and
            # flags research gaps; we research-fill the gaps; cycle 2 corrects the drift and weaves the
            # facts in (streamed, so a ~12k-word chapter is revised without truncation).
            text, drift_report, research_gaps_filled, passes = await _two_cycle_qa(
                text, ctx=ctx, req=req, roster_text=roster_text, period=period, model=model,
            )
            final_qa = await _score_chapter(text, period, roster_text)
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
            drift_report=drift_report.model_dump(mode="json") if drift_report else None,
            research_gaps_filled=research_gaps_filled,
            sub_chapter_briefs=[b.model_dump(mode="json") for b in sub_briefs],
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
    """Standalone QA cycle 1 — detect drift of a chapter vs its outline beat + arc + roster."""
    from writer_engine.config import get_settings

    text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    outline = payload.get("outline") or {}
    chapter_number = int(payload.get("chapter_number") or 0)
    roster_text = _roster_text(payload.get("roster") or []) if payload.get("roster") else "(none)"
    period = str(payload.get("period") or "contemporary")
    drift = await _detect_drift(
        text, outline=outline, chapter_number=chapter_number,
        roster_text=roster_text, period=period, model=get_settings().model_default,
    )
    if drift is None:
        return DriftScanResult(
            chapter_id=payload.get("chapter_id") or uuid4(),
            findings=[DriftFinding(kind="error", detail="drift QA JSON could not be parsed")],
        ).model_dump(mode="json")
    findings = (
        [DriftFinding(kind="story_drift", detail=d) for d in drift.story_drift]
        + [DriftFinding(kind="character_drift", detail=d) for d in drift.character_drift]
        + [DriftFinding(kind="research_gap", detail=d) for d in drift.research_gaps]
    ) or [DriftFinding(kind="aligned", detail="no drift detected")]
    return DriftScanResult(
        chapter_id=payload.get("chapter_id") or uuid4(), findings=findings
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
