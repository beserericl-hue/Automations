"""chapter-step — write / qa / scan-drift / evaluate-genre / extract-bible / blog / short-story.

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
from writer_engine.telemetry import token_accounting
from writer_engine.telemetry.logging import get_logger

STEP_NAME = "chapter"
logger = get_logger(STEP_NAME)
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
    outline = proj.get("outline") or {}
    # Roster source of truth = the OUTLINE's curated character cast, NOT story_bible_v2. The bible
    # accumulates a new row for every name variant each chapter extraction emits ("Marcus", "Marcus
    # Fenn", "Marcus Redcloud"; 8 "Tayak" variants; possessives like "Kimi's boyfriend"; "The ..."
    # fragments) — exact-name dedup never merges them, so over a 96-chapter novel it grows to ~300
    # self-contradictory "characters". Feeding that to the writer AND the drift detector guarantees
    # unfixable factual drift (the roster contradicts itself). The outline cast is the consistent,
    # complete (~19 chars, with ages/roles) canon. Fall back to the bible only when the outline has none.
    roster = _roster_from_outline(outline)
    if not roster:
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
            "outline": outline,
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


# Dash characters the writing directive bans (AI tells). Defined via escapes so the source carries no
# ambiguous unicode: _EM = em-dash (U+2014), _EN = en-dash (U+2013).
_EM, _EN = "\u2014", "\u2013"

# Line-edit directive (repair): strengthen every sentence without changing meaning. Targets the
# AI-prose signatures the user flagged: em-dashes, escalating clause-chains, trailing fragments.
LINE_EDIT_RULES = (
    "\n\nLINE EDIT: apply to EVERY sentence; preserve meaning AND length (this is sentence-level "
    "strengthening, NOT condensing; do not cut scenes, content, or detail):\n"
    f"1. Remove ALL em-dashes ({_EM}), en-dashes used as dashes ({_EN}), and double-hyphens (--). "
    "Rewrite the sentence with a period or comma so it reads naturally; do not merely delete the dash.\n"
    "2. Break run-on sentences and escalating clause-chains into clear, separate sentences. Example of "
    f"what to fix: 'thank you was not the same as gratitude {_EM} it was a form of patience, and "
    "patience was a kind of power, and she needed every kind she had.' Keep every idea, but unchain it "
    "into plain sentences.\n"
    "3. Cut AI stylistic tics: trailing fragments ('..., not yet', '..., or not'), piled-up "
    "'the way you [verb]' similes, and abstract escalation ('a kind of X ... a kind of Y'). Prefer "
    "concrete, strong, declarative prose.\n"
    "4. Vary sentence length. Keep the author's voice and all story content intact.\n"
)

# Deterministic backstop applied after the LLM line-edit so no banned dash survives.
_EM_DASH_RE = re.compile(f"\\s*(?:{_EM}|{_EN}|--)\\s*")


def _strip_em_dashes(text: str) -> str:
    """Last-resort guarantee that no em-dash / en-dash-as-dash / double-hyphen survives (the LLM
    line-edit does the real rewriting; this catches stragglers). Replaces the dash with a comma +
    space, which keeps the sentence grammatical without re-introducing the banned character."""
    return _EM_DASH_RE.sub(", ", text)


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


def _cached_write_system(base_system: str, header: str, grounding: str) -> str:
    """Prompt-caching: fold the per-chapter shared context (project/outline/roster header + research
    grounding) into the system block so it is CACHED once and reused across all sub-chapter calls,
    instead of re-sending it in every (uncached) user message. Only the per-sub beat/continuity then
    varies, so subs 2..N read the cache (big input-token + cost saving, eases the rate budget)."""
    parts = [base_system, "PROJECT / OUTLINE / CHARACTER-ROSTER CONTEXT:\n" + header]
    if grounding:
        parts.append(
            "RESEARCH GROUNDING — weave the relevant facts below into the prose as concrete sensory/"
            "material detail and accurate period language (dramatized, never an info-dump or a list):\n"
            + grounding
        )
    return "\n\n".join(parts)


async def _write_subchapter(
    *, system: str, brief: SubChapterBrief, idx: int, total: int,
    prior_tail: str, chapter_number: int, model: str, plan_context: str = "",
) -> tuple[str, int, int]:
    """Write one sub-chapter (~2-3k words). ``system`` is the CACHED per-chapter prefix
    (craft + context + grounding); only the small per-sub beat/continuity goes in the user message.
    Continuity comes from the prior sub-chapter's tail (sequential) or the chapter plan (parallel).
    Returns (prose, cache_read_tokens, cache_write_tokens) so the caller can report cache hits."""
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
    user = (
        f"You are writing SUB-CHAPTER {idx + 1} of {total} of chapter {chapter_number}.\n"
        f"This sub-chapter's beat: {brief.title} — {brief.beat}"
        f"{(' (POV: ' + brief.pov_character + ')') if brief.pov_character else ''}\n"
        f"Write this sub-chapter in full (rich, scene-driven prose, not a summary), following the craft "
        f"rules, the project context, and the research grounding in the system prompt.\n\n"
        f"OUTPUT — story prose ONLY. Do NOT print a chapter or 'Sub-chapter N' heading, a 'Validation' "
        f"or BEGINNING/MIDDLE/END checklist, a 'Confirmed cast' / 'POV character' label, or any notes — "
        f"just the prose.{continuity}"
    )
    router = get_router(service=STEP_NAME)
    resp = await router.complete(
        provider="anthropic", model=model, system=system, prompt=user, max_tokens=8192, cache_system=True
    )
    return _strip_scaffolding(resp.text.strip()), resp.cache_read_tokens, resp.cache_write_tokens


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
        "- character_drift: ONLY genuine inconsistencies of an ESTABLISHED roster character — a roster "
        "character renamed, or given a changed age/trait/role/relationship, an out-of-character action, "
        "a voice that doesn't match, or a fact that contradicts the roster/bible. Name the character "
        "and the inconsistency.\n"
        "  ADDITIVE detail is NOT drift: a roster bio is a one-line sketch, not an exhaustive spec. A "
        "character doing, owning, saying, or feeling something the bio simply doesn't mention (a habit, "
        "a prop like a notebook, a small backstory beat) is normal fleshing-out — flag it ONLY when it "
        "CONTRADICTS an explicit roster fact (e.g. the bio says he reads only published history and "
        "never investigates, but the chapter has him investigating). When unsure whether a detail is "
        "additive or contradictory, treat it as ADDITIVE — not drift.\n"
        "  IMPORTANT — do NOT flag NEW minor / walk-on / background characters who are appropriate to "
        "the scene (e.g. council members at a council meeting, a clerk, a waiter, a crowd member) just "
        "because they are not in the main roster. Introducing fitting minor characters is normal craft, "
        "NOT drift. Only flag a new character if they usurp a roster character's role, contradict an "
        "established fact, or are a main-cast-scale character invented off-outline.\n"
        "- research_gaps: short phrases for period facts / local color / material culture / events the "
        "chapter should add or verify to feel grounded in its time and place.\n"
        "Set aligned=true ONLY if story_drift and character_drift are both empty. Be exacting but do "
        "not invent drift that isn't there.\n"
        "Keep EACH finding to ONE short sentence — name the deviation; do NOT quote long passages from "
        "the chapter (that bloats and truncates the JSON). Return strict JSON matching DriftReport and "
        "nothing else (no prose before or after)."
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
    # Root cause of the ch4 `aligned=None`: at max_tokens=4096 the drift report truncated mid-JSON
    # (the model quoted long chapter passages in its findings) -> json.loads failed -> None. Give it
    # room (16k) AND retry once on a parse/validation failure (the model occasionally emits prose
    # instead of JSON). Only return None if both attempts genuinely fail to parse.
    for attempt in range(2):
        try:
            drift, _resp = await complete_structured(
                router, provider="anthropic", model=model,
                system=_build_drift_system(), prompt=prompt, schema=DriftReport, max_tokens=16384,
            )
            return drift
        except ProviderNotRegistered:
            return DriftReport()
        except ValueError:
            if attempt == 1:
                return None
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


def _research_focus(ctx: dict[str, Any]) -> str:
    """The story's binding research subject — its specific people / place / culture / period — built
    from the outline so Perplexity stays ON TOPIC. Without this anchor a beat like 'a burial rite'
    set in '100 BC' returns generic Old-World facts (Britain/Norway/Stonehenge) instead of THIS book's
    subject (e.g. Piscataway/Algonquian peoples of the Maryland-Chesapeake tidewater)."""
    o = ctx.get("outline") or {}
    parts: list[str] = []
    for key in ("setting", "premise"):
        v = o.get(key)
        if v:
            parts.append(f"{key.capitalize()}: {str(v)[:500]}")
    if ctx.get("genre_slug"):
        parts.append(f"Genre: {ctx['genre_slug']}")
    # the cast's cultural anchor — first roster line often names the people/place
    roster = ctx.get("roster") or []
    if roster and isinstance(roster[0], dict) and roster[0].get("description"):
        parts.append(f"Lead character: {roster[0].get('name')} — {str(roster[0]['description'])[:160]}")
    return "\n".join(parts)


async def _chapter_research(
    beat: str, *, period: str, title: str, focus: str = ""
) -> tuple[str, list[str]]:
    """Pre-write research grounding (Perplexity): given the chapter's planned beat, fetch SPECIFIC
    period facts / local color / material culture / real events to weave into the scene as it is
    written. ``focus`` binds the query to THIS story's specific people/place/culture so the research
    can't drift to unrelated cultures. Returns (facts_text, topic_labels). Empty on no provider / error.
    """
    if not str(beat).strip():
        return "", []
    router = get_router(service=STEP_NAME)
    focus_block = (
        f"\n\nSTORY SUBJECT (all facts MUST pertain to THIS specific people, place, and period):\n{focus}\n\n"
        "HARD CONSTRAINT: research only the culture/region/period described in STORY SUBJECT above. Do "
        "NOT return facts about other cultures or regions — no European / Old-World / Stonehenge-style "
        "analogues unless STORY SUBJECT is itself European. If unsure, prefer facts specific to the named "
        "people and place over generic period facts."
        if focus else ""
    )
    shape = (
        f'For a chapter of the historical novel "{title}", set in {period}, where: {beat}'
        f"{focus_block}\n\n"
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
        logger.warning("chapter.research.no_provider", reason="perplexity not registered")
        return "", []
    except Exception as exc:
        # The Piscataway-blindness path: if grounding fails the chapter still writes, but UNRESEARCHED.
        # Must be visible, not a silent empty-string.
        logger.warning("chapter.research.failed", error=str(exc)[:200], beat=str(beat)[:120])
        return "", []
    facts = resp.text.strip()
    if resp.citations:
        facts += "\n\nSOURCES: " + "; ".join(resp.citations[:8])
    logger.info("chapter.research.ok", topics=len(_facts_topics(facts)), chars=len(facts),
                citations=len(resp.citations or []))
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
        "user prompt (name, age, traits, relationships, voice) and stays in character. A roster "
        "RELATIONSHIP contradiction is the highest priority: if a scene's very PREMISE contradicts the "
        "roster (e.g. two characters the roster calls rivals are shown living together, sharing a bed, "
        "or acting as family), you MUST re-stage that scene so the relationship is correct — change the "
        "setting, blocking, and dialogue as needed so the characters relate the way the roster says. Do "
        "NOT merely soften a word; remove the contradicting premise entirely while preserving the "
        "scene's narrative purpose and length.\n"
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
    insist_length: bool = False, research_facts: str = "",
    line_edit: bool = False, style_directives: str = "", citation_mode: str = "",
) -> str:
    """QA cycle 2: streamed full-chapter revision that corrects story/character drift and, when
    ``research_facts`` is supplied (the repair path), WEAVES those researched facts into the prose to
    fill the chapter's research gaps. When ``line_edit`` is set, ALSO strengthens every sentence:
    removes em-dashes, breaks run-on clause-chains, cuts AI tics — meaning and length preserved.

    ``style_directives`` (author-supplied, the rewrite-with-research path) is applied as a hard
    revision instruction. ``citation_mode`` controls whether the woven research is invisible (fiction
    default) or carried as inline markdown footnotes (``inline`` — non-fiction)."""
    router = get_router(service=STEP_NAME)
    sd = "\n".join(f"- {x}" for x in drift.story_drift) or "(none)"
    cd = "\n".join(f"- {x}" for x in drift.character_drift) or "(none)"
    gaps = "\n".join(f"- {x}" for x in (drift.research_gaps or [])) or "(none)"
    insist = (
        "\n\nYOUR PREVIOUS REVISION WAS TOO SHORT. Return the FULL chapter — every scene, at least as "
        "long as the original. Fix ONLY the drift listed; keep all other prose intact. Do not condense."
        if insist_length else ""
    )
    citation_clause = (
        " Carry each researched fact with an inline markdown footnote citation (e.g. [^1]) and list the "
        "sources at the end — this is a non-fiction work."
        if citation_mode == "inline"
        else " Ground the prose in these facts WITHOUT footnotes, source labels, or citations in the "
        "narrative — this is fiction; the research must read as the author's own knowledge."
    )
    research_block = (
        f"\n\nRESEARCH GAPS to fill:\n{gaps}\n\n"
        f"RESEARCHED FACTS — weave these into the prose where they fit, as concrete sensory / material /"
        f" period detail (do NOT dump them as exposition, do NOT invent beyond them).{citation_clause}\n"
        f"{research_facts}\n"
        if research_facts.strip() else ""
    )
    style_block = (
        f"\n\nAUTHOR STYLE DIRECTIVES (apply all of these to the revised prose):\n{style_directives}\n"
        if style_directives.strip() else ""
    )
    user = (
        f"CHARACTER ROSTER (consistency reference):\n{roster_text}\n\n"
        f"STORY DRIFT TO CORRECT:\n{sd}\n\n"
        f"CHARACTER DRIFT TO CORRECT:\n{cd}\n"
        f"{research_block}"
        f"{style_block}"
        f"{LINE_EDIT_RULES if line_edit else ''}\n"
        f"CHAPTER TO REVISE:\n{text}{insist}"
    )
    resp = await router.complete(
        provider="anthropic", model=model, system=_build_correct_system(genre_slug),
        prompt=user, max_tokens=32768, stream=True,
    )
    return _strip_em_dashes(_strip_scaffolding(resp.text.strip()))


async def _drift_correct_pass(
    text: str, *, ctx: dict[str, Any], req: WriteChapterRequest, roster_text: str, period: str,
    model: str, min_length_ratio: float = 0.85, weave_research: bool = False, line_edit: bool = False,
    research_focus: str = "", style_directives: str = "", citation_mode: str = "",
) -> tuple[str, DriftReport | None, int]:
    """QA cycle 1 (detect drift vs outline/arc/roster + research gaps) -> QA cycle 2 (correct it).

    When ``weave_research`` is set (the REPAIR path), this also fetches focused research for the
    chapter's beat and WEAVES it into the correction — so a repair that surfaces research gaps actually
    fills them in the prose. When ``line_edit`` is set (also REPAIR), EVERY chapter is revised for
    sentence quality (em-dash removal, run-on/clause-chain simplification, AI-tic removal) even if it
    has no drift — so all sentences in all chapters get strengthened. Returns (possibly-revised text,
    the post-correction drift report, passes).

    ``min_length_ratio`` is the floor below which a (shrinking) correction is rejected. At WRITE time
    it is 0.85; the REPAIR op uses a higher floor now that the roster is clean (less to cut)."""
    drift = await _detect_drift(
        text, outline=ctx["outline"], chapter_number=req.chapter_number,
        roster_text=roster_text, period=period, model=model,
    )
    if drift is None:
        drift = DriftReport(aligned=True)  # line-edit still runs even when drift can't be scored
    # Fetch focused research when repairing — so research gaps can actually be filled in the prose.
    # An author-supplied ``research_focus`` (the rewrite-with-research path) ALWAYS triggers a fetch
    # and binds the Perplexity query to that focus, even when QA found no gaps — the user explicitly
    # asked to ground this chapter in that subject.
    research_facts = ""
    want_research = weave_research and (
        bool(research_focus.strip()) or drift.research_gaps or drift.story_drift or drift.character_drift
    )
    if want_research:
        beat = _chapter_outline_beat(ctx.get("outline") or {}, req.chapter_number)
        if research_focus.strip():
            beat = f"{beat}\n\nAUTHOR RESEARCH FOCUS (prioritise this): {research_focus.strip()}"
        research_facts, _ = await _chapter_research(
            beat, period=period, title=str(ctx.get("title") or ""), focus=_research_focus(ctx),
        )
    has_drift = bool(drift.story_drift or drift.character_drift)
    # Weave whenever we fetched facts — for an explicit research_focus there may be no QA gap to match,
    # but the author still wants those facts in the prose.
    has_research_to_weave = bool(weave_research and research_facts and (drift.research_gaps or research_focus.strip()))
    has_author_directive = bool(research_focus.strip() or style_directives.strip())
    # line_edit revises EVERY chapter (sentence strengthening), even a clean one.
    if not (has_drift or has_research_to_weave or line_edit or has_author_directive):
        return text, drift, 0  # aligned, nothing to weave, no line-edit / author directive requested
    draft_words = len(text.split())
    floor = min_length_ratio * draft_words
    revised = await _correct_drift(
        text, drift=drift, roster_text=roster_text, genre_slug=ctx["genre_slug"], model=model,
        research_facts=research_facts, line_edit=line_edit,
        style_directives=style_directives, citation_mode=citation_mode,
    )
    if len(revised.split()) < floor:
        retry = await _correct_drift(
            text, drift=drift, roster_text=roster_text, genre_slug=ctx["genre_slug"], model=model,
            insist_length=True, research_facts=research_facts, line_edit=line_edit,
            style_directives=style_directives, citation_mode=citation_mode,
        )
        revised = max((revised, retry), key=lambda t: len(t.split()))
    if len(revised.split()) < floor:
        return text, drift, 0  # correction collapsed below the floor — keep the original
    # Re-scan the CORRECTED text so the reported drift reflects the FINAL state, not the pre-correction
    # detection. Without this, every chapter that had ANY cycle-1 drift is stored aligned=False even
    # though cycle 2 fixed it — making the telemetry / project view read ~90% "drifted" when most are
    # actually clean. The post-correction report is what truly tells us which chapters still need repair.
    final_drift = await _detect_drift(
        revised, outline=ctx["outline"], chapter_number=req.chapter_number,
        roster_text=roster_text, period=period, model=model,
    )
    return revised, (final_drift or drift), 1


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
    cache_read = cache_write = 0
    router = get_router(service=STEP_NAME)
    try:
        if n_sub > 1:
            # Pre-write research grounding: pull period facts / local color for this chapter's beat so
            # the prose is grounded as it's written (woven in, lengthening the chapter) rather than
            # bolted on by a post-hoc rewrite that tends to shorten it.
            beat = _chapter_outline_beat(ctx["outline"], req.chapter_number)
            research_facts, research_gaps_filled = await _chapter_research(
                beat, period=period, title=ctx["title"], focus=_research_focus(ctx)
            )
            # Use a pre-made chapter outline if the caller supplied one (the explicit
            # outline -> chapter-outline -> narrative flow); otherwise plan it now.
            provided = _briefs_from_payload(payload)
            briefs = provided or await _plan_subchapters(ctx, req, n_sub, model)
            sub_briefs = briefs
            # Prompt caching: the craft system + chapter context + research grounding are identical
            # across all sub-chapters, so fold them into ONE cached system prefix (cache-write on the
            # first sub, cache-read on the rest) instead of re-sending them in every user message.
            cached_system = _cached_write_system(system, header, research_facts)
            # F2.5 optimization: write the sub-chapters CONCURRENTLY (wall-time = slowest sub, not the
            # sum) when `parallel_subchapters` is set. Each parallel sub is coordinated by the full
            # chapter plan instead of the prior sub's tail. Default OFF so the sequential prior-tail
            # path (the validated baseline) is unchanged; the pre/post optimization test flips this.
            if bool(payload.get("parallel_subchapters")):
                plan_text = _subchapter_plan_text(briefs)
                results = await asyncio.gather(*[
                    _write_subchapter(
                        system=cached_system, brief=brief, idx=i, total=len(briefs),
                        prior_tail="", chapter_number=req.chapter_number, model=model,
                        plan_context=plan_text,
                    )
                    for i, brief in enumerate(briefs)
                ])
                sub_texts = [t for t, _cr, _cw in results]
                cache_read = sum(cr for _t, cr, _cw in results)
                cache_write = sum(cw for _t, _cr, cw in results)
            else:
                sub_texts = []
                prior_tail = ""
                for i, brief in enumerate(briefs):
                    t, cr, cw = await _write_subchapter(
                        system=cached_system, brief=brief, idx=i, total=len(briefs),
                        prior_tail=prior_tail, chapter_number=req.chapter_number, model=model,
                    )
                    sub_texts.append(t)
                    cache_read += cr
                    cache_write += cw
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
        text = _strip_em_dashes(text)  # writing directive: no em-dashes in output (write path too)
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
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
        )
    except ProviderNotRegistered:
        out = _fixture_chapter(req)
    result = out.model_dump(mode="json")
    result["persist"] = await _persist_chapter_if_requested(payload, ctx, out, model=model)
    return result


async def _persist_chapter_if_requested(
    payload: dict, ctx: dict[str, Any], out: WriteChapterResponse, model: str = ""
) -> dict | None:
    """CR-001 (W3+W4) + CR-005: when `persist` + project_id + user_id are supplied, save the chapter to
    published_content_v2 (+ content_versions_v2 snapshot, idempotent on project+chapter_number), extract
    + upsert its story-bible entries, persist write-time research to research_reports_v2 + the story
    bible, and write a per-run telemetry row to chapter_qa_v2 (drift + QA + research/bible usage).
    Best-effort — never breaks generation, and every swallowed failure is logged (no silent OK)."""
    from writer_engine.config import get_settings

    if not payload.get("persist"):
        return None
    project_id, user_id = payload.get("project_id"), payload.get("user_id")
    chapter_number = int(payload.get("chapter_number") or 0)
    if not (project_id and user_id):
        logger.warning("chapter.persist.skip", reason="missing project_id/user_id", chapter=chapter_number)
        return {"persisted": False, "reason": "persist requested but project_id/user_id missing"}
    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        logger.warning("chapter.persist.skip", reason="supabase not configured", chapter=chapter_number)
        return {"persisted": False, "reason": "supabase not configured"}
    project_title = str(payload.get("title") or ctx.get("title") or "Untitled")
    genre = str(ctx.get("genre_slug") or payload.get("genre_slug") or "")
    # CR-002 W3: store the chapter under its OUTLINE title (e.g. "Prologue: What the Ground Keeps"),
    # not a generic "Project — Chapter N", so the UI lists meaningful titles. Fall back to a numbered
    # title only when the outline has no entry for this chapter.
    chapter_title = _outline_chapter_title(ctx.get("outline") or {}, chapter_number) or (
        f"{project_title} — Chapter {chapter_number}"
    )
    try:
        from writer_engine.persist_helpers import persist_chapter
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        # Universal em-dash backstop at the persist chokepoint: covers EVERY path, including the
        # repair floor-failure that keeps the original (un-line-edited) text — so no persisted chapter
        # carries a banned dash regardless of whether the LLM correction was accepted.
        clean_text = _strip_em_dashes(out.content_text)
        content_id = await persist_chapter(
            client, project_id=str(project_id), user_id=str(user_id), chapter_number=chapter_number,
            title=chapter_title, content_text=clean_text, genre_slug=genre,
            metadata={"chapter_run_id": str(out.chapter_run_id), "word_count": out.word_count,
                      "sub_chapter_count": out.sub_chapter_count, "craft_qa": out.craft_qa,
                      "drift_report": out.drift_report},
        )
    except Exception as exc:
        logger.exception("chapter.persist.failed", chapter=chapter_number, project=str(project_id))
        return {"persisted": False, "error": str(exc)[:200]}
    # Bible extraction/persist is a SEPARATE best-effort step — a failure here must NOT mask the
    # chapter persist that already succeeded above.
    bible_info: dict = {"bible_entries": 0}
    try:
        from writer_engine.persist_helpers import persist_bible

        bible = await _op_extract_bible({"content_text": out.content_text})
        bible_info["bible_entries"] = await persist_bible(
            client, project_id=str(project_id), user_id=str(user_id),
            entries=bible.get("entries") or [], chapter_number=chapter_number,
        )
    except Exception as exc:
        logger.warning("chapter.bible.failed", chapter=chapter_number, error=str(exc)[:200])
        bible_info["bible_error"] = str(exc)[:200]

    # CR-005: write-time research closure — persist the facts woven into this chapter to the research
    # report AND the story bible, so "any research is in the research report and the story bible".
    research_used = out.research_facts or ""
    if research_used:
        try:
            from writer_engine.persist_helpers import persist_bible, persist_research

            await persist_research(
                client, project_id=str(project_id), user_id=str(user_id),
                topic=f"{project_title} — Chapter {chapter_number} research", content=research_used,
                genre_slug=genre,
            )
            topics = _facts_topics(research_used)
            if topics:
                await persist_bible(
                    client, project_id=str(project_id), user_id=str(user_id),
                    entries=[{"entry_type": "research", "name": t, "description": research_used[:500]}
                             for t in topics[:12]],
                    chapter_number=chapter_number,
                )
            bible_info["research_persisted"] = True
        except Exception as exc:
            logger.warning("chapter.research.persist_failed", chapter=chapter_number, error=str(exc)[:200])
            bible_info["research_error"] = str(exc)[:200]

    # CR-005: per-run telemetry row (drift + QA + research/bible usage) for the project view.
    bible_loaded = [r.get("name") for r in (ctx.get("roster") or []) if isinstance(r, dict) and r.get("name")]
    try:
        from writer_engine.persist_helpers import persist_chapter_qa

        await persist_chapter_qa(
            client, project_id=str(project_id), user_id=str(user_id), chapter_number=chapter_number,
            telemetry={
                "chapter_run_id": str(out.chapter_run_id),
                "aligned": (out.drift_report or {}).get("aligned") if out.drift_report else None,
                "drift_report": out.drift_report,
                "craft_qa": out.craft_qa,
                "research_used": _facts_topics(research_used) if research_used else [],
                "bible_entries_loaded": bible_loaded,
                "word_count": out.word_count,
                "sub_chapter_count": out.sub_chapter_count,
                "craft_passes": out.craft_passes,
                "cache_read_tokens": out.cache_read_tokens,
                "cache_write_tokens": out.cache_write_tokens,
                "model": model,
                "status": "ok",
            },
        )
        bible_info["telemetry"] = True
    except Exception as exc:
        logger.warning("chapter.telemetry.failed", chapter=chapter_number, error=str(exc)[:200])
        bible_info["telemetry_error"] = str(exc)[:200]

    logger.info(
        "chapter.persisted", chapter=chapter_number, project=str(project_id),
        word_count=out.word_count, aligned=(out.drift_report or {}).get("aligned") if out.drift_report else None,
        bible_loaded=len(bible_loaded), bible_written=bible_info["bible_entries"],
        research=bool(research_used),
    )
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


async def _load_persisted_chapter(project_id: str, chapter_number: int) -> str:
    """Read a chapter's persisted text from published_content_v2 (for the repair op)."""
    from writer_engine.config import get_settings

    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return ""
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    resp = await (
        client.table("published_content_v2").select("content_text")
        .eq("project_id", project_id).eq("content_type", "chapter").eq("chapter_number", chapter_number)
        .limit(1).execute()
    )
    rows = getattr(resp, "data", None) or []
    return str(rows[0].get("content_text") or "") if rows else ""


