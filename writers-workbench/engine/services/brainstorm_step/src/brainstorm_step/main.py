"""brainstorm-step — story / chapter / edit-outline, on the Follett plot+character craft layer.

``story`` composes genre + story arc + the plot/character seeds (dramatic question, outline gate,
weaving, anti-soggy-middle, heightened ending, wow factor, broad-strokes-then-twist, moral
complication, no-milk-and-water) and self-validates via the outline_gate. ``edit-outline`` applies
targeted edits under the 3-layer locked-roster lock so a revision never invents/loses characters.
Fixture fallback when no provider is registered.
"""

from __future__ import annotations

import json

from writer_engine.config import get_settings
from writer_engine.llm import ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import compose_craft_system, get_prompt_store, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.chapter import StoryOutline
from writer_engine.step_service import build_step_app

STEP_NAME = "brainstorm"
seed_default_prompts()

_STORY_SEEDS = [
    "follett_seeds.plot.dramatic_question",
    "follett_seeds.plot.weaving",
    "follett_seeds.plot.anti_sog",
    "follett_seeds.plot.heightened_ending",
    "follett_seeds.plot.wow_factor",
    "follett_seeds.plot.scene_density",
    "follett_seeds.character.broad_strokes_then_twist",
    "follett_seeds.character.moral_complication",
    "follett_seeds.character.no_milk_and_water",
    "follett_seeds.plot.outline_gate",  # self-validation, last
]


def _genre_block(genre: str) -> str:
    return f"GENRE: {genre}. Honour this genre's conventions and reader expectations." if genre else ""


def _arc_block(arc: str) -> str:
    return f"STORY ARC: {arc}. Structure the chapter beats along this arc's points." if arc else ""


def _build_story_system(genre: str, arc: str, title: str = "") -> str:
    """Pure: outline system = prime directive + genre + arc + plot/character seeds + outline gate.

    Locks the working title (a benchmark project's title must never be renamed) and demands a single
    coherent, explicitly-named story arc that every chapter is tagged against.
    """
    title_lock = (
        f'TITLE LOCK — the work is titled "{title}". Use this EXACT title in the `title` field. '
        "Do NOT invent, translate, or 'improve' the title.\n\n" if title else ""
    )
    return compose_craft_system(
        seed_keys=_STORY_SEEDS, genre_block=_genre_block(genre), arc_block=_arc_block(arc)
    ) + (
        "\n\n" + title_lock +
        "Produce the novel outline as strict JSON matching StoryOutline (title, premise, themes, "
        "story_arc_name, dramatic_question, wow_factor, characters, chapters).\n\n"
        "SCALE — this is a full-length novel, not a short story (Follett-scale). Requirements:\n"
        "1. CHAPTERS: 60-72 chapters PLUS a Prologue (chapter_number 0) and an Epilogue "
        "(chapter_number = last+1). Each chapter entry is COMPACT — {chapter_number, title, act, "
        "arc_point, pov_character, bridge_from_prior, beat} where `beat` is 1-2 sentences on what "
        "happens (a dramatic movement with a story turn). Keep entries compact so the whole arc fits.\n"
        "2. STORY ARC — name ONE coherent arc in `story_arc_name` and make it a single unbroken "
        "through-line: setup, escalating complications, a midpoint reversal, a crisis, a climax, and a "
        "resolution. Tag every chapter's `act` and `arc_point` to its position on that arc. The arc "
        "must honour the structure the premise implies (e.g. a layered excavation or vision-per-"
        "artifact premise descends through time in order) — do not flatten or scramble it. No chapter "
        "may sit off the arc.\n"
        "3. CHARACTERS: include EVERY main character — all POV characters and every major supporting "
        "character — as {name, role, archetype, off_axis_attribute, dramatic_question, description}. "
        "Do not omit a character who drives events; the cast must be complete enough to write the "
        "whole novel from this outline alone. Develop each main character along a visible arc.\n"
        "4. COVERAGE: the chapters must cover the COMPLETE arc end-to-end — every major plot event, "
        "character turning point, and historical/period event the premise implies — so a reader "
        "finishes with a full understanding of the people and the time period.\n\n"
        "Run the OUTLINE QUALITY GATE on yourself before returning; if it fails (wrong title, too few "
        "chapters, missing characters, an incoherent or scrambled arc, gaps in coverage), revise and "
        "only then return."
    )


def _fixture_outline(payload: dict) -> StoryOutline:
    return StoryOutline(
        title=str(payload.get("title") or "Untitled"),
        premise="(fixture) a craft-composed premise would appear here.",
        themes=[],
        story_arc_name=str(payload.get("story_arc") or ""),
        characters=[],
        chapters=[],
    )


