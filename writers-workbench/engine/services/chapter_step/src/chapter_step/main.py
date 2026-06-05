"""chapter-step — write / qa / scan-drift / evaluate-genre / extract-bible / format-kindle.

Operations dispatch via ``payload["op"]``. The ``write`` and ``qa`` ops compose the Follett
writing-craft layer (``follett_seeds.*``) on top of genre + story arc; the remaining ops are F1-2
follow-ups. Real-LLM calls fall back to deterministic fixtures when no provider is registered, so
the service boots and tests run without live keys.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any
from uuid import uuid4

from writer_engine.llm import ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import compose_craft_system, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.chapter import (
    BibleEntry,
    BibleExtract,
    ChapterCraftQa,
    DriftFinding,
    DriftReport,
    DriftScanResult,
    GenreEval,
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


def _roster_from_outline(outline: dict[str, Any]) -> list[dict[str, Any]]:
    """Derive a {name, description} roster from an outline's `characters` list (so a chapter written
    from a provided/revised outline checks consistency against THAT outline's cast)."""
    out = []
    for c in (outline or {}).get("characters") or []:
        if isinstance(c, dict) and c.get("name"):
            desc = " ".join(str(c.get(k, "")) for k in ("role", "description") if c.get(k)).strip()
            out.append({"name": str(c["name"]), "description": desc})
    return out


def _apply_ctx_overrides(ctx: dict[str, Any], payload: dict[str, Any] | None) -> dict[str, Any]:
    """Let a caller pass `outline`/`title`/`genre_slug`/`roster` in the payload to override the DB
    (e.g. write chapters from a revised outline that isn't persisted yet). When an outline override
    is given without an explicit roster, the roster is derived from that outline's characters."""
    if not payload:
        return ctx
    if payload.get("title"):
        ctx["title"] = str(payload["title"])
    if payload.get("genre_slug"):
        ctx["genre_slug"] = str(payload["genre_slug"])
    outline_override = payload.get("outline")
    if isinstance(outline_override, dict) and outline_override:
        ctx["outline"] = outline_override
        if not payload.get("roster"):
            derived = _roster_from_outline(outline_override)
            if derived:
                ctx["roster"] = derived
    roster_override = payload.get("roster")
    if isinstance(roster_override, list) and roster_override:
        ctx["roster"] = [
            r if isinstance(r, dict) else {"name": str(r), "description": ""} for r in roster_override
        ]
    return ctx


