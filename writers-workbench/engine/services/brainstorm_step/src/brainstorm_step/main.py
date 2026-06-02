"""brainstorm-step — story / chapter / edit-outline, on the Follett plot+character craft layer.

``story`` composes genre + story arc + the plot/character seeds (dramatic question, outline gate,
weaving, anti-soggy-middle, heightened ending, wow factor, broad-strokes-then-twist, moral
complication, no-milk-and-water) and self-validates via the outline_gate. ``edit-outline`` applies
targeted edits under the 3-layer locked-roster lock so a revision never invents/loses characters.
Fixture fallback when no provider is registered.
"""

from __future__ import annotations

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


def _build_story_system(genre: str, arc: str) -> str:
    """Pure: outline system = prime directive + genre + arc + plot/character seeds + outline gate."""
    return compose_craft_system(
        seed_keys=_STORY_SEEDS, genre_block=_genre_block(genre), arc_block=_arc_block(arc)
    ) + (
        "\n\nProduce the novel outline as strict JSON matching StoryOutline (title, premise, themes, "
        "story_arc_name, dramatic_question, wow_factor, characters, chapters). Run the OUTLINE "
        "QUALITY GATE on yourself before returning; if it fails, revise and only then return."
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


async def _op_story(payload: dict) -> dict:
    genre = str(payload.get("genre") or payload.get("genre_slug") or "")
    arc = str(payload.get("story_arc") or payload.get("story_arc_name") or "")
    requirements = str(payload.get("requirements") or payload.get("premise") or payload.get("title") or "")
    router = get_router(service=STEP_NAME)
    try:
        outline, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_build_story_system(genre, arc),
            prompt=f"PROJECT REQUIREMENTS:\n{requirements}\n\nGenerate the full outline.",
            schema=StoryOutline,
            # A full novel outline (50-100 scene beats + characters) overruns 8192 and truncates the
            # JSON mid-string; give Sonnet generous headroom.
            max_tokens=16384,
        )
    except ProviderNotRegistered:
        outline = _fixture_outline(payload)
    return {"outline": outline.model_dump(mode="json")}


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
            # A full novel outline (50-100 scene beats + characters) overruns 8192 and truncates the
            # JSON mid-string; give Sonnet generous headroom.
            max_tokens=16384,
        )
        return {"applied": len(edits), "outline": edited.model_dump(mode="json")}
    except ProviderNotRegistered:
        return {"applied": len(edits), "outline": outline}


OPS = {"story": _op_story, "chapter": _op_chapter, "edit-outline": _op_edit_outline}


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