async def _persist_outline_if_requested(payload: dict, outline_dict: dict) -> dict | None:
    """CR-001 (W2): when `persist` + project_id + user_id are supplied, save the outline to
    writing_projects_v2.outline (+ a prior-version snapshot). Best-effort — never breaks generation."""
    if not payload.get("persist"):
        return None
    project_id, user_id = payload.get("project_id"), payload.get("user_id")
    if not (project_id and user_id):
        return {"persisted": False, "reason": "persist requested but project_id/user_id missing"}
    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return {"persisted": False, "reason": "supabase not configured"}
    try:
        from writer_engine.persist_helpers import persist_outline
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        await persist_outline(client, project_id=str(project_id), user_id=str(user_id), outline=outline_dict)
        return {"persisted": True, "project_id": str(project_id)}
    except Exception as exc:
        return {"persisted": False, "error": str(exc)[:200]}


async def _op_story(payload: dict) -> dict:
    genre = str(payload.get("genre") or payload.get("genre_slug") or "")
    arc = str(payload.get("story_arc") or payload.get("story_arc_name") or "")
    title = str(payload.get("title") or "")
    requirements = str(payload.get("requirements") or payload.get("premise") or payload.get("title") or "")
    router = get_router(service=STEP_NAME)
    title_line = f'TITLE (use EXACTLY, do not rename): "{title}"\n\n' if title else ""
    try:
        outline, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_build_story_system(genre, arc, title),
            prompt=f"{title_line}PROJECT REQUIREMENTS:\n{requirements}\n\nGenerate the full outline.",
            schema=StoryOutline,
            # A 50-70 chapter Follett-scale outline needs >16k tokens; STREAM it so it neither
            # truncates mid-JSON nor trips the non-streaming 10-min guard.
            max_tokens=32768,
            stream=True,
        )
    except ProviderNotRegistered:
        outline = _fixture_outline(payload)
    outline_dict = outline.model_dump(mode="json")
    persisted = await _persist_outline_if_requested(payload, outline_dict)
    return {"outline": outline_dict, "persist": persisted}


async def _op_chapter(payload: dict) -> dict:
    return {"chapter_outline": {"chapter_number": payload.get("chapter_number", 1), "beats": []}}


def _roster_text(characters: list) -> str:
    out = []
    for c in characters:
        if isinstance(c, dict):
            out.append(f"- {c.get('name')}: {c.get('role', '')} {c.get('description', '')}".strip())
        else:
            out.append(f"- {c}")
    return "\n".join(out) or "(none)"


async def _op_edit_outline(payload: dict) -> dict:
    """Targeted outline edit under the locked-roster lock — NOT a full re-brainstorm."""
    outline = dict(payload.get("outline") or {})
    edits = list(payload.get("edits") or [])
    if not edits:
        return {"applied": 0, "outline": outline}
    store = get_prompt_store()
    lock = store.get("follett_seeds.character.locked_roster").format(
        locked_character_roster=_roster_text(outline.get("characters") or [])
    )
    system = compose_craft_system(seed_keys=[]) + "\n\n" + lock + (
        "\n\nApply ONLY the requested edits to the outline below. Preserve every existing character "
        "and chapter not named in the edits. Return strict JSON matching StoryOutline."
    )
    router = get_router(service=STEP_NAME)
    try:
        edited, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=system,
            prompt=f"OUTLINE:\n{outline}\n\nEDITS TO APPLY:\n" + "\n".join(f"- {e}" for e in edits),
            schema=StoryOutline,
            max_tokens=32768,
            stream=True,
        )
        return {"applied": len(edits), "outline": edited.model_dump(mode="json")}
    except ProviderNotRegistered:
        return {"applied": len(edits), "outline": outline}