async def _op_repair(payload: dict) -> dict:
    """Repair a persisted chapter's drift: re-run QA cycle 1 (detect, now hardened) + QA cycle 2
    (correct) on the EXISTING chapter text, then re-persist. Use to fix chapters that were written
    with drift (or whose drift detection failed). Reads the text from the DB when only
    project_id+chapter_number are given. Pass `persist:true` to write the repaired chapter back."""
    from writer_engine.config import get_settings

    project_id = payload.get("project_id")
    chapter_number = int(payload.get("chapter_number") or 0)
    text = str(payload.get("content_text") or "")
    if not text and project_id:
        text = await _load_persisted_chapter(str(project_id), chapter_number)
    if not text:
        return {"repaired": False, "reason": "no chapter text (give content_text or project_id+chapter_number)"}
    ctx = (
        await _load_context(str(project_id), payload) if project_id
        else _apply_ctx_overrides({"genre_slug": "", "title": "", "outline": {}, "roster": []}, payload)
    )
    roster_text = _roster_text(ctx.get("roster") or [])
    period = str(payload.get("period") or _outline_chapter_act(ctx.get("outline") or {}, chapter_number) or "contemporary")
    settings = get_settings()
    model = {"haiku": settings.model_cheap, "sonnet": settings.model_default}.get(
        str(payload.get("llm_strategy") or ""), settings.model_default
    )
    req = WriteChapterRequest.model_validate({
        "project_id": project_id or "00000000-0000-0000-0000-000000000000",
        "chapter_number": chapter_number, "chapter_run_id": payload.get("chapter_run_id") or str(uuid4()),
    })
    # Repair accepts a shorter result while fixing drift, but not a gutted one. Floor raised 0.6 -> 0.8
    # after the stress test: with the polluted roster, repairs over-cut (ch30 fell 7k -> 2.8k words to
    # "align" against a self-contradictory cast). Now the roster is the clean outline cast, so there is
    # far less to remove — keep at least 80% of the draft so a fix can't gut the chapter.
    min_ratio = float(payload.get("min_length_ratio") or 0.8)
    # Author-supplied params (rewrite-with-research path, B1): a research focus to ground the chapter
    # in, free-text style directives, and the citation mode (invisible for fiction / inline footnotes
    # for non-fiction). 'auto' is resolved to invisible|inline by the caller before it reaches here.
    research_focus = str(payload.get("research_focus") or "")
    style_directives = str(payload.get("style_directives") or "")
    citation_mode = str(payload.get("citation_mode") or "")
    new_text, drift, passes = await _drift_correct_pass(
        text, ctx=ctx, req=req, roster_text=roster_text, period=period, model=model,
        min_length_ratio=min_ratio, weave_research=True, line_edit=True,
        research_focus=research_focus, style_directives=style_directives, citation_mode=citation_mode,
    )
    persist_result = None
    # Persist whenever persist is requested — NOT only when a correction happened. A repair that
    # re-scans and finds the chapter already clean must still record the verified aligned=True state,
    # otherwise the stale pre-correction telemetry (aligned=False) lingers and the project view keeps
    # showing drift that was already fixed. `drift` here is the POST-correction re-scan (see
    # _drift_correct_pass), so the stored aligned reflects the true final state either way.
    if payload.get("persist"):
        out = WriteChapterResponse(
            chapter_id=uuid4(), chapter_run_id=req.chapter_run_id, content_text=new_text,
            word_count=len(new_text.split()), sub_chapter_count=0, craft_passes=passes,
            drift_report=drift.model_dump(mode="json") if drift else None,
        )
        persist_result = await _persist_chapter_if_requested(payload, ctx, out, model=model)
    d = drift.model_dump(mode="json") if drift else None
    return {
        "repaired": bool(passes), "content_text": new_text, "word_count": len(new_text.split()),
        "craft_passes": passes, "drift_report": d,
        "drift_detected": (d is not None and not d.get("aligned", True)) if d else None,
        "persist": persist_result,
    }