async def _load_context(project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Load genre/outline/title + character roster from Supabase, then apply any payload overrides.
    Fixture when DB is unconfigured."""
    from writer_engine.config import get_settings

    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        return _apply_ctx_overrides(
            {"genre_slug": "post-apocalyptic", "title": "Untitled", "outline": {}, "roster": []}, payload
        )
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
    return _apply_ctx_overrides(
        {
            "genre_slug": proj.get("genre_slug") or "",
            "title": proj.get("title") or "Untitled",
            "outline": proj.get("outline") or {},
            "roster": roster,
        },
        payload,
    )


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


def _compact_outline_view(outline: dict[str, Any], chapter_number: int) -> str:
    """A token-lean outline view for a single chapter's prompt: the story's premise + arc, THIS
    chapter's full entry, and a one-line-per-chapter index of the rest (no per-chapter beats).

    Dumping the entire outline (every chapter's full beat) into every sub-chapter prompt makes the
    request huge and slow for a long novel (a 96-chapter dual-timeline outline ran ~20min/chapter and
    risked the 30-min job timeout). The writer only needs THIS chapter in full plus light arc context.
    """
    o = outline or {}
    lines: list[str] = []
    for k in ("title", "premise", "story_arc_name", "dramatic_question"):
        if o.get(k):
            lines.append(f"{k.upper()}: {o[k]}")
    chapters = o.get("chapters") or []
    focal = None
    index: list[str] = []
    for ch in chapters:
        if not isinstance(ch, dict):
            continue
        num = ch.get("chapter_number")
        if str(num) == str(chapter_number):
            focal = ch
        index.append(
            f"  {num}. {ch.get('title', '')}"
            f"{' [' + str(ch.get('act')) + ']' if ch.get('act') else ''}"
            f"{' (POV ' + str(ch.get('pov_character')) + ')' if ch.get('pov_character') else ''}"
        )
    if focal is not None:
        lines.append("\nTHIS CHAPTER (write this one):")
        for k in ("chapter_number", "title", "act", "arc_point", "pov_character", "bridge_from_prior", "beat"):
            if focal.get(k):
                lines.append(f"  {k}: {focal[k]}")
    if index:
        lines.append("\nFULL CHAPTER INDEX (for arc context — titles only):")
        lines.extend(index)
    return "\n".join(lines) if lines else str(o)


def _chapter_header(ctx: dict[str, Any], roster: list, req: WriteChapterRequest) -> str:
    """Shared context block (project + compact outline + roster) for the chapter prompts."""
    lines = [
        f"PROJECT: {ctx['title']}",
        f"CHAPTER NUMBER: {req.chapter_number}",
        "",
        f"OUTLINE:\n{_compact_outline_view(ctx['outline'], req.chapter_number)}",
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


def _briefs_from_payload(payload: dict[str, Any]) -> list[SubChapterBrief]:
    """Use a pre-made chapter outline (sub-chapter plan) from the caller, if supplied — the explicit
    outline -> chapter-outline -> narrative flow. Accepts `sub_chapter_briefs` or `chapter_outline`."""
    raw = payload.get("sub_chapter_briefs") or payload.get("chapter_outline") or payload.get("briefs")
    if isinstance(raw, dict):
        raw = raw.get("sub_chapter_briefs") or raw.get("subchapters") or raw.get("beats")
    if not isinstance(raw, list) or not raw:
        return []
    out: list[SubChapterBrief] = []
    for b in raw:
        if isinstance(b, dict):
            out.append(SubChapterBrief.model_validate(b))
        elif isinstance(b, str):
            out.append(SubChapterBrief(beat=b))
    return out


async def _op_plan(payload: dict) -> dict:
    """Chapter-outline stage (outline -> CHAPTER OUTLINE -> narrative): produce the sub-chapter plan
    for one chapter. Accepts an outline/roster override so it can run off a revised, unpersisted
    outline. The returned `sub_chapter_briefs` can be fed straight back into `write`."""
    from writer_engine.config import get_settings

    project_id = payload.get("project_id") or "00000000-0000-0000-0000-000000000000"
    chapter_number = int(payload.get("chapter_number") or 1)
    chapter_run_id = payload.get("chapter_run_id") or str(uuid4())
    req = WriteChapterRequest.model_validate(
        {"project_id": project_id, "chapter_number": chapter_number, "chapter_run_id": chapter_run_id,
         "sub_chapter_count_override": payload.get("sub_chapter_count_override")}
    )
    ctx = await _load_context(str(req.project_id), payload)
    settings = get_settings()
    model = {"haiku": settings.model_cheap, "sonnet": settings.model_default}.get(
        str(payload.get("llm_strategy") or ""), settings.model_default
    )
    n_sub = max(1, min(int(req.sub_chapter_count_override or 5), 6))
    briefs = await _plan_subchapters(ctx, req, n_sub, model)
    return {
        "chapter_number": chapter_number,
        "sub_chapter_briefs": [b.model_dump(mode="json") for b in briefs],
        "count": len(briefs),
    }


# Meta/scaffolding the model sometimes prepends to prose despite "prose only" — a "Confirmed cast"
# block (from the locked_roster COPY-FIRST rule), a POV-selector preamble, draft/sub-chapter
# headings, or a chatty "Here is the revised chapter" lead-in. Stripped so only story prose ships.
# A leading paragraph is scaffolding if its first line begins with one of these meta labels — a
# "Confirmed cast" block (locked_roster COPY-FIRST rule), a POV-selector preamble, a draft/sub-chapter
# heading, or a chatty "Here is the revised chapter" lead-in. Matched at the TOP only.
_SCAFFOLD_PREFIX = re.compile(
    r"^\s*[#>*_(\-]*\s*"
    r"(?:confirmed cast|locked characters?|pov character|pov\b|cast\s*[:.]|"
    r"validation\b|scene check|craft check|bme check|"
    r"why\s+(?:her|his|their|the)\b.*?stake|no locked characters|all characters introduced|"
    r"this is the opening (?:chapter|scene)|chapter\s+\d+\s*[—:\-].*(?:revised|draft)|"
    r"full revised draft|revised chapter\b|sub-?chapter\s+\d+|"
    r"here(?:'s| is)\b[^.]*\b(?:revis|chapter|draft)|i(?:'ve| have)\b[^.]*\brevis)",
    re.IGNORECASE,
)


def _strip_scaffolding(text: str) -> str:
    """Drop leading meta/scaffolding paragraphs so the chapter starts on real story prose — not a
    'Confirmed cast' block, a 'POV CHARACTER: …' preamble, or a '## Chapter N — Revised Draft'
    heading. Only strips from the TOP, only SHORT label-like paragraphs (so embedded prose is never
    lost), and stops at the first real paragraph."""
    paras = re.split(r"\n\s*\n", text.strip())
    i = 0
    while i < len(paras):
        p = paras[i].strip()
        head = p.lstrip("*_>#- ").strip()
        if head in {"", "---", "***", "___"}:
            i += 1
            continue
        # Only strip a meta paragraph when it's short enough to be a label/heading, not a prose
        # paragraph that merely starts with a meta-ish word.
        if _SCAFFOLD_PREFIX.match(p) and len(p.split()) <= 30:
            i += 1
            continue
        break
    out = "\n\n".join(paras[i:]).strip()
    return out or text.strip()


def _subchapter_plan_text(briefs: list[SubChapterBrief]) -> str:
    """The whole chapter's sub-beats as a compact plan, so a sub-chapter written WITHOUT a prior tail
    (the parallel path) still knows what comes before and after it and can keep the chapter coherent."""
    return "CHAPTER PLAN (all sub-chapters, in order — keep yours consistent with these):\n" + "\n".join(
        f"  {i + 1}. {b.title or '(untitled)'} — {b.beat}" for i, b in enumerate(briefs)
    )


async def _write_subchapter(
    *, system: str, header: str, brief: SubChapterBrief, idx: int, total: int,
    prior_tail: str, chapter_number: int, model: str, grounding: str = "", plan_context: str = "",
) -> str:
    """Write one sub-chapter (~2-3k words). Continuity comes from the prior sub-chapter's tail
    (sequential path) OR, when there is no prior tail, from the full chapter plan (parallel path).
    The pre-fetched research grounding is woven in either way."""
    if prior_tail:
        continuity = (
            f"\n\nCONTINUE SEAMLESSLY from the end of the previous sub-chapter (do NOT restate it; pick "
            f"up the thread). Tail of the previous sub-chapter:\n…{prior_tail}"
        )
    elif plan_context and idx > 0:
        continuity = (
            f"\n\nThis is sub-chapter {idx + 1}; it is being written alongside the others. Open in a way "
            f"that flows from sub-chapter {idx} and leads into {idx + 2 if idx + 1 < total else 'the end'} "
            f"— no recap, no chapter heading.\n\n{plan_context}"
        )
    else:
        continuity = f"\n\n{plan_context}" if plan_context else ""
    grounding_block = (
        f"\n\nRESEARCH GROUNDING — weave the relevant facts below into THIS sub-chapter as concrete "
        f"sensory/material detail and accurate period language (dramatized, never an info-dump or a "
        f"list). Use what fits this beat; carry the rest into later sub-chapters:\n{grounding}"
        if grounding else ""
    )
    user = (
        f"{header}\n\nYou are writing SUB-CHAPTER {idx + 1} of {total} of chapter {chapter_number}.\n"
        f"This sub-chapter's beat: {brief.title} — {brief.beat}"
        f"{(' (POV: ' + brief.pov_character + ')') if brief.pov_character else ''}\n"
        f"Write this sub-chapter in full (rich, scene-driven prose, not a summary), following the craft "
        f"rules in the system prompt.{grounding_block}\n\n"
        f"OUTPUT — story prose ONLY. Do NOT print a chapter or 'Sub-chapter N' heading, a 'Validation' "
        f"or BEGINNING/MIDDLE/END checklist, a 'Confirmed cast' / 'POV character' label, or any notes — "
        f"just the prose.{continuity}"
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


def _outline_chapter_title(outline: dict[str, Any], chapter_number: int) -> str:
    """The chapter's title from the outline (e.g. 'Prologue: What the Ground Keeps'), or '' if none."""
    chapters = (outline or {}).get("chapters") or []
    for ch in chapters:
        if isinstance(ch, dict) and str(ch.get("chapter_number")) == str(chapter_number) and ch.get("title"):
            return str(ch["title"])
    if 0 <= chapter_number < len(chapters) and isinstance(chapters[chapter_number], dict):
        return str(chapters[chapter_number].get("title") or "")
    return ""


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


def _facts_topics(facts: str, limit: int = 14) -> list[str]:
    """Pull short topic labels out of a Perplexity facts block (bolded leads or bullet heads) so the
    QA summary can report WHAT was grounded, not just that something was."""
    topics: list[str] = []
    for ln in facts.splitlines():
        ln = ln.strip()
        m = re.match(r"^[-*•]\s*\*{0,2}([^:*]{4,80})\*{0,2}\s*[:—-]", ln) or re.match(r"^\*{2}([^*:]{4,80})\*{2}", ln)
        if m:
            t = m.group(1).strip(" *—-:")
            if t and t.lower() not in {x.lower() for x in topics}:
                topics.append(t)
        if len(topics) >= limit:
            break
    return topics


async def _chapter_research(beat: str, *, period: str, title: str) -> tuple[str, list[str]]:
    """Pre-write research grounding (Perplexity): given the chapter's planned beat, fetch SPECIFIC
    period facts / local color / material culture / real events to weave into the scene as it is
    written. Returns (facts_text, topic_labels). Empty on no provider / error — writing still proceeds.
    """
    if not str(beat).strip():
        return "", []
    router = get_router(service=STEP_NAME)
    shape = (
        f'For a chapter of the historical novel "{title}", set in {period}, where: {beat}\n\n'
        "Give SPECIFIC, period-accurate factual detail a novelist can weave into the scene — material "
        "culture, local color, geography, real events, terminology, sensory specifics, daily life. "
        "Use labeled bullets (one topic per bullet, the topic in bold, then 1-3 factual sentences). "
        "No preamble, no fiction, no plot suggestions — facts only."
    )
    try:
        resp = await router.complete(
            provider="perplexity", model="sonar-pro", system=None, prompt=shape, max_tokens=2048,
        )
    except ProviderNotRegistered:
        return "", []
    except Exception:
        return "", []
    facts = resp.text.strip()
    if resp.citations:
        facts += "\n\nSOURCES: " + "; ".join(resp.citations[:8])
    return facts, _facts_topics(facts)


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
        "\n\nYou are the CORRECTION pass (QA cycle 2). The chapter below has drifted from the plan. "
        "Revise it to FIX that drift while keeping everything that is already right. You MUST:\n"
        "1. Correct every STORY DRIFT item so the chapter matches its planned outline beat and the "
        "arc — restore missing beats, remove contradictions, keep the through-line.\n"
        "2. Correct every CHARACTER DRIFT item so each character matches the CHARACTER ROSTER in the "
        "user prompt (name, age, traits, relationships, voice) and stays in character.\n"
        "3. Keep the existing researched period detail accurate; do not strip it out.\n"
        "LENGTH — you are FIXING, not trimming. The revised chapter MUST be AT LEAST as long as the "
        "original. Do NOT summarize, condense, or drop scenes. PRESERVE the POV and the chapter's "
        "place in the story.\n"
        "OUTPUT — return ONLY the chapter prose. Do NOT print a cast list, a 'Confirmed cast' section, "
        "a 'POV character' line, a 'Validation' / BEGINNING-MIDDLE-END checklist, chapter or "
        "sub-chapter headings, or any notes about what you changed."
    )


async def _correct_drift(
    text: str, *, drift: DriftReport, roster_text: str, genre_slug: str, model: str,
    insist_length: bool = False,
) -> str:
    """QA cycle 2: streamed full-chapter revision that corrects story/character drift (research is
    already woven at write-time, so this pass only fixes drift and must not shorten)."""
    router = get_router(service=STEP_NAME)
    sd = "\n".join(f"- {x}" for x in drift.story_drift) or "(none)"
    cd = "\n".join(f"- {x}" for x in drift.character_drift) or "(none)"
    insist = (
        "\n\nYOUR PREVIOUS REVISION WAS TOO SHORT. Return the FULL chapter — every scene, at least as "
        "long as the original. Fix ONLY the drift listed; keep all other prose intact. Do not condense."
        if insist_length else ""
    )
    user = (
        f"CHARACTER ROSTER (consistency reference):\n{roster_text}\n\n"
        f"STORY DRIFT TO CORRECT:\n{sd}\n\n"
        f"CHARACTER DRIFT TO CORRECT:\n{cd}\n\n"
        f"CHAPTER TO REVISE:\n{text}{insist}"
    )
    resp = await router.complete(
        provider="anthropic", model=model, system=_build_correct_system(genre_slug),
        prompt=user, max_tokens=32768, stream=True,
    )
    return _strip_scaffolding(resp.text.strip())


async def _drift_correct_pass(
    text: str, *, ctx: dict[str, Any], req: WriteChapterRequest, roster_text: str, period: str, model: str
) -> tuple[str, DriftReport | None, int]:
    """QA cycle 1 (detect drift vs outline/arc/roster) -> QA cycle 2 (correct it, only when there is
    real story/character drift). Research is woven at WRITE-time, not here. Returns
    (possibly-revised text, the pre-correction drift report, passes)."""
    drift = await _detect_drift(
        text, outline=ctx["outline"], chapter_number=req.chapter_number,
        roster_text=roster_text, period=period, model=model,
    )
    if drift is None:
        return text, None, 0
    if not (drift.story_drift or drift.character_drift):
        return text, drift, 0  # aligned — nothing to correct
    # Real story/character drift (e.g. a name-continuity bug) is worth correcting even if the rewrite
    # tightens the prose a little. Accept the correction down to 0.85x the draft; if it comes back
    # shorter than that, retry once with a hard "return the FULL chapter, at least as long" push, then
    # keep the longer of the two — but never ship a chapter that collapsed below 0.85x the draft.
    draft_words = len(text.split())
    floor = 0.85 * draft_words
    revised = await _correct_drift(
        text, drift=drift, roster_text=roster_text, genre_slug=ctx["genre_slug"], model=model,
    )
    if len(revised.split()) < floor:
        retry = await _correct_drift(
            text, drift=drift, roster_text=roster_text, genre_slug=ctx["genre_slug"], model=model,
            insist_length=True,
        )
        revised = max((revised, retry), key=lambda t: len(t.split()))
    if len(revised.split()) < floor:
        return text, drift, 0  # correction kept collapsing — keep the full-length draft
    return revised, drift, 1


async def _op_write(payload: dict) -> dict:
    from writer_engine.config import get_settings

    req = WriteChapterRequest.model_validate(payload)
    ctx = await _load_context(str(req.project_id), payload)
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
    research_facts = ""
    sub_briefs: list[SubChapterBrief] = []
    router = get_router(service=STEP_NAME)
    try:
        if n_sub > 1:
            # Pre-write research grounding: pull period facts / local color for this chapter's beat so
            # the prose is grounded as it's written (woven in, lengthening the chapter) rather than
            # bolted on by a post-hoc rewrite that tends to shorten it.
            beat = _chapter_outline_beat(ctx["outline"], req.chapter_number)
            research_facts, research_gaps_filled = await _chapter_research(
                beat, period=period, title=ctx["title"]
            )
            # Use a pre-made chapter outline if the caller supplied one (the explicit
            # outline -> chapter-outline -> narrative flow); otherwise plan it now.
            provided = _briefs_from_payload(payload)
            briefs = provided or await _plan_subchapters(ctx, req, n_sub, model)
            sub_briefs = briefs
            # F2.5 optimization: write the sub-chapters CONCURRENTLY (wall-time = slowest sub, not the
            # sum) when `parallel_subchapters` is set. Each parallel sub is coordinated by the full
            # chapter plan instead of the prior sub's tail. Default OFF so the sequential prior-tail
            # path (the validated baseline) is unchanged; the pre/post optimization test flips this.
            if bool(payload.get("parallel_subchapters")):
                plan_text = _subchapter_plan_text(briefs)
                sub_texts = list(await asyncio.gather(*[
                    _write_subchapter(
                        system=system, header=header, brief=brief, idx=i, total=len(briefs),
                        prior_tail="", chapter_number=req.chapter_number, model=model,
                        grounding=research_facts, plan_context=plan_text,
                    )
                    for i, brief in enumerate(briefs)
                ]))
            else:
                sub_texts = []
                prior_tail = ""
                for i, brief in enumerate(briefs):
                    t = await _write_subchapter(
                        system=system, header=header, brief=brief, idx=i, total=len(briefs),
                        prior_tail=prior_tail, chapter_number=req.chapter_number, model=model,
                        grounding=research_facts,
                    )
                    sub_texts.append(t)
                    prior_tail = " ".join(t.split()[-800:])
            text = "\n\n".join(sub_texts)
            # QA cycle 1 (detect drift vs outline/arc/roster) -> QA cycle 2 (correct it) — only fires a
            # streamed revision when there is real story/character drift. Research is already woven.
            text, drift_report, passes = await _drift_correct_pass(
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
            research_facts=research_facts,
            sub_chapter_briefs=[b.model_dump(mode="json") for b in sub_briefs],
        )
    except ProviderNotRegistered:
        out = _fixture_chapter(req)
    result = out.model_dump(mode="json")
    result["persist"] = await _persist_chapter_if_requested(payload, ctx, out)
    return result


async def _persist_chapter_if_requested(
    payload: dict, ctx: dict[str, Any], out: WriteChapterResponse
) -> dict | None:
    """CR-001 (W3+W4): when `persist` + project_id + user_id are supplied, save the chapter to
    published_content_v2 (+ a content_versions_v2 snapshot, idempotent on project+chapter_number) and
    extract + upsert its story-bible entries. Best-effort — never breaks generation."""
    from writer_engine.config import get_settings

    if not payload.get("persist"):
        return None
    project_id, user_id = payload.get("project_id"), payload.get("user_id")
    if not (project_id and user_id):
        return {"persisted": False, "reason": "persist requested but project_id/user_id missing"}
    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return {"persisted": False, "reason": "supabase not configured"}
    chapter_number = int(payload.get("chapter_number") or 0)
    project_title = str(payload.get("title") or ctx.get("title") or "Untitled")
    genre = str(ctx.get("genre_slug") or payload.get("genre_slug") or "")
    # CR-002 W3: store the chapter under its OUTLINE title (e.g. "Prologue: What the Ground Keeps"),
    # not a generic "Project — Chapter N", so the UI lists meaningful titles. Fall back to a numbered
    # title only when the outline has no entry for this chapter.
    chapter_title = _outline_chapter_title(ctx.get("outline") or {}, chapter_number) or (
        f"{project_title} — Chapter {chapter_number}"
    )
    try:
        from writer_engine.persist_helpers import persist_bible, persist_chapter
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        content_id = await persist_chapter(
            client, project_id=str(project_id), user_id=str(user_id), chapter_number=chapter_number,
            title=chapter_title, content_text=out.content_text, genre_slug=genre,
            metadata={"chapter_run_id": str(out.chapter_run_id), "word_count": out.word_count,
                      "sub_chapter_count": out.sub_chapter_count, "craft_qa": out.craft_qa},
        )
    except Exception as exc:
        return {"persisted": False, "error": str(exc)[:200]}
    # Bible extraction/persist is a SEPARATE best-effort step — a failure here must NOT mask the
    # chapter persist that already succeeded above.
    bible_info: dict = {"bible_entries": 0}
    try:
        bible = await _op_extract_bible({"content_text": out.content_text})
        bible_info["bible_entries"] = await persist_bible(
            client, project_id=str(project_id), user_id=str(user_id),
            entries=bible.get("entries") or [], chapter_number=chapter_number,
        )
    except Exception as exc:
        bible_info["bible_error"] = str(exc)[:200]
    return {"persisted": True, "content_id": content_id, **bible_info}


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


def _build_rewrite_system(genre_slug: str) -> str:
    """Chapter rewrite from author feedback (n8n 'rewrite chapter' parity)."""
    return compose_craft_system(
        seed_keys=[
            "follett_seeds.scene.fix_now",
            "follett_seeds.prose.daily_rewrite",
            "follett_seeds.prose.transparent",
            "follett_seeds.prose.dialogue",
            "follett_seeds.scene.turn_density",
            "follett_seeds.research.local_color",
            "follett_seeds.research.no_dumping",
        ],
        genre_block=_genre_block(genre_slug),
    ) + (
        "\n\nYou are REWRITING an existing chapter to apply the author's FEEDBACK. Apply every point of "
        "the feedback faithfully. Preserve the chapter's place in the story, its POV, and the established "
        "characters (consistent with the CHARACTER ROSTER) unless the feedback explicitly changes them. "
        "Unless the feedback asks you to cut or shorten, keep the chapter AT LEAST as long as the "
        "original. OUTPUT — story prose ONLY: no chapter/sub-chapter headings, no 'Confirmed cast' / "
        "'POV character' / 'Validation' labels, no notes about what you changed."
    )


async def _op_rewrite(payload: dict) -> dict:
    """Rewrite an existing chapter per author feedback. Ports the n8n chapter-rewrite feature.

    Payload: {chapter_text|content_text, feedback|directive, project_id?, llm_strategy?, allow_shorten?}.
    """
    from writer_engine.config import get_settings

    text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    feedback = str(
        payload.get("feedback") or payload.get("directive") or payload.get("instructions") or ""
    ).strip()
    if not text or not feedback:
        return {"content_text": text, "word_count": len(text.split()), "rewritten": False,
                "note": "rewrite needs both chapter_text and feedback"}
    project_id = payload.get("project_id")
    ctx = (
        await _load_context(str(project_id), payload) if project_id
        else _apply_ctx_overrides({"genre_slug": "", "title": "", "outline": {}, "roster": []}, payload)
    )
    roster_text = _roster_text(ctx.get("roster") or [])
    settings = get_settings()
    model = {"haiku": settings.model_cheap, "sonnet": settings.model_default}.get(
        str(payload.get("llm_strategy") or ""), settings.model_default
    )
    allow_shorten = bool(payload.get("allow_shorten"))
    router = get_router(service=STEP_NAME)
    try:
        resp = await router.complete(
            provider="anthropic", model=model, system=_build_rewrite_system(ctx.get("genre_slug", "")),
            prompt=(
                f"CHARACTER ROSTER (consistency reference):\n{roster_text}\n\n"
                f"AUTHOR FEEDBACK (apply all of it):\n{feedback}\n\n"
                f"CHAPTER TO REWRITE:\n{text}"
            ),
            max_tokens=32768, stream=True,
        )
    except ProviderNotRegistered:
        return {"content_text": text, "word_count": len(text.split()), "rewritten": False,
                "note": "no LLM provider"}
    rewritten = _strip_scaffolding(resp.text.strip())
    # Guard: a rewrite that collapsed the chapter (when the feedback did not ask to shorten) keeps the
    # original rather than shipping a truncated/condensed chapter.
    if not allow_shorten and len(rewritten.split()) < 0.9 * len(text.split()):
        return {"content_text": text, "word_count": len(text.split()), "rewritten": False,
                "note": "rewrite came back too short; kept the original"}
    return {"content_text": rewritten, "word_count": len(rewritten.split()), "rewritten": True}


def _build_genre_eval_system(genre_slug: str) -> str:
    return compose_craft_system(seed_keys=[], genre_block=_genre_block(genre_slug)) + (
        "\n\nScore from 0.0 to 1.0 how well the chapter below fits and delivers on its GENRE's "
        "conventions, tone, and reader expectations (1.0 = exemplary). Add 1-4 short notes citing what "
        "fits and what doesn't. Return strict JSON matching GenreEval {genre_score, notes}."
    )


async def _op_evaluate_genre(payload: dict) -> dict:
    """Real LLM genre-fit score for a chapter (F1-2)."""
    from writer_engine.config import get_settings

    text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    genre = str(payload.get("genre_slug") or payload.get("genre") or "")
    if not text:
        return {"genre_score": None, "notes": ["no chapter text supplied"]}
    router = get_router(service=STEP_NAME)
    try:
        ev, _resp = await complete_structured(
            router, provider="anthropic", model=get_settings().model_default,
            system=_build_genre_eval_system(genre), prompt=f"GENRE: {genre}\n\nCHAPTER:\n{text}",
            schema=GenreEval, max_tokens=1024,
        )
        return ev.model_dump(mode="json")
    except ProviderNotRegistered:
        return {"genre_score": 0.9, "notes": ["(fixture — no LLM provider)"]}
    except ValueError:
        return {"genre_score": None, "notes": ["genre-eval JSON could not be parsed"]}


def _build_extract_bible_system() -> str:
    return compose_craft_system(seed_keys=[]) + (
        "\n\nExtract the story-bible entries the chapter below introduces or develops: characters, "
        "places, objects, concepts, and events that matter to continuity. For each give "
        "{entry_type, name, description} where entry_type is one of character|place|object|concept|"
        "event and the description is a concise, factual continuity note (traits, role, location, "
        "significance). Do NOT invent entries not present in the text. Return strict JSON matching "
        "BibleExtract {entries: [...]}."
    )


async def _op_extract_bible(payload: dict) -> dict:
    """Real LLM story-bible extraction from a chapter (F1-2)."""
    from writer_engine.config import get_settings

    text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    if not text:
        return {"entries": [], "added": 0, "note": "no chapter text supplied"}
    router = get_router(service=STEP_NAME)
    try:
        extract, _resp = await complete_structured(
            router, provider="anthropic", model=get_settings().model_default,
            system=_build_extract_bible_system(), prompt=f"CHAPTER:\n{text}",
            schema=BibleExtract, max_tokens=4096,
        )
        entries = [e.model_dump(mode="json") for e in extract.entries]
        persisted = await _persist_bible_if_requested(payload, entries)
        return {"entries": entries, "added": len(entries), "persist": persisted}
    except ProviderNotRegistered:
        entries = [BibleEntry(entry_type="character", name="(fixture)", description="no LLM provider").model_dump(mode="json")]
        return {"entries": entries, "added": len(entries)}
    except ValueError:
        return {"entries": [], "added": 0, "note": "extract-bible JSON could not be parsed"}


async def _persist_bible_if_requested(payload: dict, entries: list[dict]) -> dict | None:
    """CR-001 (W4): when `persist` + project_id + user_id are supplied, save extracted bible entries
    to story_bible_v2. Lets extract-bible double as a bible backfill for already-written chapters."""
    from writer_engine.config import get_settings

    if not payload.get("persist"):
        return None
    project_id, user_id = payload.get("project_id"), payload.get("user_id")
    if not (project_id and user_id):
        return {"persisted": False, "reason": "persist requested but project_id/user_id missing"}
    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return {"persisted": False, "reason": "supabase not configured"}
    try:
        from writer_engine.persist_helpers import persist_bible
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        added = await persist_bible(
            client, project_id=str(project_id), user_id=str(user_id), entries=entries,
            chapter_number=payload.get("chapter_number"),
        )
        return {"persisted": True, "bible_entries": added}
    except Exception as exc:
        return {"persisted": False, "error": str(exc)[:200]}


async def _op_format_kindle(payload: dict) -> dict:
    return {"docx_storage_path": f"kindle/{payload.get('chapter_id', 'unknown')}.docx"}


OPS = {
    "write": _op_write,
    "plan": _op_plan,
    "rewrite": _op_rewrite,
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