def _build_revise_system(title: str) -> str:
    """Pure: system for a DIRECTIVE-driven outline revision — bigger than edit-outline.

    edit-outline applies a fixed list of small edits and locks the roster against ANY change.
    revise-outline takes a free-text creative directive (a brainstorm idea from the author) and may
    substantially restructure — add chapters, add NEW characters, add/interleave whole storylines —
    while preserving the title, the core premise, and every EXISTING character.
    """
    title_lock = (
        f'TITLE LOCK — the work is titled "{title}". Keep this EXACT title.\n\n' if title else ""
    )
    return compose_craft_system(seed_keys=_STORY_SEEDS) + (
        "\n\n" + title_lock +
        "You are REVISING an existing novel outline to implement a creative DIRECTIVE from the author. "
        "Produce the COMPLETE revised outline as strict JSON matching StoryOutline (title, premise, "
        "themes, story_arc_name, dramatic_question, wow_factor, characters, chapters).\n\n"
        "PRESERVE: the title; the core premise and its spine; and every EXISTING character — keep their "
        "names, roles, and arcs. You may DEEPEN an existing character, never silently drop or rename one.\n"
        "APPLY THE DIRECTIVE IN FULL: you MAY add new chapters, add new POV characters, add and "
        "interleave whole new storylines, and re-order chapters — exactly as the directive asks. If the "
        "directive calls for an interwoven second timeline (e.g. the real past lives behind the "
        "artifacts), write those as FULL dramatized chapters, each with its own POV character who is as "
        "real, named, and developed as the present-day protagonist — never a summary, a vision, or a "
        "flashback fragment. Give each such character an entry in `characters`.\n"
        "STRUCTURE: keep ONE coherent arc; tag every chapter's `act` and `arc_point`; when two timelines "
        "interleave, make the interleaving deliberate (and note in each chapter's `act` which timeline/"
        "era it belongs to). Renumber chapters consecutively (Prologue = 0, Epilogue = last). Each "
        "chapter entry stays COMPACT: {chapter_number, title, act, arc_point, pov_character, "
        "bridge_from_prior, beat} where `beat` is ONE sentence (the dramatic movement only) — do NOT "
        "write the chapter's prose, dialogue, or multi-sentence summaries in the outline; that bloats "
        "the JSON and truncates it. The whole outline must fit as compact JSON.\n"
        "COVERAGE: the revised chapters must cover the whole story end to end with no gaps.\n"
        "STORY ARC — the revision MUST update `story_arc_name`, `premise`, and `dramatic_question` to "
        "reflect the new direction (do not leave them describing the old version).\n"
        "Run the OUTLINE QUALITY GATE on yourself before returning; revise until it passes."
    )


async def _op_revise_outline(payload: dict) -> dict:
    """Directive-driven outline revision: apply a brainstorm idea to an existing outline.

    Payload: {outline, directive (free text), title?}. Returns the complete revised outline.
    """
    outline = dict(payload.get("outline") or {})
    directive = str(
        payload.get("directive") or payload.get("idea") or payload.get("requirements") or ""
    ).strip()
    title = str(payload.get("title") or outline.get("title") or "")
    if not directive:
        return {"revised": False, "outline": outline}
    if not outline:
        return {"revised": False, "outline": outline, "error": "no outline to revise"}
    router = get_router(service=STEP_NAME)
    try:
        revised, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_build_revise_system(title),
            prompt=(
                f"CURRENT OUTLINE (JSON):\n{json.dumps(outline, ensure_ascii=False)}\n\n"
                f"REVISION DIRECTIVE (the author's brainstorm idea — apply it fully):\n{directive}\n\n"
                "Return the COMPLETE revised outline as strict JSON."
            ),
            schema=StoryOutline,
            # A revised outline can carry two interleaved 100+-chapter timelines and EXPAND on the
            # input (e.g. dramatized told-stories), so it overran 32768 and truncated mid-JSON. Give
            # it the model's full 64k output budget, streamed.
            max_tokens=64000,
            stream=True,
        )
        before = len(outline.get("chapters") or [])
        after = len(revised.chapters)
        revised_dict = revised.model_dump(mode="json")
        persisted = await _persist_outline_if_requested(payload, revised_dict)
        return {
            "revised": True,
            "outline": revised_dict,
            "chapters_before": before,
            "chapters_after": after,
            "characters_after": len(revised.characters),
            "persist": persisted,
        }
    except ProviderNotRegistered:
        return {"revised": False, "outline": outline}


async def _op_create_project(payload: dict) -> dict:
    """CR-001 (W1): create a new writing_projects_v2 row; returns its id for the rest of the run."""
    user_id = str(payload.get("user_id") or "")
    title = str(payload.get("title") or "Untitled")
    genre = str(payload.get("genre_slug") or payload.get("genre") or "")
    if not user_id:
        return {"created": False, "reason": "user_id required"}
    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return {"created": False, "reason": "supabase not configured"}
    try:
        from writer_engine.persist_helpers import create_project
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        pid = await create_project(client, user_id=user_id, title=title, genre_slug=genre)
        return {"created": bool(pid), "project_id": pid, "title": title}
    except Exception as exc:
        return {"created": False, "error": str(exc)[:200]}


OPS = {
    "story": _op_story,
    "chapter": _op_chapter,
    "edit-outline": _op_edit_outline,
    "revise-outline": _op_revise_outline,
    "create-project": _op_create_project,
}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "story")
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