def _outline_chapter_act(outline: dict[str, Any], chapter_number: int) -> str:
    for ch in (outline or {}).get("chapters") or []:
        if isinstance(ch, dict) and str(ch.get("chapter_number")) == str(chapter_number):
            return str(ch.get("act") or "")
    return ""


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


# --- blog + short-story write tools (n8n parity; CR-009 Part 2) ---------------------------------

# The "Writing Prime Directive" carried verbatim from the n8n blog/short-story workflows.
_PRIME_DIRECTIVE = (
    "Write like a human, not a machine. Use clear, everyday language and short sentences. Cut cliches: "
    "no 'revolutionize', 'game-changing', 'unleash', or 'delve'. Get to the point, remove filler. No "
    "hype, just substance. Show, don't tell, with concrete detail. One idea per paragraph; keep them "
    "short. Respect the reader. Skip unnecessary adjectives and adverbs. After drafting, cut anything "
    "confusing or off-topic."
)


async def _load_genre_guidelines(genre_slug: str) -> tuple[str, str]:
    """(genre_name, writing_guidelines) from genre_config_v2; (slug, '') if unavailable."""
    from writer_engine.config import get_settings

    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key and genre_slug):
        return (genre_slug or "Science Fiction", "")
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        r = await (
            client.table("genre_config_v2").select("genre_name,writing_guidelines")
            .eq("genre_slug", genre_slug).limit(1).execute()
        )
        row = (getattr(r, "data", None) or [{}])[0]
        return (row.get("genre_name") or genre_slug, row.get("writing_guidelines") or "")
    except Exception:
        return (genre_slug, "")


async def _persist_simple(payload: dict, *, title: str, content_type: str, content_text: str,
                          genre_slug: str, metadata: dict | None = None) -> dict | None:
    """Persist a standalone piece (blog/short story) to published_content_v2 when persist is requested."""
    from writer_engine.config import get_settings

    if not payload.get("persist"):
        return None
    user_id = payload.get("user_id")
    settings = get_settings()
    if not (user_id and settings.supabase_url and settings.supabase_service_role_key):
        logger.warning("compose.persist.skip", reason="missing user_id / supabase", content_type=content_type)
        return {"persisted": False}
    try:
        from writer_engine.persist_helpers import persist_content
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        cid = await persist_content(
            client, user_id=str(user_id), title=title, content_type=content_type,
            content_text=_strip_em_dashes(content_text), genre_slug=genre_slug,
            project_id=payload.get("project_id"), metadata=metadata or {},
        )
        logger.info("compose.persisted", content_type=content_type, content_id=cid, words=len(content_text.split()))
        return {"persisted": True, "content_id": cid}
    except Exception as exc:
        logger.warning("compose.persist.failed", content_type=content_type, error=str(exc)[:200])
        return {"persisted": False, "error": str(exc)[:200]}


async def _op_blog(payload: dict) -> dict:
    """One-shot blog post (n8n write_blog_post parity): genre-aware, researched, SEO-structured."""
    from writer_engine.config import get_settings

    settings = get_settings()
    topic = str(payload.get("topic") or payload.get("message") or "").strip()
    genre_slug = str(payload.get("genre_slug") or "")
    keywords = payload.get("keywords") or ""
    target = int(payload.get("target_length") or 1500)
    genre_name, guidelines = await _load_genre_guidelines(genre_slug)
    research, _ = await _chapter_research(
        topic, period="contemporary", title=topic, focus=f"Genre: {genre_slug}. Blog topic: {topic}"
    ) if topic else ("", [])
    model = {"haiku": settings.model_cheap, "sonnet": settings.model_default}.get(
        str(payload.get("llm_strategy") or ""), settings.model_default)
    system = (
        f"You are a world-class blogger specializing in {genre_name}.\n\n## Genre Guidelines\n{guidelines}\n\n"
        f"## Writing Prime Directive\n{_PRIME_DIRECTIVE}\n\n## Requirements\n- Attention-grabbing headline\n"
        "- Hook opening paragraph\n- 3-5 subheadings for scannability\n- Relevant book/film recommendations\n"
        "- End with a discussion prompt\n- SEO-optimized without keyword stuffing\n\n"
        "Return strict JSON: {title, meta_description, body_markdown, tags}."
    )
    prompt = (f"Write a blog post about: {topic}\nTarget length: {target} words\nSEO keywords: {keywords}\n\n"
              f"## Research Context\n{research}")
    try:
        resp = await get_router(service=STEP_NAME).complete(
            provider="anthropic", model=model, system=system, prompt=prompt, max_tokens=8192)
    except ProviderNotRegistered:
        return {"written": False, "reason": "no provider"}
    import json as _json
    title, body, meta = (topic[:80] or "Untitled Blog Post"), resp.text.strip(), {}
    try:
        from writer_engine.llm.json_extractor import extract_json

        data = _json.loads(extract_json(resp.text))
        title = data.get("title") or title
        body = data.get("body_markdown") or body
        meta = {"meta_description": data.get("meta_description"), "tags": data.get("tags")}
    except Exception:
        pass
    body = _strip_em_dashes(body)
    persist = await _persist_simple(payload, title=title, content_type="blog_post",
                                    content_text=body, genre_slug=genre_slug, metadata=meta)
    return {"written": True, "title": title, "content_text": body, "word_count": len(body.split()),
            "persist": persist}


async def _op_short_story(payload: dict) -> dict:
    """One-shot short story (n8n write_short_story parity): genre + story arc, written from a premise
    or a brainstormed 3-beat outline, researched, with scene breaks."""
    from writer_engine.config import get_settings

    settings = get_settings()
    # Prefer a stored/brainstormed outline (premise + 3-beat structure); fall back to a raw premise.
    ctx = await _load_context(str(payload.get("project_id") or "00000000-0000-0000-0000-000000000000"), payload) \
        if payload.get("project_id") else _apply_ctx_overrides(
            {"genre_slug": payload.get("genre_slug") or "", "title": "", "outline": {}, "roster": []}, payload)
    outline = ctx.get("outline") or {}
    premise = str(payload.get("premise") or outline.get("premise") or payload.get("message") or "").strip()
    genre_slug = str(ctx.get("genre_slug") or payload.get("genre_slug") or "")
    genre_name, guidelines = await _load_genre_guidelines(genre_slug)
    title = str(outline.get("title") or payload.get("title") or (premise.split(".")[0][:60] if premise else "Untitled"))
    length = int(payload.get("length") or 3000)
    arc = _arc_summary(outline) if outline.get("chapters") or outline.get("story_arc_name") else ""
    research, _ = await _chapter_research(
        premise, period=str(payload.get("period") or "contemporary"), title=title,
        focus=_research_focus(ctx) or f"Genre: {genre_slug}. Premise: {premise}",
    ) if premise else ("", [])
    structure = ""
    if outline.get("chapters"):
        structure = "## Story Outline (follow exactly)\n" + "\n".join(
            f"Beat {c.get('chapter_number') or c.get('number') or i}: {c.get('title','')} — "
            f"{c.get('beat') or c.get('brief','')}" for i, c in enumerate(outline["chapters"], 1))
    model = {"haiku": settings.model_cheap, "sonnet": settings.model_default}.get(
        str(payload.get("llm_strategy") or ""), settings.model_default)
    system = (
        f"You are a world-class {genre_name} author.\n\n## Genre Guidelines\n{guidelines}\n\n"
        f"## Writing Prime Directive\n{_PRIME_DIRECTIVE}\n\n"
        + (f"## Story Arc\n{arc}\n\n" if arc else "")
        + "## Structure\nWrite a complete short story with natural scene breaks (use --- between scenes): "
        "(1) Opening — establish the world and protagonist; (2) Rising action — develop conflict and "
        "character; (3) Climax and resolution. Write the story text directly: no JSON, no metadata, "
        "no scene labels."
    )
    prompt = (f"Write a complete short story titled \"{title}\" of approximately {length} words.\n\n"
              f"Premise: {premise}\nTone: {payload.get('tone') or 'fitting the genre'}\n"
              f"{structure}\n\n## Research\n{research}")
    try:
        resp = await get_router(service=STEP_NAME).complete(
            provider="anthropic", model=model, system=system, prompt=prompt, max_tokens=16384, stream=True)
    except ProviderNotRegistered:
        return {"written": False, "reason": "no provider"}
    body = _strip_em_dashes(_strip_scaffolding(resp.text.strip()))
    persist = await _persist_simple(payload, title=title, content_type="short_story",
                                    content_text=body, genre_slug=genre_slug,
                                    metadata={"premise": premise})
    return {"written": True, "title": title, "content_text": body, "word_count": len(body.split()),
            "persist": persist}


OPS = {
    "write": _op_write,
    "plan": _op_plan,
    "rewrite": _op_rewrite,
    "repair": _op_repair,
    "qa": _op_qa,
    "scan-drift": _op_scan_drift,
    "evaluate-genre": _op_evaluate_genre,
    "extract-bible": _op_extract_bible,
    "blog": _op_blog,
    "short-story": _op_short_story,
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
    # CR-007: account every LLM call this op makes (sub-chapters, research, drift, QA, correction) and
    # write per-call token + cost rows to token_usage_v2 for billing.
    token_accounting.begin(
        user_id=inp.payload.get("user_id"),
        project_id=inp.payload.get("project_id"),
        chapter_number=inp.payload.get("chapter_number"),
        workflow=f"chapter.{op}",
    )
    try:
        result = await OPS[op](inp.payload)
    finally:
        usage = await token_accounting.flush()
    if isinstance(result, dict):
        result.setdefault("token_usage", usage)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": result},
    )


app = build_step_app(STEP_NAME, handler)
