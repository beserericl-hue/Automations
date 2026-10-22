"""chapter-step — write / qa / scan-drift / evaluate-genre / extract-bible / blog / short-story.

Operations dispatch via ``payload["op"]``. The ``write`` and ``qa`` ops compose the Follett
writing-craft layer (``follett_seeds.*``) on top of genre + story arc; the remaining ops are F1-2
follow-ups. Real-LLM calls fall back to deterministic fixtures when no provider is registered, so
the service boots and tests run without live keys.
"""

from __future__ import annotations

import asyncio
import re
import unicodedata
from typing import Any, NamedTuple
from uuid import uuid4

from writer_engine import outline_keys
from writer_engine.humanize import humanize_draft
from writer_engine.library_helpers import optional_int
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
    VolumeEndingJudgement,
    WriteChapterRequest,
    WriteChapterResponse,
)
from writer_engine.step_service import build_step_app
from writer_engine.telemetry.logging import get_logger

STEP_NAME = "chapter"
logger = get_logger(STEP_NAME)
seed_default_prompts()


class ModelPlan(NamedTuple):
    """Which model writes, and which model fixes (B9).

    ``draft`` carries almost all of the output tokens — a chapter is 5 sub-chapters of 2-3k words —
    while ``polish`` runs the short, quality-critical passes: the sub-chapter plan, the drift
    correction, the craft revision. Splitting them is the only TPM lever available without changing
    accounts, because Anthropic's output-token limits are **per model family**: Haiku's budget is not
    Sonnet's. The Burial Mound run was bounded at ~5 chapters/min by Sonnet's 90k output TPM alone,
    with Haiku's entire budget sitting unused next to it.
    """

    draft: str
    polish: str


def model_plan(strategy: str, settings: Any) -> ModelPlan:
    """Resolve an ``llm_strategy`` to a (draft, polish) pair.

    ``hybrid-draft-polish`` was in the public schema and in the inventory as B9's named lever, and
    was **never implemented**: the resolver was a two-entry dict for haiku/sonnet, so every hybrid
    request fell through to Sonnet-for-everything and the lever silently did nothing. Found
    2026-10-18.

    ``CHAPTER_LLM_STRATEGY`` sets what ``tier-default`` means, so turning the lever on account-wide
    is an env change rather than a deploy.
    """
    wanted = (strategy or "").strip() or "tier-default"
    if wanted == "tier-default":
        wanted = (getattr(settings, "chapter_llm_strategy", "") or "sonnet").strip()
    cheap, strong = settings.model_cheap, settings.model_default
    plans = {
        "sonnet": ModelPlan(strong, strong),
        "haiku": ModelPlan(cheap, cheap),
        # Draft cheap, fix well. Both hybrid names resolve here: `hybrid-smart` was equally
        # unimplemented and plainly meant the same split.
        "hybrid-draft-polish": ModelPlan(cheap, strong),
        "hybrid-smart": ModelPlan(cheap, strong),
    }
    plan = plans.get(wanted)
    if plan is None:
        # Previously silent. An unknown strategy that quietly means "Sonnet" is how a cost lever
        # gets reported as enabled while nothing changed.
        logger.warning("chapter.unknown_llm_strategy", strategy=wanted, using="sonnet")
        return ModelPlan(strong, strong)
    return plan


def _polish_model(payload: dict[str, Any], settings: Any) -> str:
    """The model for a corrective or planning op (plan, revise, repair, expand, line-edit).

    All of these are short-output, quality-critical passes, so they take the plan's `polish` slot —
    which for every non-hybrid strategy is the same model these ops already used. Routed through
    `model_plan` rather than a local dict so a hybrid strategy cannot silently mean "Sonnet for
    everything" here while it means something else in the write path.
    """
    return model_plan(str(payload.get("llm_strategy") or ""), settings).polish


def _coerce_int(value: Any, default: int) -> int:
    """Tolerant int() for router-supplied params like ``"1500 words"`` / ``"2,500"`` / ``"ch 3"``.

    G6: the Gemini router extracts a length/count verbatim from the message ("1500 words"), so a bare
    ``int(value)`` raised ValueError and errored the whole write with nothing produced. Pull the first
    run of digits; fall back to ``default`` when there is none."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    m = re.search(r"-?\d[\d,]*", str(value or ""))
    return int(m.group(0).replace(",", "")) if m else default


def _coerce_chapter_number(value: Any, default: int = 1) -> int:
    """Map a chapter reference to the stored integer: Prologue → 0, Epilogue → 999 (the n8n / story-bible
    convention), otherwise the first integer in the value. G19: ``int("Prologue")`` crashed chapter.plan."""
    s = str(value if value is not None else "").strip().lower()
    if "prologue" in s:
        return 0
    if "epilogue" in s:
        return 999
    return _coerce_int(value, default)


async def _resolve_project_for_payload(payload: dict, *, create: bool) -> dict | None:
    """G9: resolve (or create) ``project_id`` from ``project_title`` in place on the payload so the
    chapter ops work from chat/voice, where only a title is ever supplied. Returns the resolved project
    row (with its outline/genre) when a match/creation happened, else None. No-op without Supabase."""
    from writer_engine.config import get_settings

    if payload.get("project_id") or not payload.get("project_title"):
        return None
    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return None
    from writer_engine.persist_helpers import resolve_or_create_project
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    pid, row = await resolve_or_create_project(
        client,
        user_id=str(payload.get("user_id") or ""),
        title=str(payload["project_title"]),
        genre_slug=str(payload.get("genre_slug") or payload.get("genre") or ""),
        create=create,
    )
    if pid:
        payload["project_id"] = pid
        logger.info(
            "chapter.project_resolved",
            project_id=pid,
            title=str(payload["project_title"])[:80],
            created=row is None,
        )
    return row


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
    return (
        f"GENRE: {genre_slug}. Honour this genre's conventions, themes, and reader expectations."
        if genre_slug
        else ""
    )


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
        # Via writer_engine.outline_keys, because the data holds TWO outline shapes and this used to
        # read only `chapter_number`. For the ten n8n-shaped projects (which key on `number`) focal
        # stayed None, so the prompt contained no THIS CHAPTER block at all — no beat, no brief, no
        # bridge from the prior chapter — and every index line rendered as "None. Title".
        num = outline_keys.chapter_number(ch)
        if outline_keys.matches(ch, chapter_number):
            focal = ch
        index.append(
            f"  {num if num is not None else '?'}. {ch.get('title', '')}"
            f"{' [' + str(ch.get('act')) + ']' if ch.get('act') else ''}"
            f"{' (POV ' + str(ch.get('pov_character')) + ')' if ch.get('pov_character') else ''}"
        )
    if focal is not None:
        lines.append("\nTHIS CHAPTER (write this one):")
        lines.append(f"  chapter_number: {outline_keys.chapter_number(focal)}")
        if focal.get("title"):
            lines.append(f"  title: {focal['title']}")
        for k in outline_keys.CONTEXT_KEYS:
            if focal.get(k):
                lines.append(f"  {k}: {focal[k]}")
        body = outline_keys.chapter_body(focal)
        if body:
            lines.append(f"  beat: {body}")
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


def _plan_system(
    genre_slug: str,
    outline: dict[str, Any],
    *,
    book_arc_block: str = "",
    chapter_arc_block: str = "",
) -> str:
    """System prompt for splitting a chapter into sub-chapter beats (E2E-4 dual-arc).

    ``book_arc_block`` is the whole-novel arc (e.g. Hero's Journey) and ``chapter_arc_block`` is an
    optional CHAPTER-level arc that overrides it for this chapter only (e.g. Kishōtenketsu). Each
    sub-chapter's ``arc_beat`` uses the chapter arc (or the book arc when none); ``connects_to_book_arc``
    always ties back to the book arc so a non-conflict chapter arc never overwrites the book structure."""
    arc_section = ""
    if book_arc_block:
        arc_section += f"\n\nBOOK-LEVEL STORY ARC (the whole novel follows this):\n{book_arc_block}"
    if chapter_arc_block:
        arc_section += (
            "\n\nCHAPTER-LEVEL STORY ARC for THIS chapter — use these beats for each sub-chapter's "
            "arc_beat. It MAY differ from the book arc (e.g. a quiet Kishōtenketsu chapter inside a "
            f"Hero's Journey novel); do NOT mix the two:\n{chapter_arc_block}"
        )
    return (
        compose_craft_system(
            seed_keys=[
                "follett_seeds.scene.event_list",
                "follett_seeds.scene.escalating_turn",
                "follett_seeds.scene.bme_check",
            ],
            genre_block=_genre_block(genre_slug),
            arc_block=_arc_block(outline),
        )
        + arc_section
        + (
            "\n\nReturn strict JSON matching SubChapterPlan: 3-7 sub-chapters. Each sub-chapter MUST carry: "
            "number (1-based), title, brief (a concrete beat — a discrete movement, NOT a summary), "
            "story_turn, arc_beat (the CHAPTER-level arc stage it fulfils — use the chapter arc above if "
            "given, else the book arc), characters (the people on the page in this sub-chapter; prefer "
            "names from the CHARACTER ROSTER and never contradict it, but a chapter set outside the "
            "roster's era may name its own cast), pov_character (which ONE of them the section is seen "
            "through — the roster's protagonist unless the chapter clearly belongs to someone else), "
            "setting, emotional_tone, and connects_to_book_arc (how it advances the BOOK-level arc "
            "stage for this chapter).\n"
            "story_turn is the one that gets skipped, so be exact about it: name in one sentence what is "
            "DIFFERENT at the end of this sub-chapter than at its start. A discovery made, a decision taken "
            "and acted on, a lie told, a relationship shifted, a threat arriving, something lost, a plan "
            "broken. 'She reflects on her mother' is not a turn. 'She works the clay' is not a turn. If you "
            "cannot name the change, the sub-chapter has no reason to exist — merge it into its neighbour "
            "and plan one fewer.\n"
            "THE LAST SUB-CHAPTER NEEDS ONE TOO. A chapter that closes on aftermath, summary or reflection "
            "has no ending — give the final section a change of its own, even a small one, and let the "
            "reflection happen around it. Measured across a 96-chapter book: half the chapters came in under "
            "the pacing threshold, and the commonest finding was a final section of five or six pages in "
            "which nothing new arose.\n"
            "If the chapter arc is a non-conflict structure (Kishōtenketsu, Story Circle), do NOT force "
            "combat/confrontation beats — a turn there can be quiet (a realisation that forces an action, an "
            "arrival, a refusal) but it must still be a change."
        )
    )


def _adjacent_chapter_context(outline: dict[str, Any], chapter_number: int) -> str:
    """Prev/next chapter briefs (E2E-4 R112): so a chapter outline acknowledges what came before and
    sets up the hook into what follows, without drifting from the book outline."""
    chapters = (outline or {}).get("chapters") or []

    def _find(target: Any) -> dict | None:
        for ch in chapters:
            if isinstance(ch, dict) and str(ch.get("chapter_number")) == str(target):
                return ch
        return None

    lines: list[str] = []
    # optional_int drops absent/non-numeric entries, so `ordered` is a clean list[int] and the
    # try/except that previously covered int()/sorted() on None is unnecessary (H8).
    nums = [optional_int(c.get("chapter_number")) for c in chapters if isinstance(c, dict)]
    ordered = sorted(n for n in nums if n is not None)
    this_n = optional_int(chapter_number)
    idx = ordered.index(this_n) if this_n is not None and this_n in ordered else -1
    prev_n = ordered[idx - 1] if idx > 0 else None
    next_n = ordered[idx + 1] if 0 <= idx < len(ordered) - 1 else None
    prev = _find(prev_n) if prev_n is not None else None
    nxt = _find(next_n) if next_n is not None else None
    if prev:
        lines.append(
            f"PREVIOUS CHAPTER ({prev.get('chapter_number')} — {prev.get('title', '')}): "
            f"{prev.get('beat', prev.get('summary', ''))} — acknowledge where this left off."
        )
    if nxt:
        lines.append(
            f"NEXT CHAPTER ({nxt.get('chapter_number')} — {nxt.get('title', '')}): "
            f"{nxt.get('beat', nxt.get('summary', ''))} — end on a hook that sets this up."
        )
    return "\n".join(lines)


async def _plan_subchapters(
    ctx: dict[str, Any],
    req: WriteChapterRequest,
    n: int,
    model: str,
    *,
    book_arc_block: str = "",
    chapter_arc_block: str = "",
    adjacent: str = "",
) -> list[SubChapterBrief]:
    """Plan up to n sub-chapters for the chapter (E2E-4: dual-arc + prev/next). Fixture on no provider."""
    router = get_router(service=STEP_NAME)
    adj = f"\n\nADJACENT CHAPTER CONTEXT:\n{adjacent}" if adjacent else ""
    try:
        plan, _ = await complete_structured(
            router,
            provider="anthropic",
            model=model,
            system=_plan_system(
                ctx["genre_slug"],
                ctx["outline"],
                book_arc_block=book_arc_block,
                chapter_arc_block=chapter_arc_block,
            ),
            prompt=(
                f"{_chapter_header(ctx, ctx['roster'], req)}{adj}\n\n"
                f"Split chapter {req.chapter_number} into {n} sub-chapters."
            ),
            schema=SubChapterPlan,
            max_tokens=4096,
        )
        briefs = plan.subchapters[:n]
        return briefs or [
            SubChapterBrief(beat=f"Part {i + 1} of chapter {req.chapter_number}") for i in range(n)
        ]
    except ProviderNotRegistered:
        return [SubChapterBrief(beat=f"Part {i + 1}") for i in range(n)]


async def _persist_chapter_outline(
    project_id: str,
    chapter_number: int,
    sub_chapters: list[dict],
    chapter_story_arc: str,
    book_arc_name: str,
) -> dict | None:
    """Save the chapter outline into ``writing_projects_v2.outline.chapters[N].chapter_outline`` (E2E-4
    R111/R118). Snapshots the prior outline to outline_versions_v2 first when one exists, so a re-plan
    is reversible. Best-effort."""
    from writer_engine.config import get_settings
    from writer_engine.persist_helpers import touch

    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return None
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        cur = (
            await client.table("writing_projects_v2")
            .select("outline,user_id")
            .eq("id", project_id)
            .limit(1)
            .execute()
        )
        rows = getattr(cur, "data", None) or []
        if not rows:
            return {"persisted": False, "reason": "project not found"}
        outline = dict(rows[0].get("outline") or {})
        user_id = rows[0].get("user_id")
        chapters = list(outline.get("chapters") or [])
        # Snapshot the prior outline (R118: chapter-outline revision keeps history).
        try:
            v = (
                await client.table("outline_versions_v2")
                .select("version_number")
                .eq("project_id", project_id)
                .order("version_number", desc=True)
                .limit(1)
                .execute()
            )
            vn = int(((getattr(v, "data", None) or [{}])[0].get("version_number")) or 0) + 1
            await (
                client.table("outline_versions_v2")
                .insert(
                    {
                        "user_id": user_id,
                        "project_id": project_id,
                        "version_number": vn,
                        "outline": outline,
                        "revision_note": f"pre chapter-outline snapshot (ch {chapter_number})",
                    }
                )
                .execute()
            )
        except Exception as exc:
            logger.warning("plan.snapshot_failed", error=str(exc)[:160])
        found = False
        for ch in chapters:
            if isinstance(ch, dict) and str(ch.get("chapter_number")) == str(chapter_number):
                ch["chapter_outline"] = {
                    "sub_chapters": sub_chapters,
                    "chapter_story_arc": chapter_story_arc,
                    "book_arc_name": book_arc_name,
                }
                found = True
                break
        if not found:
            return {"persisted": False, "reason": f"chapter {chapter_number} not in outline"}
        outline["chapters"] = chapters
        await (
            client.table("writing_projects_v2")
            .update({"outline": outline, **touch()})
            .eq("id", project_id)
            .execute()
        )
        return {"persisted": True, "chapter_number": chapter_number}
    except Exception as exc:
        logger.warning("plan.persist_failed", error=str(exc)[:200])
        return {"persisted": False, "error": str(exc)[:200]}


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

    # G9/G19: resolve project_id from title (no create — planning an as-yet-unwritten book is fine
    # without a row) and accept Prologue/Epilogue as chapter references instead of crashing on int().
    await _resolve_project_for_payload(payload, create=False)
    project_id = payload.get("project_id") or "00000000-0000-0000-0000-000000000000"
    chapter_number = _coerce_chapter_number(payload.get("chapter_number"), 1)
    chapter_run_id = payload.get("chapter_run_id") or str(uuid4())
    req = WriteChapterRequest.model_validate(
        {
            "project_id": project_id,
            "chapter_number": chapter_number,
            "chapter_run_id": chapter_run_id,
            "sub_chapter_count_override": payload.get("sub_chapter_count_override"),
        }
    )
    ctx = await _load_context(str(req.project_id), payload)
    settings = get_settings()
    model = _polish_model(payload, settings)
    n_sub = max(3, min(int(req.sub_chapter_count_override or 5), 7))

    # Dual-arc (E2E-4): the book arc grounds connects_to_book_arc; an optional per-chapter arc override
    # (chapter_story_arc / "using <arc>") grounds each sub-chapter's arc_beat. Both definitions are
    # loaded from story_arcs_v2 so the model honours the real beats (Hero's Journey, Kishōtenketsu, …).
    from writer_engine.story_arcs import arc_prompt_block, load_story_arc

    outline = ctx.get("outline") or {}
    book_arc_name = str(outline.get("story_arc_name") or outline.get("story_arc") or "")
    chapter_arc_name = str(payload.get("chapter_story_arc") or payload.get("story_arc") or "")
    client = None
    if settings.supabase_url and settings.supabase_service_role_key:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
    book_arc_name, book_arc_text = await load_story_arc(client, book_arc_name)
    book_arc_block = arc_prompt_block("Book arc", book_arc_name, book_arc_text)
    chapter_arc_block = ""
    if chapter_arc_name and chapter_arc_name.strip().lower() != book_arc_name.strip().lower():
        chapter_arc_name, chapter_arc_text = await load_story_arc(client, chapter_arc_name)
        chapter_arc_block = arc_prompt_block("Chapter arc", chapter_arc_name, chapter_arc_text)
    else:
        chapter_arc_name = book_arc_name  # inherit the book arc when no override given

    adjacent = _adjacent_chapter_context(outline, chapter_number)
    briefs = await _plan_subchapters(
        ctx,
        req,
        n_sub,
        model,
        book_arc_block=book_arc_block,
        chapter_arc_block=chapter_arc_block,
        adjacent=adjacent,
    )
    for i, b in enumerate(briefs, start=1):
        if b.number is None:
            b.number = i
    sub_dicts = [b.model_dump(mode="json") for b in briefs]

    persist = None
    if payload.get("persist") and payload.get("project_id"):
        persist = await _persist_chapter_outline(
            str(payload["project_id"]), chapter_number, sub_dicts, chapter_arc_name, book_arc_name
        )

    return {
        "chapter_number": chapter_number,
        "chapter_story_arc": chapter_arc_name,
        "book_arc": book_arc_name,
        "sub_chapter_briefs": sub_dicts,
        "count": len(briefs),
        "persist": persist,
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
#
# The `--` branch is fenced with lookarounds so it cannot match INSIDE a longer hyphen run. Without
# them it matched the first two hyphens of the `---` scene separator and, because `\s*` sits outside
# the group, swallowed the surrounding newlines too — turning every sub-chapter seam into the
# literal text ", -" in the middle of the prose:
#
#     "…walked through the gate.\n\n---\n\nThe receiver swept…"
#     "…walked through the gate., -  The receiver swept…"
#
# So A13's structural scene breaks (SCENE_BREAK.join, below) were deleted by this function on the
# very next line, and replaced with visible punctuation garbage. Measured on a live chapter 6 write:
# 5 sub-chapters, 0 scene breaks, 5 instances of ", -". A13 recorded the drift-correct pass as the
# residual risk to confirm on the next live run; the actual culprit fires on EVERY chapter,
# regardless of drift (that run had craft_passes=0 and zero drift).
_EM_DASH_RE = re.compile(f"\\s*(?:{_EM}|{_EN}|(?<!-)--(?!-))\\s*")


def _strip_em_dashes(text: str) -> str:
    """Last-resort guarantee that no em-dash / en-dash-as-dash / double-hyphen survives (the LLM
    line-edit does the real rewriting; this catches stragglers). Replaces the dash with a comma +
    space, which keeps the sentence grammatical without re-introducing the banned character.

    A run of three or more hyphens is left alone: it is a separator, not a dash. See the regex above.
    """
    return _EM_DASH_RE.sub(", ", text)


# Separator inserted between merged sub-chapters. Found by the L5 parity harness (H3): sub-chapters
# were joined with a bare blank line, so all 96 chapters of the Burial Mound run contained ZERO
# internal scene breaks while the n8n baseline's carried 1-13. The craft layer asks for scene
# construction and a story turn every 4-6 pages (follett_seeds.scene.bme_check, scene.turn_density),
# and the short-story op already instructs "use --- between scenes" — chapters just never did it.
# Done structurally rather than by prompt instruction: N sub-chapters deterministically yield N-1
# breaks, where an instruction is advisory and silently drops.
SCENE_BREAK = "\n\n---\n\n"


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


_canon_refreshed: set[str] = set()
"""Projects already checked for canon staleness in this process. The probe is two cheap queries,
but a 96-chapter write fans out across many sub-chapters and there is no reason to ask per-beat."""


async def _refresh_stale_canon(ctx: dict[str, Any], *, user_id: str) -> None:
    """Reindex this project's canon before retrieving from it, if the outline has moved on.

    `index_project_canon` only ever ran from a brainstorm outline save, so any other write — an
    admin fix, a migration, a direct edit, a research study attached to the outline — left the
    vectors describing a plan that no longer existed. Retrieval then grounded the prose in a
    superseded outline and nothing anywhere said so.

    Checked once per project per process, and entirely best-effort: a chapter write must not fail
    because a freshness probe did.
    """
    project_id = str(ctx.get("project_id") or "")
    if not project_id or project_id in _canon_refreshed:
        return
    _canon_refreshed.add(project_id)
    try:
        from writer_engine.embeddings import reindex_if_stale

        state = await reindex_if_stale(user_id=str(user_id), project_id=project_id)
        if state.get("reindexed"):
            logger.info(
                "chapter.canon_reindexed",
                project_id=project_id,
                chunks=state.get("chunks"),
                reason=state.get("reason"),
            )
    except Exception as exc:
        logger.warning("chapter.canon_refresh_failed", error=f"{type(exc).__name__}: {exc}"[:160])


async def _canon_grounding(ctx: dict[str, Any], beat: str, *, user_id: str | None) -> str:
    """Retrieve this project's own canon from the vector store to ground the chapter (A3).

    The quality gap CR-010 A2 recorded: n8n re-embedded project data and grounded every sub-chapter
    via vector search, while the engine wrote prose from the outline header alone. This restores the
    retrieval half — the chapter's beat is the query, so the model is handed the specific
    characters / prior sub-chapters / bible entries that beat touches, not just the roster summary.

    Best-effort by construction: returns "" when embeddings are disabled, when the match function is
    absent, or on any failure, so a chapter write never fails for want of grounding.
    """
    if not beat or not user_id:
        return ""
    try:
        from writer_engine.embeddings import embeddings_enabled, match_project_canon

        if not embeddings_enabled():
            return ""
        await _refresh_stale_canon(ctx, user_id=user_id)
        rows = await match_project_canon(
            query=beat,
            user_id=str(user_id),
            project_id=str(ctx.get("project_id") or "") or None,
            match_count=8,
            match_threshold=0.35,
        )
    except Exception as exc:
        logger.warning("chapter.canon_retrieval_failed", error=str(exc)[:160])
        return ""
    if not rows:
        return ""
    lines: list[str] = []
    for r in rows:
        title = str(r.get("doc_title") or r.get("doc_id") or "").strip()
        body = " ".join(str(r.get("content") or "").split())[:600]
        if body:
            lines.append(f"- [{r.get('doc_type')}] {title}: {body}")
    return "\n".join(lines)


def _cached_write_system(base_system: str, header: str, grounding: str, canon: str = "") -> str:
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
    if canon:
        # A3: retrieved from this project's own vector store, so it is established canon rather than
        # research. Contradicting it is drift, which is why the instruction is stricter than for
        # research grounding. Lives in the CACHED block: one retrieval serves every sub-chapter.
        parts.append(
            "PROJECT CANON (already established in this book — stay consistent with it; do NOT "
            "contradict or re-introduce these as new):\n" + canon
        )
    return "\n\n".join(parts)


PRIOR_CHAPTER_TAIL_WORDS = 800
"""How much of the previous chapter's ending to hand the next chapter's opening.

The same 800 words already used BETWEEN sub-chapters. The number is not arbitrary: it is long enough
to carry where everyone is standing, who last spoke and in what weather, and short enough that it
never crowds the beat it is meant to serve.
"""


async def _prior_chapter_tail(project_id: str, chapter_number: int) -> str:
    """The closing words of the preceding chapter, or "" when there is none (I3).

    `prior_tail` chains sub-chapters inside one chapter and started EMPTY for sub-chapter 1, so a
    chapter's opening never saw how the previous chapter actually ended — only what
    `bridge_from_prior` said it would. On a detailed 96-chapter outline that held; on a thin one, or
    wherever the previous chapter drifted from its plan, the seam shows.

    Returns "" silently when the previous chapter is not written yet, which is the normal case in a
    concurrent batch: 8 chapters are in flight at once and chapter N may well start before N-1
    finishes. The outline's bridge then carries the connection exactly as it did before, so this can
    only add continuity, never withhold it.
    """
    if chapter_number <= 0:
        return ""
    try:
        text = await _load_persisted_chapter(project_id, chapter_number - 1)
    except Exception as exc:
        logger.warning("chapter.prior_tail_failed", chapter=chapter_number, error=str(exc)[:160])
        return ""
    if not text.strip():
        return ""
    return " ".join(text.split()[-PRIOR_CHAPTER_TAIL_WORDS:])


async def _write_subchapter(
    *,
    system: str,
    brief: SubChapterBrief,
    idx: int,
    total: int,
    prior_tail: str,
    chapter_number: int,
    model: str,
    plan_context: str = "",
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
    # The plan names the change this section must deliver; passing it on is the point. Without it the
    # writer is told only what the section is ABOUT, which is how a section becomes five pages in
    # which nothing happens — the commonest pacing finding across the 96-chapter run.
    turn_line = (
        f"THIS SECTION MUST END WITH A CHANGE: {brief.story_turn.strip()}\n"
        "Do not close it on reflection or summary — the change has to occur on the page.\n"
        if brief.story_turn.strip()
        else ""
    )
    # The plan names who is in the section and whose eyes it is seen through. Neither reached the
    # writer before: `characters` was asked for and then never read, and `pov_character` was read but
    # never asked for, so the POV clause below could not fire on a real chapter. The beat names its
    # people in passing, which is weaker — a cast line is what stops a walk-on becoming a viewpoint.
    cast_line = (
        f"ON THE PAGE: {', '.join(c.strip() for c in brief.characters if str(c).strip())}\n"
        if brief.characters
        else ""
    )
    user = (
        f"You are writing SUB-CHAPTER {idx + 1} of {total} of chapter {chapter_number}.\n"
        f"This sub-chapter's beat: {brief.title} — {brief.beat}"
        f"{(' (POV: ' + brief.pov_character + ')') if brief.pov_character else ''}\n"
        f"{cast_line}"
        f"{turn_line}"
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
    return (
        " ".join(str(x) for x in (o.get("story_arc_name"), o.get("dramatic_question"), o.get("premise")) if x)
        or "(arc not specified — infer from premise)"
    )


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
        "  AN OUTLINE BEAT IS A PLAN, NOT A SHOT LIST. The same additive rule as for characters "
        "applies here: material the beat simply does not enumerate — an added exchange, a scene that "
        "sets up something later, a researched prop, a specific place or object name — is normal "
        "craft, and the craft guides above actively ASK for it. Flag it ONLY when it contradicts the "
        "beat, drops something the beat requires, breaks continuity, or pulls the chapter off the "
        "arc. Measured on a 96-chapter run: 16 of 85 drift findings were of the form 'the outline "
        "beat does not include X' where X was consistent with the beat — including a chapter being "
        "flagged for naming the thread a quilter uses, which is precisely the period detail the "
        "research seeds call for. Each one of those triggered a full chapter rewrite for nothing.\n"
        "  If you find yourself writing that your own finding is 'consistent', 'acceptable', "
        "'appropriate to the scene' or 'normal', then it is not a finding: leave it out. Do not use "
        "these arrays as a notes field.\n"
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


# --- A7: drop the drift findings that are not findings -----------------------------------------
#
# Measured across the Burial Mound run (300 telemetry rows, 325 character_drift findings): the
# detector files three kinds of non-finding, and each one costs real money, because `aligned` is
# False whenever either list is non-empty and that triggers the QA-cycle-2 streamed revision of the
# whole chapter — the same pass the vault flagged as a scene-break risk.
#
#   1. SELF-CANCELLING. The model puts an item in the list and then says there is no problem:
#      "Roster notes Marcus 'drinks too much coffee'; the chapter is consistent with this, no issue
#      — flagging only to confirm no drift here." / "No character has been renamed, regendered, or
#      given a contradictory trait." It is using the array as a notes field.
#   2. DICT-SHAPED. The schema says list[str], and the model sometimes returns
#      {'character': 'Waya', 'inconsistency': '…'}, which reaches the UI and the bible as a Python
#      dict repr.
#   3. Empty / whitespace entries.
#
# Deliberately NOT filtered: anything that reads as a real contradiction. The run contains findings
# worth keeping — a chapter dating a panel to 1963 "when she was nineteen" against a roster age of
# 82 in 2024, and an attorney the outline names Lester Pruitt appearing as Hendricks — and a
# phrase-based filter must not reach those.
#
# And NOT extended to the hedging phrase "is consistent with", which was the obvious next pattern.
# Re-measured 2026-10-19 against the stored reports: five surviving findings contain it, and one of
# them is this —
#
#   "Roster gives Matta's era as '1740s' and his age as '50s'; the chapter is set in 1738 and
#    presents him as a man who has worn English shoes for eleven years..."
#
# — a genuine period contradiction, and one of the best findings in the set. The remaining
# over-flagging is a JUDGEMENT problem, not a phrasing problem, so it is addressed in the drift
# prompt (an outline beat is a plan, not a shot list) rather than here. A regex that reached the
# Matta finding would trade a cheap false positive for an expensive false negative.

_NON_FINDING_RE = re.compile(
    r"\b(?:"
    r"no drift"
    r"|no issue"
    r"|not drift"
    r"|no inconsistenc(?:y|ies)"
    r"|no character has been"
    r"|fully consistent"
    r"|is consistent with this"
    r"|flagging only to confirm"
    r"|correctly identifies"
    r"|consistent with (?:her|his|their|its) roster"
    r")\b",
    re.IGNORECASE,
)


def _finding_text(item: Any) -> str:
    """Normalise one finding to a string, flattening the dict shape the model sometimes returns."""
    if isinstance(item, dict):
        who = str(item.get("character") or item.get("name") or "").strip()
        what = str(
            item.get("inconsistency") or item.get("detail") or item.get("issue") or item.get("drift") or ""
        ).strip()
        if who and what:
            return f"{who}: {what}"
        return what or who
    return str(item or "").strip()


def _clean_findings(items: Any) -> list[str]:
    out: list[str] = []
    for item in items or []:
        text = _finding_text(item)
        if not text:
            continue
        if _NON_FINDING_RE.search(text):
            logger.info("drift.non_finding_dropped", finding=text[:120])
            continue
        out.append(text)
    return out


def clean_drift(drift: DriftReport | None) -> DriftReport | None:
    """Strip non-findings and recompute ``aligned`` from what is actually left.

    Recomputing matters more than the tidying: a chapter whose only "drift" was the model confirming
    there is no drift would otherwise be rewritten end to end for nothing.
    """
    if drift is None:
        return None
    story = _clean_findings(drift.story_drift)
    character = _clean_findings(drift.character_drift)
    dropped = (len(drift.story_drift) - len(story)) + (len(drift.character_drift) - len(character))
    aligned = not story and not character
    if dropped or aligned != drift.aligned:
        logger.info(
            "drift.cleaned",
            dropped=dropped,
            story=len(story),
            character=len(character),
            aligned_before=drift.aligned,
            aligned_after=aligned,
        )
    return drift.model_copy(
        update={
            "story_drift": story,
            "character_drift": character,
            "research_gaps": _clean_findings(drift.research_gaps),
            "aligned": aligned,
        }
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
                router,
                provider="anthropic",
                model=model,
                system=_build_drift_system(),
                prompt=prompt,
                schema=DriftReport,
                max_tokens=16384,
            )
            return clean_drift(drift)
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
        m = re.match(r"^[-*•]\s*\*{0,2}([^:*]{4,80})\*{0,2}\s*[:—-]", ln) or re.match(
            r"^\*{2}([^*:]{4,80})\*{2}", ln
        )
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


_MIN_STORED_FACTS = 2
"""At or above this, the stored study stands alone. Below it the study is kept AND topped up with a
live pass, rather than discarded — measured on The Ossuary, where **52 of 96** chapters carry exactly
one fact (149 facts over 96 chapters is an average of 1.55, not a thick study per chapter). Throwing
that fact away to make a Perplexity call would lose the only cited, reviewed material those chapters
have."""


def _stored_research(outline: dict[str, Any], chapter_number: int) -> tuple[str, list[str], int]:
    """The chapter's OWN stored research study as a grounding block, plus its fact count.

    ``("", [], 0)`` when the chapter carries no usable research. The count is what the caller uses to
    decide whether the study is sufficient on its own.

    A chapter-by-chapter study attached to the outline is better grounding than a live Perplexity
    pass: it is broader (university papers, historical societies, archaeological site reports), it
    was reviewed, it carries its sources, and it is the same text the Workbench shows the author. It
    is also addressed by chapter number rather than retrieved by similarity — a vector search over a
    96-chapter project is not guaranteed to return THIS chapter's facts, and on The Ossuary it
    returned chapters 26, 31, 47 and 61 for one query. Where a study exists, it IS the factual basis;
    Perplexity stays as the fallback for chapters that have none.
    """
    chapters = (outline or {}).get("chapters") or []
    entry: dict[str, Any] | None = None
    for ch in chapters:
        if isinstance(ch, dict) and str(ch.get("chapter_number")) == str(chapter_number):
            entry = ch
            break
    if entry is None and 0 <= chapter_number < len(chapters) and isinstance(chapters[chapter_number], dict):
        entry = chapters[chapter_number]
    research = (entry or {}).get("research")
    if not isinstance(research, dict):
        return "", [], 0

    facts = [f for f in (research.get("facts") or []) if isinstance(f, dict) and f.get("fact")]
    colour = [str(c).strip() for c in (research.get("local_color") or []) if str(c).strip()]
    flags = [str(f).strip() for f in (research.get("flags") or []) if str(f).strip()]
    if not facts:
        return "", [], 0

    lines: list[str] = []
    period = str(research.get("period") or "").strip()
    if period:
        lines.append(f"PERIOD: {period}")
    sources: list[str] = []
    for fact in facts:
        text = str(fact.get("fact")).strip()
        source = str(fact.get("source") or "").strip()
        # A bold lead only when the study actually supplies a topic. Synthesising one from the first
        # sentence duplicated the fact in the prompt — "- **Clovis and post-Clovis point production
        # ran a staged sequence: select **: Clovis and post-Clovis point production ran a staged
        # sequence: select blank, percussion-thin..." — seen on a live chapter write. Paying input
        # tokens to say everything twice, and _facts_topics reads the plain bullet perfectly well.
        topic = str(fact.get("topic") or "").strip()[:70]
        lead = f"- **{topic}**: " if topic else "- "
        lines.append(f"{lead}{text}" + (f" [{source}]" if source else ""))
        if source and source not in sources:
            sources.append(source)
    for c in colour:
        lines.append(f"- **Local colour**: {c}")
    # Flags are the places the record does NOT support the outline. A writer who cannot see them
    # dramatises the invention as if it were attested.
    for f in flags:
        lines.append(f"- **Caution**: {f}")
    if sources:
        lines.append("\nSOURCES: " + "; ".join(sources[:12]))
    text = "\n".join(lines)
    return text, _facts_topics(text), len(facts)


def chapter_period(outline: dict[str, Any], chapter_number: int, fallback: str = "") -> str:
    """The era this chapter is set in, taken from the chapter's own outline entry.

    Every caller used to have to supply `period` and nothing derived it, so a payload without one
    wrote the chapter as ``"contemporary"`` — while the information sat in the outline all along.
    On The Ossuary that is catastrophic and silent: all 96 chapters carry a period
    (`ca. 10,500 BCE` … `March 2011`), the book spans twelve thousand years, and `period` drives the
    period-language craft seeds, the research query, and the QA's `period_language_ok` score. A
    batch that forgot to pass it would render the whole deep-time half in modern idiom and still
    report success.

    An explicit payload value always wins — a caller rewriting one chapter in a different era is
    doing it on purpose.
    """
    if fallback.strip():
        return fallback.strip()
    chapters = (outline or {}).get("chapters") or []
    entry: dict[str, Any] | None = None
    for ch in chapters:
        if isinstance(ch, dict) and str(ch.get("chapter_number")) == str(chapter_number):
            entry = ch
            break
    if entry is None and 0 <= chapter_number < len(chapters) and isinstance(chapters[chapter_number], dict):
        entry = chapters[chapter_number]
    research = (entry or {}).get("research")
    if isinstance(research, dict):
        period = str(research.get("period") or "").strip()
        if period:
            return period
    # `period` also appears on some outlines at the top level (older shapes).
    top = str((outline or {}).get("period") or "").strip()
    return top or "contemporary"


async def _chapter_research(beat: str, *, period: str, title: str, focus: str = "") -> tuple[str, list[str]]:
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
        if focus
        else ""
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
            provider="perplexity",
            model="sonar-pro",
            system=None,
            prompt=shape,
            max_tokens=2048,
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
    logger.info(
        "chapter.research.ok",
        topics=len(_facts_topics(facts)),
        chars=len(facts),
        citations=len(resp.citations or []),
    )
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
    text: str,
    *,
    drift: DriftReport,
    roster_text: str,
    genre_slug: str,
    model: str,
    insist_length: bool = False,
    research_facts: str = "",
    line_edit: bool = False,
    style_directives: str = "",
    citation_mode: str = "",
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
        if insist_length
        else ""
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
        if research_facts.strip()
        else ""
    )
    style_block = (
        f"\n\nAUTHOR STYLE DIRECTIVES (apply all of these to the revised prose):\n{style_directives}\n"
        if style_directives.strip()
        else ""
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
        provider="anthropic",
        model=model,
        system=_build_correct_system(genre_slug),
        prompt=user,
        max_tokens=32768,
        stream=True,
    )
    return _strip_em_dashes(_strip_scaffolding(resp.text.strip()))


async def _drift_correct_pass(
    text: str,
    *,
    ctx: dict[str, Any],
    req: WriteChapterRequest,
    roster_text: str,
    period: str,
    model: str,
    min_length_ratio: float = 0.85,
    weave_research: bool = False,
    line_edit: bool = False,
    research_focus: str = "",
    style_directives: str = "",
    citation_mode: str = "",
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
        text,
        outline=ctx["outline"],
        chapter_number=req.chapter_number,
        roster_text=roster_text,
        period=period,
        model=model,
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
            beat,
            period=period,
            title=str(ctx.get("title") or ""),
            focus=_research_focus(ctx),
        )
    has_drift = bool(drift.story_drift or drift.character_drift)
    # Weave whenever we fetched facts — for an explicit research_focus there may be no QA gap to match,
    # but the author still wants those facts in the prose.
    has_research_to_weave = bool(
        weave_research and research_facts and (drift.research_gaps or research_focus.strip())
    )
    has_author_directive = bool(research_focus.strip() or style_directives.strip())
    # line_edit revises EVERY chapter (sentence strengthening), even a clean one.
    if not (has_drift or has_research_to_weave or line_edit or has_author_directive):
        return text, drift, 0  # aligned, nothing to weave, no line-edit / author directive requested
    draft_words = len(text.split())
    floor = min_length_ratio * draft_words
    revised = await _correct_drift(
        text,
        drift=drift,
        roster_text=roster_text,
        genre_slug=ctx["genre_slug"],
        model=model,
        research_facts=research_facts,
        line_edit=line_edit,
        style_directives=style_directives,
        citation_mode=citation_mode,
    )
    if len(revised.split()) < floor:
        retry = await _correct_drift(
            text,
            drift=drift,
            roster_text=roster_text,
            genre_slug=ctx["genre_slug"],
            model=model,
            insist_length=True,
            research_facts=research_facts,
            line_edit=line_edit,
            style_directives=style_directives,
            citation_mode=citation_mode,
        )
        revised = max((revised, retry), key=lambda t: len(t.split()))
    if len(revised.split()) < floor:
        return text, drift, 0  # correction collapsed below the floor — keep the original
    # Re-scan the CORRECTED text so the reported drift reflects the FINAL state, not the pre-correction
    # detection. Without this, every chapter that had ANY cycle-1 drift is stored aligned=False even
    # though cycle 2 fixed it — making the telemetry / project view read ~90% "drifted" when most are
    # actually clean. The post-correction report is what truly tells us which chapters still need repair.
    final_drift = await _detect_drift(
        revised,
        outline=ctx["outline"],
        chapter_number=req.chapter_number,
        roster_text=roster_text,
        period=period,
        model=model,
    )
    return revised, (final_drift or drift), 1


def _saved_sub_chapters(outline: dict[str, Any], chapter_number: Any) -> list:
    """The reviewed chapter outline saved by chapter.plan, if any (E2E-4 R116 auto-plan guard)."""
    for ch in (outline or {}).get("chapters") or []:
        if isinstance(ch, dict) and str(ch.get("chapter_number")) == str(chapter_number):
            return ((ch.get("chapter_outline") or {}).get("sub_chapters")) or []
    return []


async def _op_write(payload: dict) -> dict:
    from writer_engine.config import get_settings

    # G9: chat/voice only ever supply a project TITLE — resolve it to a project_id (creating a new
    # project for a brand-new book) BEFORE validation, which requires the UUID. Without this every
    # "write chapter N of X" failed with ValidationError: project_id required.
    await _resolve_project_for_payload(payload, create=True)
    payload["chapter_number"] = _coerce_chapter_number(payload.get("chapter_number"), 1)
    req = WriteChapterRequest.model_validate(payload)
    ctx = await _load_context(str(req.project_id), payload)

    # Auto-plan guard (E2E-4 R116, opt-in via require_chapter_outline): "write chapter N" with no
    # reviewed chapter outline → create the outline first and STOP, so the author reviews it before any
    # prose is written. Opt-in so the proven auto-fan-out write path (Burial Mound) is unchanged.
    if (
        payload.get("require_chapter_outline")
        and not _briefs_from_payload(payload)
        and not _saved_sub_chapters(ctx.get("outline") or {}, req.chapter_number)
    ):
        plan_result = await _op_plan({**payload, "persist": True})
        return {
            "planned": True,
            "wrote": False,
            "chapter_number": req.chapter_number,
            "message": "No chapter outline existed — I created one and emailed it. Review it, then ask "
            "me to write the chapter.",
            "plan": plan_result,
        }

    roster = ctx["roster"]
    revision = bool(payload.get("revision") or req.use_qa_report_as_input)
    system = _build_write_system(genre_slug=ctx["genre_slug"], outline=ctx["outline"], revision=revision)
    header = _chapter_header(ctx, roster, req)
    settings = get_settings()
    plan = model_plan(req.llm_strategy, settings)
    # `model` stays the name the rest of this function uses for the DRAFT model, which is where the
    # output tokens are. The short corrective passes take plan.polish.
    model = plan.draft
    period = chapter_period(ctx["outline"], req.chapter_number, str(payload.get("period") or ""))
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
            # The chapter's own stored study wins over a live pass: broader sourcing, already
            # reviewed, and addressed by chapter number rather than hoped for from a similarity
            # search. Perplexity is the fallback for chapters that carry no study.
            stored, stored_topics, n_facts = _stored_research(ctx["outline"], req.chapter_number)
            if stored and n_facts >= _MIN_STORED_FACTS:
                research_facts, research_gaps_filled = stored, stored_topics
                logger.info(
                    "chapter.research.stored",
                    chapter=req.chapter_number,
                    facts=n_facts,
                    chars=len(stored),
                )
            else:
                live, live_topics = await _chapter_research(
                    beat, period=period, title=ctx["title"], focus=_research_focus(ctx)
                )
                # A thin study is topped up, never replaced: its facts are cited and reviewed, and
                # on The Ossuary 52 of 96 chapters have exactly one. Labelled so the model can tell
                # attributed material from a live search.
                blocks = []
                if stored:
                    blocks.append("FROM THIS PROJECT'S CHAPTER-BY-CHAPTER STUDY (cited):\n" + stored)
                if live:
                    blocks.append("ADDITIONAL PERIOD RESEARCH:\n" + live)
                research_facts = "\n\n".join(blocks)
                research_gaps_filled = stored_topics + live_topics
                logger.info(
                    "chapter.research.mixed",
                    chapter=req.chapter_number,
                    stored_facts=n_facts,
                    live_chars=len(live),
                )
            # Use a pre-made chapter outline if the caller supplied one (the explicit outline ->
            # chapter-outline -> narrative flow); else auto-load the chapter outline saved by
            # chapter.plan (E2E-4 R114/R115); else plan it now.
            provided = _briefs_from_payload(payload)
            if not provided:
                saved = _saved_sub_chapters(ctx.get("outline") or {}, req.chapter_number)
                provided = [SubChapterBrief.model_validate(s) for s in saved] if saved else []
            briefs = provided or await _plan_subchapters(ctx, req, n_sub, plan.polish)
            sub_briefs = briefs
            # Prompt caching: the craft system + chapter context + research grounding are identical
            # across all sub-chapters, so fold them into ONE cached system prefix (cache-write on the
            # first sub, cache-read on the rest) instead of re-sending them in every user message.
            canon = await _canon_grounding(ctx, beat, user_id=payload.get("user_id"))
            cached_system = _cached_write_system(system, header, research_facts, canon)
            # F2.5 optimization: write the sub-chapters CONCURRENTLY (wall-time = slowest sub, not the
            # sum) when `parallel_subchapters` is set. Each parallel sub is coordinated by the full
            # chapter plan instead of the prior sub's tail. Default OFF so the sequential prior-tail
            # path (the validated baseline) is unchanged; the pre/post optimization test flips this.
            if bool(payload.get("parallel_subchapters")):
                plan_text = _subchapter_plan_text(briefs)
                results = await asyncio.gather(
                    *[
                        _write_subchapter(
                            system=cached_system,
                            brief=brief,
                            idx=i,
                            total=len(briefs),
                            prior_tail="",
                            chapter_number=req.chapter_number,
                            model=model,
                            plan_context=plan_text,
                        )
                        for i, brief in enumerate(briefs)
                    ]
                )
                sub_texts = [t for t, _cr, _cw in results]
                cache_read = sum(cr for _t, cr, _cw in results)
                cache_write = sum(cw for _t, _cr, cw in results)
            else:
                sub_texts = []
                # I3: open on the previous chapter's actual ending rather than on nothing. Empty
                # when that chapter is not written yet (the normal case in a concurrent batch), in
                # which case the outline's bridge_from_prior carries the join as before.
                prior_tail = await _prior_chapter_tail(str(req.project_id), req.chapter_number)
                if prior_tail:
                    logger.info(
                        "chapter.prior_chapter_tail",
                        chapter=req.chapter_number,
                        words=len(prior_tail.split()),
                    )
                for i, brief in enumerate(briefs):
                    t, cr, cw = await _write_subchapter(
                        system=cached_system,
                        brief=brief,
                        idx=i,
                        total=len(briefs),
                        prior_tail=prior_tail,
                        chapter_number=req.chapter_number,
                        model=model,
                    )
                    sub_texts.append(t)
                    cache_read += cr
                    cache_write += cw
                    prior_tail = " ".join(t.split()[-800:])
            text = SCENE_BREAK.join(sub_texts)
            # QA cycle 1 (detect drift vs outline/arc/roster) -> QA cycle 2 (correct it) — only fires a
            # streamed revision when there is real story/character drift. Research is already woven.
            text, drift_report, passes = await _drift_correct_pass(
                text,
                ctx=ctx,
                req=req,
                roster_text=roster_text,
                period=period,
                model=plan.polish,
            )
            final_qa = await _score_chapter(text, period, roster_text, beat=beat)
            # The craft-revision loop used to exist ONLY on the single-call path, so for a real
            # 5-sub-chapter chapter nothing ever re-read the assembled prose against the craft
            # dimensions: it was scored for telemetry and the score was never acted on.
            #
            # Measured across the 96-chapter Ossuary run, and the correlation is the whole argument:
            # the dimensions the DRIFT pass covers scored 0.91-1.00 (character_follows_guide 1.00,
            # character_consistency 1.00, outline 0.92, period 0.91), while the dimensions NOTHING
            # corrected scored worst — story_turn_density 0.79, under threshold in 51 of 96 chapters,
            # and no_boring_paragraphs 0.81, under in 39. The chapter was fixed for exactly what it
            # was checked against, and for nothing else.
            craft_done = 0
            # DEFAULT 0 — off, measured. The loop is wired and guarded, and the mechanism does not
            # work at this length: six attempts across chapters 65, 85 and 89, under two different
            # prompts (the second stating the word count, forbidding deletion and warning that a
            # short answer is discarded), produced six rejections at 48-80% of the original. A model
            # asked to rewrite 6,500 words and return all of them compresses as it goes, and an
            # instruction does not reliably stop it.
            #
            # Kept rather than deleted because the diagnosis stands — see the craft table in
            # [[book-scale-benchmark]]: the dimensions no pass corrects are precisely the weak ones —
            # and because the next mechanism is a small change to this loop rather than a different
            # one. The chapter is already five sections joined by scene breaks, each ~1,300 words,
            # which IS within faithful-reproduction range; revising section by section against the
            # findings for that section, with the neighbours supplied as context rather than as
            # output, is the version worth trying. Until then this costs ~$0.15 a chapter for a
            # result that is thrown away, so it is off unless a caller asks.
            max_craft = max(0, _coerce_int(payload.get("max_craft_passes"), 0))
            while craft_done < max_craft and final_qa is not None:
                low = _low_dims(final_qa)
                if not low:
                    break
                revised = await _revise_chapter(
                    text,
                    low_dims=low,
                    findings=final_qa.findings,
                    model=plan.polish,
                    genre_slug=ctx["genre_slug"],
                )
                # Three ways a whole-chapter rewrite can quietly ruin the chapter, every one of
                # which this codebase has already been bitten by: it returns truncated, it returns
                # shorter, or it returns without the scene breaks (A13/J2 — the em-dash backstop
                # once deleted them). Reject rather than persist any of those.
                rejected = craft_revision_rejected(text, revised)
                if rejected:
                    logger.warning(
                        "chapter.craft_revision_rejected",
                        chapter=req.chapter_number,
                        why=rejected,
                        dims=low,
                    )
                    break
                text = revised
                craft_done += 1
                passes += 1
                logger.info(
                    "chapter.craft_revised",
                    chapter=req.chapter_number,
                    dims=low,
                    words=len(revised.split()),
                )
                final_qa = await _score_chapter(text, period, roster_text, beat=beat)
            sub_count = len(briefs)
        else:
            resp = await router.complete(
                provider="anthropic",
                model=model,
                system=system,
                prompt=f"{header}\n\nWrite chapter {req.chapter_number} in full, following the craft rules.",
                max_tokens=8192,
            )
            text = resp.text.strip()
            passes = 0
            final_qa = None
            max_passes = int(payload.get("max_craft_passes", 1))
            while passes < max_passes:
                qa = await _score_chapter(
                    text,
                    period,
                    _roster_text(roster),
                    beat=_chapter_outline_beat(ctx["outline"], req.chapter_number),
                )
                if qa is None:
                    break
                final_qa = qa
                low = _low_dims(qa)
                if not low:
                    break
                text = await _revise_chapter(
                    text,
                    low_dims=low,
                    findings=qa.findings,
                    model=plan.polish,
                    genre_slug=ctx["genre_slug"],
                )
                passes += 1
                final_qa = None
            if max_passes > 0 and final_qa is None:
                final_qa = await _score_chapter(
                    text,
                    period,
                    _roster_text(roster),
                    beat=_chapter_outline_beat(ctx["outline"], req.chapter_number),
                )
            sub_count = 1
        scores = (
            {k: v for k, v in final_qa.model_dump(mode="json").items() if k in QA_DIMS} if final_qa else None
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
    chapter_number = _coerce_chapter_number(payload.get("chapter_number"), 0)
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
            client,
            project_id=str(project_id),
            user_id=str(user_id),
            chapter_number=chapter_number,
            title=chapter_title,
            content_text=clean_text,
            genre_slug=genre,
            metadata={
                "chapter_run_id": str(out.chapter_run_id),
                "word_count": out.word_count,
                "sub_chapter_count": out.sub_chapter_count,
                "craft_qa": out.craft_qa,
                "drift_report": out.drift_report,
            },
        )
    except Exception as exc:
        logger.exception("chapter.persist.failed", chapter=chapter_number, project=str(project_id))
        return {"persisted": False, "error": str(exc)[:200]}
    # J3: index this chapter's PROSE as retrievable canon, so the NEXT chapter can be grounded in
    # what was actually written rather than only in the outline's one-line brief. Scene-level, and
    # scoped to this chapter — see writer_engine.embeddings.index_chapter_prose. Best-effort: a
    # chapter that is written and persisted must never fail because its vectors did not build.
    prose_indexed = 0
    try:
        from writer_engine.embeddings import index_chapter_prose

        prose_indexed = await index_chapter_prose(
            user_id=str(user_id),
            project_id=str(project_id),
            chapter_number=chapter_number,
            title=chapter_title,
            text=clean_text,
        )
    except Exception as exc:
        logger.warning("chapter.prose_index_failed", chapter=chapter_number, error=str(exc)[:160])

    # Bible extraction/persist is a SEPARATE best-effort step — a failure here must NOT mask the
    # chapter persist that already succeeded above.
    bible_info: dict = {"bible_entries": 0}
    try:
        from writer_engine.persist_helpers import persist_bible

        bible = await _op_extract_bible({"content_text": out.content_text})
        bible_info["bible_entries"] = await persist_bible(
            client,
            project_id=str(project_id),
            user_id=str(user_id),
            entries=bible.get("entries") or [],
            chapter_number=chapter_number,
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
                client,
                project_id=str(project_id),
                user_id=str(user_id),
                topic=f"{project_title} — Chapter {chapter_number} research",
                content=research_used,
                genre_slug=genre,
            )
            # A6: the duplicate `research` story-bible write is GONE. persist_research above already
            # stores the full research text in research_reports_v2 (linked to the project by
            # migration 026); this additionally wrote up to 12 topic-label rows per chapter into
            # story_bible_v2, each carrying a 500-char truncation of the same text. On DEV that was
            # 493 rows — and every sampled row's text was verified present verbatim inside a linked
            # report, so they were pure duplication. They also polluted the Story Bible tab with a
            # type no consumer rendered. Research belongs in research_reports_v2, not the bible.
            bible_info["research_persisted"] = True
        except Exception as exc:
            logger.warning("chapter.research.persist_failed", chapter=chapter_number, error=str(exc)[:200])
            bible_info["research_error"] = str(exc)[:200]

    # CR-005: per-run telemetry row (drift + QA + research/bible usage) for the project view.
    bible_loaded = [r.get("name") for r in (ctx.get("roster") or []) if isinstance(r, dict) and r.get("name")]
    try:
        from writer_engine.persist_helpers import persist_chapter_qa

        await persist_chapter_qa(
            client,
            project_id=str(project_id),
            user_id=str(user_id),
            chapter_number=chapter_number,
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
        "chapter.persisted",
        chapter=chapter_number,
        project=str(project_id),
        word_count=out.word_count,
        aligned=(out.drift_report or {}).get("aligned") if out.drift_report else None,
        bible_loaded=len(bible_loaded),
        bible_written=bible_info["bible_entries"],
        research=bool(research_used),
    )
    return {"persisted": True, "content_id": content_id, "prose_chunks": prose_indexed, **bible_info}


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


CRAFT_MIN_LENGTH_RATIO = 0.9
"""A craft revision shorter than this fraction of the original is rejected.

Post-hoc rewrites shorten — the drift pass carries a floor for exactly that reason. This one is
tighter, because a craft polish has no business cutting a tenth of the chapter."""


def craft_revision_rejected(before: str, after: str) -> str:
    """Why this craft revision must not be kept, or "" to accept it.

    Three ways a whole-chapter rewrite can quietly ruin a chapter, every one of which this codebase
    has already been bitten by:

    * it comes back **truncated** — the output ceiling was too low (see `_revise_max_tokens`);
    * it comes back **shorter** — post-hoc rewrites shorten, and a craft polish has no business
      cutting a tenth of the chapter;
    * it comes back **without the scene breaks** — A13/J2, where the em-dash backstop deleted the
      separators and left `", -"` in the prose.

    Checked here rather than trusted, because the revision replaces the chapter.
    """
    before_words, after_words = len(before.split()), len(after.split())
    if not after_words:
        return "empty"
    if after_words < CRAFT_MIN_LENGTH_RATIO * before_words:
        return f"shorter: {after_words} words vs {before_words} (floor {CRAFT_MIN_LENGTH_RATIO:.0%})"
    if after.count(SCENE_BREAK) < before.count(SCENE_BREAK):
        return f"lost scene breaks: {after.count(SCENE_BREAK)} vs {before.count(SCENE_BREAK)}"
    return ""


def _revise_max_tokens(text: str) -> int:
    """Output ceiling for a revision that must return the WHOLE chapter.

    `_revise_chapter` asked for 8192 regardless of length. That was survivable while it only ran on
    the single-call path, where a chapter is ~3,000 words — but a real chapter here is ~6,400 words,
    roughly 9,000 output tokens, so the revision would come back truncated and replace the chapter
    with a fragment. Fourth instance of this failure in this codebase: the 96-chapter outline, the
    guardrails lens, the craft QA, and now this.
    """
    return max(8192, min(32_000, int(len(text.split()) * 2) + 2_000))


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
    findings_text = (
        "\n".join(
            f"- [{f.get('dimension', '?')}] {f.get('problem', '')} -> FIX: {f.get('fix', '')}"
            for f in findings
        )
        or "(no specific findings; apply the craft rules above)"
    )
    # The length contract. Without it this pass SHRINKS the chapter, because the craft rules it is
    # applying say so: the remedy for a boring paragraph is listed as "(a) cut it" and the remedy for
    # loose pacing is "demote or remove" turns. Both are right for a reviser with room to grow, and
    # wrong for a 6,000-word chapter that has to stay 6,000 words. Measured 2026-10-20 on the three
    # worst-paced chapters of The Ossuary: every revision came back short — 2,596 words against
    # 5,363, 4,178 against 5,223, 4,694 against 6,602 — and all three were rejected by the length
    # floor, so the pass cost money and changed nothing. Cutting is only half a fix here; what the
    # chapter needs is the dull passage REPLACED by dramatised material of comparable length.
    words = len(text.split())
    floor = int(words * CRAFT_MIN_LENGTH_RATIO)
    breaks = text.count(SCENE_BREAK)
    user = (
        "Revise the chapter below to fix these craft issues, applying the rules in the system "
        "prompt. PRESERVE the story, characters, events, and POV exactly — improve only the prose, "
        "dialogue, pacing, and language.\n\n"
        f"LENGTH IS A HARD CONSTRAINT. The chapter is {words:,} words and the revision must be at "
        f"least {floor:,}. Do NOT satisfy these notes by deletion: when you remove a dull or "
        "repetitive passage you must put dramatised material in its place — an action, a discovery, "
        "a turn, a moment of pressure on the POV character — of comparable length. A shorter "
        "chapter will be rejected and your work discarded.\n"
        f"Keep all {breaks} scene-break separators exactly as they appear ({SCENE_BREAK.strip()} on "
        "its own line between sections).\n\n"
        "Return the full revised chapter and nothing else.\n\n"
        f"CRAFT ISSUES TO FIX ({', '.join(low_dims)}):\n{findings_text}\n\nCHAPTER:\n{text}"
    )
    router = get_router(service=STEP_NAME)
    resp = await router.complete(
        provider="anthropic",
        model=model,
        system=system,
        prompt=user,
        max_tokens=_revise_max_tokens(text),
    )
    return resp.text.strip()


def _build_qa_system(period: str = "", roster_text: str = "") -> str:
    """Pure: the craft-QA system prompt — score the chapter against the Follett guide rubrics +
    character consistency + research gaps.

    `period` and `roster_text` fill the seeds' own `{period}` / `{locked_character_roster}` slots.
    Nothing filled them before, so the composed prompt shipped with literal braces and one chapter
    in 91 answered "I need to fill in the template variables before proceeding" instead of JSON —
    on both attempts, losing all eight of its scores."""
    return compose_craft_system(
        placeholders={"period": period, "locked_character_roster": roster_text},
        seed_keys=[
            "follett_seeds.scene.turn_density",
            "follett_seeds.prose.no_boring",
            "follett_seeds.prose.dialogue",
            "follett_seeds.research.period_language",
            "follett_seeds.character.no_milk_and_water",
            # NOT `character.locked_roster`. It is a WRITING seed and it carries a "COPY-FIRST
            # RULE: before writing anything new, copy the roster into your output verbatim, as a
            # section labeled 'Confirmed cast'". In a reviewer prompt that must return strict JSON
            # that instruction is actively harmful, and it became harmful the moment the roster
            # placeholder started being substituted: with a literal `{locked_character_roster}` in
            # the text the rule read as template noise and was ignored, but with a real roster in
            # it the model obeys. Observed scoring 96 chapters — the answer came back as
            # "# Confirmed Cast\n\n- **Marcus Tayac**: Protagonist..." instead of JSON, losing
            # every score for that chapter. The roster is already supplied in the user prompt as
            # "CHARACTER ROSTER (check consistency against this)", which is what a reviewer needs.
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
        "A DIMENSION YOU CANNOT ASSESS MUST BE null, NOT 0.0. 0.0 means 'the chapter does this "
        "badly'; null means 'there is nothing here to judge it against', and the two are opposite "
        "verdicts. Two cases arise constantly and were both being scored 0.0:\n"
        "  * no PLANNED BEAT was supplied -> outline_follows_guide must be null. You cannot measure "
        "a chapter against an outline you were not given.\n"
        "  * the chapter's people are not in the CHARACTER ROSTER at all -> character_follows_guide "
        "and character_consistency must be null. A book spanning many eras has a different cast in "
        "each one, and a roster that does not mention this chapter's characters is not evidence that "
        "the chapter got them wrong. Measured on a 12,000-year project: its chapter 2 protagonist is "
        "in none of the 6 roster entries, and all three of these dimensions came back 0.0 — dragging "
        "a sound chapter to a mean of 0.458 and inviting revisions aimed at nothing.\n"
        "For every score under 0.8, add a finding {dimension, problem, fix, quote, replacement}.\n"
        "QUOTE AND REPLACEMENT ARE WHAT MAKE A FINDING ACTIONABLE, so get them exactly right:\n"
        "  * quote: the EXACT text from the chapter that is the problem — copied character for "
        "character, including its punctuation. One to three sentences. Not a paraphrase, not a "
        "summary, not your own words. It is looked up verbatim in the chapter, and a quote that is "
        "not found there is DISCARDED along with your suggested fix.\n"
        "  * replacement: the prose you would put in its place — finished writing in the author's "
        "voice, ready to drop in, not an instruction about what to write. It must stand in for the "
        "quote grammatically and keep the same facts, characters, period and point of view.\n"
        "  * The replacement must NOT be shorter than the quote unless the problem IS the length. "
        "A pacing or flat-prose problem is fixed by making something happen on the page, not by "
        "deleting the passage where nothing does.\n"
        "  * If a finding is about the chapter as a whole and no single passage carries it, leave "
        "quote and replacement empty rather than inventing a span — an honest note is useful, a "
        "fabricated anchor is not.\n"
        f"List AT MOST {QA_MAX_FINDINGS} findings and at most {QA_MAX_FINDINGS} research_gaps. Keep "
        "problem and fix to one sentence each: a longer answer gets truncated at the output ceiling "
        "and then parses as nothing at all, which loses every score.\n"
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


QA_MAX_FINDINGS = 10
"""Cap on findings AND research_gaps the QA may return.

Unbounded, a verbose reviewer writes past the output ceiling, the JSON arrives truncated, nothing
parses, and ALL EIGHT scores are lost — which is how a real chapter came back with
`craft_qa: null` while `chapter.review` read the same text without trouble. Same failure as the
96-chapter outline and the guardrails lens: an output ceiling set for the typical case, discovered
only after the money was spent."""

QA_MAX_TEXT_CHARS = 60_000
"""About 10k words. A chapter is ~7k words, but an expanded or repaired one can be far longer, and
a prompt that grows without limit eventually pushes the answer into the ceiling above. Matches
review.runner.MAX_DRAFT_CHARS."""

QA_MAX_TOKENS = 12_288

# The eight craft dimensions, in the order the rubric reports them. Used to average a score vector
# so two versions of the same chapter can be compared.
CRAFT_DIMENSIONS = (
    "character_follows_guide",
    "character_consistency",
    "outline_follows_guide",
    "period_language_ok",
    "prose_transparent",
    "dialogue_follows_guide",
    "no_boring_paragraphs",
    "story_turn_density",
)

REPAIR_REGRESSION_TOLERANCE = 0.02
"""How much the craft mean may fall before a repair is thrown away.

Not zero. Re-scoring the same chapter twice moves the mean by about ±0.09, so demanding a strict
improvement would discard repairs that merely got scored on a bad day. But the tolerance is small
on purpose: the failure this guards against is the measured one — six whole-chapter revisions
rejected at 48-80% of the original, and a repair that cut chapter 30 from 7,000 words to 2,800 to
"align" it. A repair that scores materially worse is a repair that ate the chapter."""


def _dimension_scores(qa: ChapterCraftQa | None) -> dict[str, float]:
    """Just the eight numbers. ``findings`` and ``research_gaps`` ride along in the model dump and
    have no business in a score vector that gets compared, averaged and stored."""
    if qa is None:
        return {}
    dumped = qa.model_dump(mode="json")
    return {d: float(dumped[d]) for d in CRAFT_DIMENSIONS if isinstance(dumped.get(d), (int, float))}


def craft_mean(scores: dict[str, Any] | None) -> float | None:
    """Average the craft dimensions present in a score vector. None when there is nothing to average.

    Only numeric dimensions count. A dimension the model could not assess must not be read as zero —
    that was K7, where three dimensions were scored blind as 0.0 and dragged every mean down with
    them."""
    if not scores:
        return None
    vals = [float(scores[d]) for d in CRAFT_DIMENSIONS if isinstance(scores.get(d), (int, float))]
    return sum(vals) / len(vals) if vals else None


def qa_stamp(text: str) -> dict[str, Any]:
    """Fingerprint the exact prose a report was computed from.

    Without this a report cannot be told apart from a stale one, and that is not hypothetical: the
    book run's repair pass rewrote chapters 0, 1, 25 and 77 at 20:52 and left reports generated at
    20:40 sitting in the UI, so the Q/A panel showed findings against prose that had already been
    replaced twelve minutes earlier. The panel was faithful; the report was lying."""
    import hashlib

    body = text or ""
    return {
        "scored_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest()[:16],
        "scored_words": len(body.split()),
    }


def qa_report_is_stale(qa_report: dict[str, Any] | None, text: str) -> bool:
    """Does this report describe prose other than ``text``? Unstamped reports predate the stamp and
    are reported stale, which is the safe direction: they are the ones that may be lying."""
    if not isinstance(qa_report, dict):
        return False
    recorded = qa_report.get("scored_sha256")
    if not recorded:
        return True
    return str(recorded) != qa_stamp(text)["scored_sha256"]


async def _score_chapter(
    text: str, period: str, roster_text: str = "", beat: str = ""
) -> ChapterCraftQa | None:
    """Run the craft-QA over a chapter (incl. character-consistency vs the roster). None when no
    provider OR the QA JSON could not be parsed even on a second, stricter attempt.

    A QA parse failure must NOT lose the drafted chapter — the caller treats None as "couldn't
    score" (skip the revision) rather than erroring the whole write. What it must ALSO not do is
    disappear: this returned None silently, so a chapter with `craft_qa: null` gave no way to find
    out why, and the only clue was that the same chapter scored fine through `chapter.review`.
    """
    from writer_engine.config import get_settings

    router = get_router(service=STEP_NAME)
    roster_block = (
        f"CHARACTER ROSTER (check consistency against this):\n{roster_text}\n\n" if roster_text else ""
    )
    # The beat was never sent, so `outline_follows_guide` was unanswerable by construction and the
    # model scored it 0.0 anyway — the dimension that exists to catch outline drift was being
    # decided blind. Callers that know the chapter pass it now.
    beat_block = f"PLANNED BEAT FOR THIS CHAPTER:\n{beat}\n\n" if beat.strip() else ""
    body = text if len(text) <= QA_MAX_TEXT_CHARS else text[:QA_MAX_TEXT_CHARS]
    if len(body) < len(text):
        logger.info("chapter.qa.text_truncated", sent=len(body), total=len(text))

    # Attempt 1 as before; attempt 2 adds an explicit shape reminder and nothing else. A single
    # retry is worth it because the common failure is a model wrapping JSON in prose or running
    # long, both of which a reminder fixes — and the alternative is throwing away eight scores.
    attempts = (
        _build_qa_system(period, roster_text),
        _build_qa_system(period, roster_text)
        + "\n\nYour previous answer could not be parsed. Reply with ONE JSON object and no prose, "
        "no markdown fence, and no commentary. Keep every string short.",
    )
    for i, system in enumerate(attempts):
        try:
            qa, _resp = await complete_structured(
                router,
                provider="anthropic",
                model=get_settings().model_default,
                system=system,
                prompt=f"PERIOD: {period}\n\n{beat_block}{roster_block}CHAPTER:\n{body}",
                schema=ChapterCraftQa,
                max_tokens=QA_MAX_TOKENS,
            )
            if i:
                logger.info("chapter.qa.recovered_on_retry")
            # Verify every quote against the FULL chapter, not the possibly-truncated body the
            # model was shown: a quote from the part that was sent is still a real span of the
            # chapter, and checking it against `body` would reject valid anchors near the cut.
            qa.findings = anchor_findings(qa.findings, text)
            return qa
        except ProviderNotRegistered:
            return _fixture_qa()
        except ValueError as exc:
            # Logged at WARNING on the first try and ERROR on the last, because by then the chapter
            # really does ship with no scores and somebody has to know that happened.
            log = logger.warning if i < len(attempts) - 1 else logger.error
            log(
                "chapter.qa.unparseable",
                attempt=i + 1,
                of=len(attempts),
                chars=len(body),
                error=str(exc)[:300],
            )
    return None


def _normalise_ws(s: str) -> str:
    return " ".join((s or "").split())


def anchor_findings(findings: list[dict], text: str) -> list[dict]:
    """Verify every finding's quote against the chapter and drop the ones that do not match.

    An annotation is only safe to offer as a one-click fix if its target really is in the text:
    Apply does a literal span replacement, so an unverified quote produces a button that 422s on
    click — which the drift source already learned the hard way and works around by skipping flags
    whose variant is no longer present.

    Matching is exact first, then whitespace-normalised, because models reflow line breaks when
    quoting. On a normalised hit the ORIGINAL span is recovered from the chapter so the stored
    target_text is byte-exact; a quote the panel cannot find is worse than no quote.

    A finding that loses its quote is kept as a note. It still tells the author something true; it
    just cannot be applied in one click. What is never kept is a quote that does not exist — that
    is a fabricated anchor, and this function exists to make that impossible rather than unlikely.
    """
    body = text or ""
    flat = _normalise_ws(body)
    out: list[dict] = []
    for f in findings or []:
        item = dict(f)
        quote = str(item.get("quote") or "").strip()
        if not quote:
            item.pop("quote", None)
            item.pop("replacement", None)
            out.append(item)
            continue
        if quote in body:
            item["quote_verified"] = True
            out.append(item)
            continue
        # Whitespace-only difference — the usual case, because models reflow line breaks when they
        # quote. Match the words with any run of whitespace between them, which recovers the span
        # from the ORIGINAL text so the stored target_text stays byte-exact.
        fq = _normalise_ws(quote)
        recovered = ""
        if fq and fq in flat:
            pattern = r"\s+".join(re.escape(w) for w in fq.split())
            m = re.search(pattern, body)
            if m:
                recovered = m.group(0)
        if recovered:
            item["quote"] = recovered
            item["quote_verified"] = True
            out.append(item)
            continue
        logger.info(
            "chapter.qa.finding_quote_unmatched",
            dimension=str(item.get("dimension") or ""),
            quote=quote[:80],
        )
        item.pop("quote", None)
        item.pop("replacement", None)
        item["quote_verified"] = False
        out.append(item)
    return out


def _low_dims(qa: ChapterCraftQa, threshold: float = CRAFT_THRESHOLD) -> list[str]:
    d = qa.model_dump(mode="json")
    return [dim for dim in QA_DIMS if d.get(dim, 0.0) < threshold]


_NAME_STOP = {
    "the",
    "and",
    "but",
    "she",
    "her",
    "his",
    "him",
    "they",
    "them",
    "their",
    "you",
    "your",
    "this",
    "that",
    "then",
    "there",
    "here",
    "when",
    "where",
    "what",
    "who",
    "why",
    "how",
    "chapter",
    "prologue",
    "epilogue",
    "act",
    "scene",
    "part",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "january",
    "february",
    "march",
    "april",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
}


def _edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _deaccent(s: str) -> str:
    """Strip diacritics (NFKD → drop combining marks): 'Tomás' → 'Tomas', 'José' → 'Jose'. Used so the
    drift scanner's ASCII tokeniser doesn't split accented names into unusably short fragments."""
    return "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))


_HONORIFICS = frozenset(
    {
        "father",
        "mother",
        "doctor",
        "mister",
        "missus",
        "sister",
        "brother",
        "uncle",
        "aunt",
        "lord",
        "lady",
        "madam",
        "miss",
        "captain",
        "colonel",
        "major",
        "general",
        "sergeant",
        "reverend",
        "pastor",
        "bishop",
        "chief",
        "elder",
        "grandmother",
        "grandfather",
        "professor",
        "president",
        "governor",
        "senator",
        "judge",
        "sheriff",
        "deacon",
        "widow",
    }
)
"""Titles that appear inside roster entries and must never be matched against as names."""


def _character_name_consistency(text: str, roster: list[dict]) -> dict:
    """Deterministic character-name cross-check (R119): which roster names appear, and any capitalized
    word in the prose that is a near-miss of a roster name (a likely rename, e.g. Mara→Meara).

    HIGH PRECISION — a naive edit-distance match floods ordinary prose with false positives (it flagged
    "Now"/"From"/"Make"/"Yes" as name drift). Guards:
      * only fuzzy-match against roster tokens of length >= 4 (short tokens like "Tom" match far too many
        common words within a 2-edit window),
      * candidate words must be >= 4 letters,
      * edit distance <= 1 for a roster token < 7 chars, <= 2 only for longer names, and the length
        difference must be <= 1 (a rename is a typo of the SAME name, not a different-length word).
    ``consistent`` reflects RENAMES only — a roster character simply not appearing in one chapter is not
    an inconsistency (names_missing is still reported, for information)."""
    roster_full = [str(c.get("name") or "").strip() for c in roster if str(c.get("name") or "").strip()]
    # De-accent before tokenising: "Tomás" → "Tomas" (a 5-char token). Without this the accented "á"
    # split the name into "Tom"+"s" (both < 4 chars → no token), so the scanner was BLIND to any
    # accented character — a real drift like "Thomas" for canonical "Tomás" went uncaught.
    # Honorifics are not names. "Father Declan Murtagh" contributed the token "father", which sits
    # one edit from the ordinary word "Feather" — so a chapter using that word was flagged as
    # character drift and blocked from approval, with a one-click fix offering to rewrite it.
    roster_tokens = {
        t.lower()
        for n in roster_full
        for t in re.findall(r"[A-Za-z]{4,}", _deaccent(n))
        if t.lower() not in _HONORIFICS
    }
    low = _deaccent(text).lower()
    present = [
        n for n in roster_full if n and re.search(rf"\b{re.escape(_deaccent(n.split()[0]).lower())}\b", low)
    ]
    missing = [n for n in roster_full if n not in present]
    from collections import Counter

    renames: list[dict] = []
    seen: set[str] = set()
    # Candidates come from the ORIGINAL text (an ASCII-only regex, so a "found" word stays a real span
    # for Apply Fix); we only de-accent the roster tokens they're compared against.
    counts = Counter(re.findall(r"\b[A-Z][a-z]{3,}\b", text))
    for w in counts:
        wl = w.lower()
        if wl in seen or wl in roster_tokens or wl in _NAME_STOP:
            continue
        for rt in roster_tokens:
            maxd = 1 if len(rt) < 7 else 2
            if not (0 < _edit_distance(wl, rt) <= maxd and abs(len(wl) - len(rt)) <= 1):
                continue
            # A PLURAL OR POSSESSIVE of a roster name is not a rename. "the Tayacs" is ordinary
            # English about a family, and it sits exactly one edit from "Tayac" with a length
            # difference of one, so the distance guard waves it straight through. Found on two
            # chapters whose one-click fix offered to turn "the Tayacs" into "the Marcus".
            if wl in {f"{rt}s", f"{rt}es", f"{rt}'s"}:
                continue
            # A name the chapter USES is not a typo of a different name. A rename slip appears once
            # or twice; an era's own character appears throughout. Measured on a 12,000-year book
            # whose 6-entry roster is all modern: "Koss", a deep-time character, sat one edit from
            # "Voss" and was offered as a correction to it. Requiring the suspected drift to be
            # RARER than the name it supposedly drifted from is what separates the two.
            canon_uses = sum(c for word, c in counts.items() if word.lower() == rt)
            if counts[w] >= 3 and counts[w] > canon_uses:
                continue
            renames.append({"found": w, "closest_roster_name": rt})
            seen.add(wl)
            break
    return {
        "consistent": not renames,
        "roster": roster_full,
        "names_present": present,
        "names_missing": missing,
        "possible_renames": renames,
    }


_QA_DIM_LABELS = {
    "character_follows_guide": "Character craft",
    "outline_follows_guide": "Follows the outline",
    "dialogue_follows_guide": "Dialogue",
    "prose_transparent": "Prose clarity",
    "story_turn_density": "Story turns / pacing",
    "no_boring_paragraphs": "No flat paragraphs",
    "period_language_ok": "Period language",
    "character_consistency": "Character consistency",
}


def _build_qa_report(scores: dict, findings: list, name_check: dict | None, scored_text: str = "") -> dict:
    """Transform the engine QA result into the UI's ``metadata.qa_report`` shape
    ``{generated_at, checks:[{name,status:PASS|NEEDS_REVIEW,details}]}`` (QAReportPanel reads this).

    ``scored_text`` fingerprints the prose this report was computed from, so a report left behind by
    a later rewrite can be identified as stale instead of being read as current."""
    from datetime import UTC, datetime

    find_by_dim: dict[str, str] = {}
    for f in findings or []:
        d = str(f.get("dimension") or "")
        if d and d not in find_by_dim:
            find_by_dim[d] = str(f.get("fix") or f.get("problem") or "")
    checks = []
    for dim, label in _QA_DIM_LABELS.items():
        if dim == "character_consistency":
            continue  # handled from name_check below (authoritative, deterministic)
        v = scores.get(dim)
        if not isinstance(v, (int, float)):
            continue
        ok = v >= CRAFT_THRESHOLD
        checks.append(
            {
                "name": label,
                "status": "PASS" if ok else "NEEDS_REVIEW",
                "details": (find_by_dim.get(dim) or f"score {v:.2f}") if not ok else f"score {v:.2f}",
            }
        )
    # deterministic character-name consistency (drives the drift demo)
    if name_check is not None:
        renames = name_check.get("possible_renames") or []
        missing = name_check.get("names_missing") or []
        consistent = bool(name_check.get("consistent"))
        detail = (
            "All roster names consistent."
            if consistent
            else (
                "Possible renames: "
                + ", ".join(f"{r.get('found')}→{r.get('closest_roster_name')}" for r in renames)
                + ("; missing: " + ", ".join(missing) if missing else "")
            )
        )
        checks.append(
            {
                "name": "Character consistency",
                "status": "PASS" if consistent else "NEEDS_REVIEW",
                "details": detail,
            }
        )
    report: dict[str, Any] = {"generated_at": datetime.now(UTC).isoformat(), "checks": checks}
    if scored_text:
        report.update(qa_stamp(scored_text))
        report["craft_mean"] = round(craft_mean(scores) or 0.0, 4)
    return report


def _drift_scan_from_namecheck(
    name_check: dict | None, chapter_text: str, chapter_number: int
) -> dict | None:
    """Build the ``outline._character_drift_scan`` structure the AnnotationsPanel reads, from the QA
    name-consistency result. Each near-miss variant (e.g. 'Meara' vs roster 'Mara') becomes a drift
    flag on this chapter with a ``replacement`` so the panel's one-click Apply can fix it."""
    if not name_check:
        return None
    renames = name_check.get("possible_renames") or []
    roster = name_check.get("roster") or []
    if not renames:
        return None
    chars: list[dict] = []
    for r in renames:
        variant = str(r.get("found") or "")
        token = str(r.get("closest_roster_name") or "")
        if not variant or not token:
            continue
        canonical = next((n for n in roster if token in n.lower().split()), token.capitalize())
        # The replacement is the canonical form of the token that MATCHED, not the first word of the
        # full name. `canonical.split()[0]` offered "Dr." for a surname drift of "Dr. Renata Voss"
        # and "Marcus" for one of "Marcus Tayac" — an Apply that would have written "the Marcus"
        # into the prose. One-click means the suggestion has to be right.
        replacement = next(
            (w for w in canonical.split() if w.lower().strip(".,'") == token.lower()),
            canonical.split()[0] if canonical else token.capitalize(),
        )
        idx = chapter_text.find(variant)
        context = chapter_text[max(0, idx - 30) : idx + len(variant) + 30] if idx >= 0 else variant
        chars.append(
            {
                "name": canonical,
                "name_format": canonical,
                "drift_flags": [
                    {
                        "chapter_number": chapter_number,
                        "variant": variant,
                        "context": context,
                        "type": "name_variant",
                        "severity": "high",
                        "replacement": replacement,
                    }
                ],
            }
        )
    return {"characters": chars, "generated_at": None} if chars else None


async def _persist_qa_artifacts(
    payload: dict, scores: dict, findings: list, name_check: dict | None, chapter_text: str
) -> dict | None:
    """Persist the QA report to the chapter row's ``metadata.qa_report`` (so the QAReportPanel displays
    it) and any character-name drift into the project's ``outline._character_drift_scan`` (so the
    AnnotationsPanel surfaces it with a one-click fix). Best-effort; never breaks the QA op."""
    from writer_engine.config import get_settings
    from writer_engine.persist_helpers import touch

    project_id = payload.get("project_id")
    chn = payload.get("chapter_number")
    settings = get_settings()
    if not (
        project_id and chn not in (None, "") and settings.supabase_url and settings.supabase_service_role_key
    ):
        return None
    try:
        cnum = _coerce_chapter_number(chn, 0)
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        qa_report = _build_qa_report(scores or {}, findings or [], name_check, chapter_text)
        # merge qa_report into the chapter row's metadata (keyed on project+chapter)
        cur = await (
            client.table("published_content_v2")
            .select("id,metadata")
            .eq("project_id", str(project_id))
            .eq("content_type", "chapter")
            .eq("chapter_number", cnum)
            .limit(1)
            .execute()
        )
        rows = getattr(cur, "data", None) or []
        if rows:
            meta = dict(rows[0].get("metadata") or {})
            meta["qa_report"] = qa_report
            # The findings themselves, with their verified spans, so the annotations panel can pin
            # each one to a line and offer a one-click Apply. The qa_report's `checks` are a
            # human-readable summary and deliberately lossy — they collapse a finding to a sentence
            # of advice with nowhere to click, which is why craft findings could not be actioned.
            meta["craft_findings"] = {
                "generated_at": qa_report.get("generated_at"),
                **qa_stamp(chapter_text),
                "findings": [f for f in (findings or []) if isinstance(f, dict)][:QA_MAX_FINDINGS],
            }
            from datetime import UTC, datetime

            await (
                client.table("published_content_v2")
                .update({"metadata": meta, "updated_at": datetime.now(UTC).isoformat()})
                .eq("id", rows[0]["id"])
                .execute()
            )
        # merge character drift into the project outline: keep OTHER chapters' flags, refresh THIS
        # chapter's (so re-running QA after a fix clears the stale flag, and other chapters aren't lost).
        new_chars = (_drift_scan_from_namecheck(name_check, chapter_text, cnum) or {}).get("characters") or []
        po = await (
            client.table("writing_projects_v2").select("outline").eq("id", str(project_id)).limit(1).execute()
        )
        prows = getattr(po, "data", None) or []
        if prows:
            outline = dict(prows[0].get("outline") or {})
            existing = (outline.get("_character_drift_scan") or {}).get("characters") or []
            merged: dict[str, dict] = {}
            for c in existing:
                nm = str(c.get("name") or "")
                flags = [f for f in (c.get("drift_flags") or []) if f.get("chapter_number") != cnum]
                if flags:
                    merged[nm] = {"name": nm, "name_format": c.get("name_format", nm), "drift_flags": flags}
            for c in new_chars:
                nm = c["name"]
                merged.setdefault(
                    nm, {"name": nm, "name_format": c.get("name_format", nm), "drift_flags": []}
                )
                merged[nm]["drift_flags"].extend(c["drift_flags"])
            outline["_character_drift_scan"] = {"characters": list(merged.values())}
            await (
                client.table("writing_projects_v2")
                .update({"outline": outline, **touch()})
                .eq("id", str(project_id))
                .execute()
            )
        return {"qa_report_checks": len(qa_report["checks"]), "drift_characters": len(new_chars)}
    except Exception as exc:
        logger.warning("qa.persist_failed", error=str(exc)[:200])
        return {"persisted": False, "error": str(exc)[:200]}


async def _op_qa(payload: dict) -> dict:
    # Resolve project_id from the title (the hub passes project_title, not a UUID) so we load the REAL
    # chapter prose + roster and can persist the report. Without this, QA scored empty text and never
    # surfaced in the UI.
    await _resolve_project_for_payload(payload, create=False)
    # Load the chapter prose + roster when only project_id+chapter_number are given (R119: the hub
    # passes a reference, not the text), so a "check chapter N for name consistency" works end to end.
    chapter_text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    roster = payload.get("roster") or []
    project_id = payload.get("project_id")
    chapter_number = payload.get("chapter_number")
    beat = ""
    ctx: dict[str, Any] = {}
    if (not chapter_text or not roster) and project_id and chapter_number not in (None, ""):
        ctx = await _load_context(str(project_id), payload)
        roster = roster or ctx.get("roster") or []
        ch_n = optional_int(chapter_number)
        if ch_n is not None:
            # Without this the QA scores `outline_follows_guide` against an outline it was never
            # given, and the model answers 0.0 rather than null — the dimension that exists to catch
            # outline drift, decided blind.
            beat = _chapter_outline_beat(ctx.get("outline") or {}, ch_n)
        if not chapter_text:
            chapter_text = await _load_persisted_chapter(str(project_id), ch_n) if ch_n is not None else ""
    # Same reason as the write path: `period_language_ok` is scored against the era, and defaulting
    # a 10,500 BCE chapter to "contemporary" marks correct period language as wrong.
    period = chapter_period(
        ctx.get("outline") or payload.get("outline") or {},
        optional_int(chapter_number) or 0,
        str(payload.get("period") or ""),
    )
    roster_text = _roster_text(roster) if roster else ""
    name_check = _character_name_consistency(chapter_text, roster) if roster else None
    qa = await _score_chapter(chapter_text, period, roster_text, beat=beat)
    if qa is None:
        return {
            "chapter_id": payload.get("chapter_id"),
            "scores": None,
            "findings": [],
            "character_consistency": name_check,
            "note": "craft-QA JSON could not be parsed",
        }
    scores = qa.model_dump(mode="json")
    findings = scores.pop("findings", [])
    # Persist qa_report (→ QAReportPanel) + character drift (→ AnnotationsPanel) so the UI shows
    # results — UNLESS the caller explicitly asked not to.
    #
    # This used to persist unconditionally, so `persist: false` was accepted by the API and silently
    # ignored. A read-only probe of the deployed engine therefore WROTE its findings over two
    # chapters whose reports had just been corrected, re-blocking both. A flag the API accepts and
    # disregards is worse than one it rejects: the caller believes it has done nothing.
    #
    # Default True: the UI's "Run Q/A" and the hub do not pass the flag and rely on persistence.
    persisted = (
        await _persist_qa_artifacts(payload, scores, findings, name_check, chapter_text)
        if payload.get("persist", True) is not False
        else None
    )
    return {
        "chapter_id": payload.get("chapter_id"),
        "scores": scores,
        "findings": findings,
        "character_consistency": name_check,
        "qa_report": _build_qa_report(scores, findings, name_check, chapter_text),
        "persist": persisted,
    }


async def _persist_review_report(payload: dict, report: dict) -> dict | None:
    """Persist a review under the chapter's ``metadata.review_report``. Best-effort.

    Its **own** key, not ``metadata.qa_report``. The Q/A panel reads ``qa_report`` and
    ``POST /api/content/:id/rewrite-to-fix-qa`` turns its ``NEEDS_REVIEW`` rows into a
    ``chapter.repair``. Merging a critique lens into that would let "Hemingway thinks paragraph two
    is wordy" trigger an automated rewrite of a chapter that passes every rubric the product
    promises. The rows are in the same shape deliberately, so the panel can render them — the
    decision to act on them stays the user's.
    """
    from writer_engine.config import get_settings

    project_id = payload.get("project_id")
    chn = payload.get("chapter_number")
    settings = get_settings()
    if not (
        project_id and chn not in (None, "") and settings.supabase_url and settings.supabase_service_role_key
    ):
        return None
    try:
        cnum = _coerce_chapter_number(chn, 0)
        from datetime import UTC, datetime

        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        cur = await (
            client.table("published_content_v2")
            .select("id,metadata")
            .eq("project_id", str(project_id))
            .eq("content_type", "chapter")
            .eq("chapter_number", cnum)
            .limit(1)
            .execute()
        )
        rows = getattr(cur, "data", None) or []
        if not rows:
            return {"persisted": False, "error": f"no chapter {cnum} row to attach the review to"}
        meta = dict(rows[0].get("metadata") or {})
        meta["review_report"] = report
        await (
            client.table("published_content_v2")
            .update({"metadata": meta, "updated_at": datetime.now(UTC).isoformat()})
            .eq("id", rows[0]["id"])
            .execute()
        )
        return {"persisted": True, "checks": len(report.get("checks") or [])}
    except Exception as exc:
        # C4: a review that could not be saved must say so — the user is looking at findings that
        # will be gone on reload otherwise.
        logger.warning("review.persist_failed", error=str(exc)[:200])
        return {"persisted": False, "error": str(exc)[:200]}


async def _op_review(payload: dict) -> dict:
    """E7 — run named editorial review lenses over a chapter.

    ``chapter.qa`` answers "does this meet the rubric". This answers "what would Hemingway cut, and
    where does the scene stand and explain instead of walking and talking" — critique, from a voice
    the user picked. See ``writer_engine.review``.

    Payload: ``lenses`` (names, or ``panel`` / ``debate``), plus the usual chapter reference
    (``project_id`` or ``project_title`` + ``chapter_number``) or inline ``chapter_text``.
    """
    from writer_engine.review import lenses as lens_mod
    from writer_engine.review import review_draft

    await _resolve_project_for_payload(payload, create=False)
    text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    project_id = payload.get("project_id")
    chapter_number = payload.get("chapter_number")
    if not text and project_id and chapter_number not in (None, ""):
        ch_n = optional_int(chapter_number)
        text = await _load_persisted_chapter(str(project_id), ch_n) if ch_n is not None else ""

    raw = payload.get("lenses") or payload.get("lens") or None
    requested = [raw] if isinstance(raw, str) else list(raw) if raw else None
    try:
        singles, orchestrators = lens_mod.expand(requested)
    except lens_mod.UnknownLens as exc:
        return {
            "error": f"unknown review lens {exc}",
            "available_lenses": list(lens_mod.ALL_LENSES),
        }

    report = await review_draft(
        text,
        requested=requested,
        title=str(payload.get("title") or payload.get("project_title") or ""),
        context=str(payload.get("context") or payload.get("notes") or ""),
    )
    persisted = await _persist_review_report(payload, report) if text else None
    return {
        "chapter_number": chapter_number,
        "lenses": list(singles) + list(orchestrators),
        "review_report": report,
        "finding_count": report.get("finding_count", 0),
        "persist": persisted,
    }


async def _op_scan_drift(payload: dict) -> dict:
    """Standalone QA cycle 1 — detect drift of a chapter vs its outline beat + arc + roster."""
    from writer_engine.config import get_settings

    text = str(payload.get("chapter_text") or payload.get("content_text") or "")
    outline = payload.get("outline") or {}
    chapter_number = _coerce_chapter_number(payload.get("chapter_number"), 0)
    roster_text = _roster_text(payload.get("roster") or []) if payload.get("roster") else "(none)"
    period = chapter_period(outline, chapter_number, str(payload.get("period") or ""))
    drift = await _detect_drift(
        text,
        outline=outline,
        chapter_number=chapter_number,
        roster_text=roster_text,
        period=period,
        model=get_settings().model_default,
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
    return DriftScanResult(chapter_id=payload.get("chapter_id") or uuid4(), findings=findings).model_dump(
        mode="json"
    )


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
        return {
            "content_text": text,
            "word_count": len(text.split()),
            "rewritten": False,
            "note": "rewrite needs both chapter_text and feedback",
        }
    project_id = payload.get("project_id")
    ctx = (
        await _load_context(str(project_id), payload)
        if project_id
        else _apply_ctx_overrides({"genre_slug": "", "title": "", "outline": {}, "roster": []}, payload)
    )
    roster_text = _roster_text(ctx.get("roster") or [])
    settings = get_settings()
    model = _polish_model(payload, settings)
    allow_shorten = bool(payload.get("allow_shorten"))
    router = get_router(service=STEP_NAME)
    try:
        resp = await router.complete(
            provider="anthropic",
            model=model,
            system=_build_rewrite_system(ctx.get("genre_slug", "")),
            prompt=(
                f"CHARACTER ROSTER (consistency reference):\n{roster_text}\n\n"
                f"AUTHOR FEEDBACK (apply all of it):\n{feedback}\n\n"
                f"CHAPTER TO REWRITE:\n{text}"
            ),
            max_tokens=32768,
            stream=True,
        )
    except ProviderNotRegistered:
        return {
            "content_text": text,
            "word_count": len(text.split()),
            "rewritten": False,
            "note": "no LLM provider",
        }
    rewritten = _strip_scaffolding(resp.text.strip())
    # Guard: a rewrite that collapsed the chapter (when the feedback did not ask to shorten) keeps the
    # original rather than shipping a truncated/condensed chapter.
    if not allow_shorten and len(rewritten.split()) < 0.9 * len(text.split()):
        return {
            "content_text": text,
            "word_count": len(text.split()),
            "rewritten": False,
            "note": "rewrite came back too short; kept the original",
        }
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
        client.table("published_content_v2")
        .select("content_text")
        .eq("project_id", project_id)
        .eq("content_type", "chapter")
        .eq("chapter_number", chapter_number)
        .limit(1)
        .execute()
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
    chapter_number = _coerce_chapter_number(payload.get("chapter_number"), 0)
    text = str(payload.get("content_text") or "")
    if not text and project_id:
        text = await _load_persisted_chapter(str(project_id), chapter_number)
    if not text:
        return {
            "repaired": False,
            "reason": "no chapter text (give content_text or project_id+chapter_number)",
        }
    ctx = (
        await _load_context(str(project_id), payload)
        if project_id
        else _apply_ctx_overrides({"genre_slug": "", "title": "", "outline": {}, "roster": []}, payload)
    )
    roster_text = _roster_text(ctx.get("roster") or [])
    # The chapter's own research period first; the act label is only a proxy for an era and was
    # standing in for one here.
    period = chapter_period(
        ctx.get("outline") or {},
        chapter_number,
        str(payload.get("period") or ""),
    )
    if period == "contemporary":
        period = _outline_chapter_act(ctx.get("outline") or {}, chapter_number) or period
    settings = get_settings()
    model = _polish_model(payload, settings)
    req = WriteChapterRequest.model_validate(
        {
            "project_id": project_id or "00000000-0000-0000-0000-000000000000",
            "chapter_number": chapter_number,
            "chapter_run_id": payload.get("chapter_run_id") or str(uuid4()),
        }
    )
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
    beat = _chapter_outline_beat(ctx.get("outline") or {}, chapter_number)
    # Score the chapter BEFORE touching it. Nothing did this: a repair rewrote the prose, persisted
    # it, and left the previous report in place — so the Q/A panel described text that no longer
    # existed, and no one could tell whether the repair had helped or hurt. Both halves of that are
    # fixed here: re-score after, and compare against before.
    before_qa = await _score_chapter(text, period, roster_text=roster_text, beat=beat)
    before_scores = _dimension_scores(before_qa)
    before_mean = craft_mean(before_scores)

    new_text, drift, passes = await _drift_correct_pass(
        text,
        ctx=ctx,
        req=req,
        roster_text=roster_text,
        period=period,
        model=model,
        min_length_ratio=min_ratio,
        weave_research=True,
        line_edit=True,
        research_focus=research_focus,
        style_directives=style_directives,
        citation_mode=citation_mode,
    )

    # Verify the repair rather than trusting it, and keep the better of the two.
    after_qa = await _score_chapter(new_text, period, roster_text=roster_text, beat=beat) if passes else None
    after_scores = _dimension_scores(after_qa)
    after_mean = craft_mean(after_scores)
    rolled_back = False
    verdict = "no change"
    if passes:
        if before_mean is None or after_mean is None:
            # Unscoreable in either direction. Keep the repair (it is the drift-corrected text) but
            # say so, rather than reporting a comparison that was never made.
            verdict = "kept, unverified — the craft QA did not return a usable score"
        elif after_mean < before_mean - REPAIR_REGRESSION_TOLERANCE:
            rolled_back = True
            repaired_mean = after_mean
            new_text, after_scores, after_mean = text, before_scores, before_mean
            verdict = (
                f"ROLLED BACK — the repair scored {repaired_mean:.3f} against {before_mean:.3f} "
                "before it, so the original text was kept"
            )
            logger.warning(
                "chapter.repair.rolled_back",
                chapter=chapter_number,
                before=round(before_mean, 4),
                after=round(repaired_mean, 4),
            )
        else:
            verdict = f"kept — {before_mean:.3f} to {after_mean:.3f}"
            logger.info(
                "chapter.repair.verified",
                chapter=chapter_number,
                before=round(before_mean, 4),
                after=round(after_mean, 4),
            )
    persist_result = None
    # Persist whenever persist is requested — NOT only when a correction happened. A repair that
    # re-scans and finds the chapter already clean must still record the verified aligned=True state,
    # otherwise the stale pre-correction telemetry (aligned=False) lingers and the project view keeps
    # showing drift that was already fixed. `drift` here is the POST-correction re-scan (see
    # _drift_correct_pass), so the stored aligned reflects the true final state either way.
    if payload.get("persist"):
        out = WriteChapterResponse(
            chapter_id=uuid4(),
            chapter_run_id=req.chapter_run_id,
            content_text=new_text,
            word_count=len(new_text.split()),
            sub_chapter_count=0,
            craft_passes=passes,
            drift_report=drift.model_dump(mode="json") if drift else None,
        )
        persist_result = await _persist_chapter_if_requested(payload, ctx, out, model=model)
        # Refresh the Q/A report so it describes the text that is now stored. Without this the repair
        # left the pre-repair report in place and the panel showed findings against replaced prose.
        # On a rollback this still runs, and correctly re-stamps the ORIGINAL text as what was scored.
        if after_scores:
            await _persist_qa_artifacts(
                payload,
                after_scores,
                (
                    after_qa.findings
                    if after_qa and not rolled_back
                    else before_qa.findings
                    if before_qa
                    else []
                )
                or [],
                None,
                new_text,
            )
    d = drift.model_dump(mode="json") if drift else None
    return {
        "repaired": bool(passes) and not rolled_back,
        "content_text": new_text,
        "word_count": len(new_text.split()),
        "craft_passes": passes,
        "drift_report": d,
        "drift_detected": (d is not None and not d.get("aligned", True)) if d else None,
        # What the repair did to the score, and whether its work was kept. `repaired: false` with
        # `rolled_back: true` means the pass ran, was measured, and was thrown away on purpose.
        "rolled_back": rolled_back,
        "verdict": verdict,
        "craft_mean_before": round(before_mean, 4) if before_mean is not None else None,
        "craft_mean_after": round(after_mean, 4) if after_mean is not None else None,
        "scores": after_scores or before_scores,
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
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_build_genre_eval_system(genre),
            prompt=f"GENRE: {genre}\n\nCHAPTER:\n{text}",
            schema=GenreEval,
            max_tokens=1024,
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
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_build_extract_bible_system(),
            prompt=f"CHAPTER:\n{text}",
            schema=BibleExtract,
            max_tokens=4096,
        )
        entries = [e.model_dump(mode="json") for e in extract.entries]
        persisted = await _persist_bible_if_requested(payload, entries)
        return {"entries": entries, "added": len(entries), "persist": persisted}
    except ProviderNotRegistered:
        entries = [
            BibleEntry(entry_type="character", name="(fixture)", description="no LLM provider").model_dump(
                mode="json"
            )
        ]
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
            client,
            project_id=str(project_id),
            user_id=str(user_id),
            entries=entries,
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
            client.table("genre_config_v2")
            .select("genre_name,writing_guidelines")
            .eq("genre_slug", genre_slug)
            .limit(1)
            .execute()
        )
        row = (getattr(r, "data", None) or [{}])[0]
        return (row.get("genre_name") or genre_slug, row.get("writing_guidelines") or "")
    except Exception:
        return (genre_slug, "")


async def _persist_simple(
    payload: dict,
    *,
    title: str,
    content_type: str,
    content_text: str,
    genre_slug: str,
    metadata: dict | None = None,
) -> dict | None:
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
            client,
            user_id=str(user_id),
            title=title,
            content_type=content_type,
            content_text=_strip_em_dashes(content_text),
            genre_slug=genre_slug,
            project_id=payload.get("project_id"),
            metadata=metadata or {},
        )
        logger.info(
            "compose.persisted", content_type=content_type, content_id=cid, words=len(content_text.split())
        )
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
    target = _coerce_int(payload.get("target_length"), 1500)  # G6: router may pass "1500 words"
    genre_name, guidelines = await _load_genre_guidelines(genre_slug)
    research, _ = (
        await _chapter_research(
            topic, period="contemporary", title=topic, focus=f"Genre: {genre_slug}. Blog topic: {topic}"
        )
        if topic
        else ("", [])
    )
    model = _polish_model(payload, settings)
    system = (
        f"You are a world-class blogger specializing in {genre_name}.\n\n## Genre Guidelines\n{guidelines}\n\n"
        f"## Writing Prime Directive\n{_PRIME_DIRECTIVE}\n\n## Requirements\n- Attention-grabbing headline\n"
        "- Hook opening paragraph\n- 3-5 subheadings for scannability\n- Relevant book/film recommendations\n"
        "- End with a discussion prompt\n- SEO-optimized without keyword stuffing\n\n"
        "Return strict JSON: {title, meta_description, body_markdown, tags}."
    )
    prompt = (
        f"Write a blog post about: {topic}\nTarget length: {target} words\nSEO keywords: {keywords}\n\n"
        f"## Research Context\n{research}"
    )
    try:
        resp = await get_router(service=STEP_NAME).complete(
            provider="anthropic", model=model, system=system, prompt=prompt, max_tokens=8192
        )
    except ProviderNotRegistered:
        return {"written": False, "reason": "no provider"}
    import json as _json

    title, body, meta = (topic[:80] or "Untitled Blog Post"), resp.text.strip(), {}
    try:
        m = re.search(r"\{.*\}", resp.text, re.S)
        data = _json.loads(m.group(0)) if m else {}
        title = data.get("title") or title
        body = data.get("body_markdown") or body
        meta = {"meta_description": data.get("meta_description"), "tags": data.get("tags")}
    except Exception:
        pass
    body = _strip_em_dashes(body)
    # E6: humanize NON-FICTION before it is persisted, so what is stored is what would publish.
    # Blog and newsletter only — never a chapter or a short story. See writer_engine.humanize.
    body, humanize_report = await humanize_draft(body, content_type="blog_post", payload=payload)
    persist = await _persist_simple(
        payload,
        title=title,
        content_type="blog_post",
        content_text=body,
        genre_slug=genre_slug,
        metadata={**meta, **({"humanize": humanize_report} if humanize_report else {})},
    )
    return {
        "written": True,
        "title": title,
        "content_text": body,
        "word_count": len(body.split()),
        "humanize": humanize_report,
        "persist": persist,
    }


async def _op_newsletter(payload: dict) -> dict:
    """One-shot topic newsletter (n8n write_newsletter parity): genre-aware, Perplexity-researched
    (citation URLs preserved), structured as subject_line / pre_header / intro / sections / outro, and
    persisted to published_content_v2 (content_type=newsletter). This is the topic newsletter the suite
    drives (R07/R16/R44) — distinct from the F2 curated multi-story saga (newsletter_sends)."""
    import json as _json

    from writer_engine.config import get_settings

    settings = get_settings()
    topic = str(payload.get("topic") or payload.get("message") or "").strip()
    genre_slug = str(payload.get("genre_slug") or payload.get("genre") or "")
    send_date = str(payload.get("date") or payload.get("send_date") or "")
    genre_name, guidelines = await _load_genre_guidelines(genre_slug)
    research, _ = (
        await _chapter_research(
            topic,
            period="contemporary",
            title=topic,
            focus=f"Genre: {genre_slug}. Newsletter topic: {topic}",
        )
        if topic
        else ("", [])
    )
    model = _polish_model(payload, settings)
    system = (
        f"You are an expert newsletter writer specializing in {genre_name}.\n\n## Genre Guidelines\n"
        f"{guidelines}\n\n## Writing Prime Directive\n{_PRIME_DIRECTIVE}\n\n## Requirements\n"
        "- A compelling subject_line and a short pre_header teaser\n"
        "- An intro that hooks the reader\n"
        "- 3-5 sections, each {heading, body}, each covering a distinct facet of the topic\n"
        "- Preserve any source URLs from the research as inline references where relevant\n"
        "- An outro with a call to action or discussion prompt\n\n"
        "Return strict JSON: {subject_line, pre_header, intro, sections:[{heading, body}], outro, title}."
    )
    prompt = (
        f"Write a newsletter about: {topic}\nGenre: {genre_name}\n\n"
        f"## Research Context (preserve citation URLs)\n{research}"
    )
    try:
        resp = await get_router(service=STEP_NAME).complete(
            provider="anthropic", model=model, system=system, prompt=prompt, max_tokens=8192
        )
    except ProviderNotRegistered:
        return {"written": False, "reason": "no provider"}
    data: dict = {}
    try:
        m = re.search(r"\{.*\}", resp.text, re.S)
        data = _json.loads(m.group(0)) if m else {}
    except Exception:
        data = {}
    subject_line = str(data.get("subject_line") or (topic[:80] or "Newsletter"))
    title = str(data.get("title") or subject_line)
    sections = [s for s in (data.get("sections") or []) if isinstance(s, dict)]
    parts: list[str] = []
    if data.get("pre_header"):
        parts.append(f"_{data['pre_header']}_")
    if data.get("intro"):
        parts.append(str(data["intro"]))
    for sec in sections:
        parts.append(f"## {sec.get('heading', '')}\n\n{sec.get('body', '')}")
    if data.get("outro"):
        parts.append(str(data["outro"]))
    body = _strip_em_dashes("\n\n".join(p for p in parts if p).strip() or resp.text.strip())
    body, humanize_report = await humanize_draft(body, content_type="newsletter", payload=payload)
    meta = {
        "subject_line": subject_line,
        "pre_header": data.get("pre_header"),
        "send_date": send_date,
        "section_count": len(sections),
    }
    if humanize_report:
        meta["humanize"] = humanize_report
    persist = await _persist_simple(
        payload,
        title=title,
        content_type="newsletter",
        content_text=body,
        genre_slug=genre_slug,
        metadata=meta,
    )
    return {
        "written": True,
        "title": title,
        "subject_line": subject_line,
        "content_text": body,
        "word_count": len(body.split()),
        "section_count": len(sections),
        "humanize": humanize_report,
        "persist": persist,
    }


async def _op_short_story(payload: dict) -> dict:
    """One-shot short story (n8n write_short_story parity): genre + story arc, written from a premise
    or a brainstormed 3-beat outline, researched, with scene breaks."""
    from writer_engine.config import get_settings

    settings = get_settings()
    # Prefer a stored/brainstormed outline (premise + 3-beat structure); fall back to a raw premise.
    ctx = (
        await _load_context(str(payload.get("project_id") or "00000000-0000-0000-0000-000000000000"), payload)
        if payload.get("project_id")
        else _apply_ctx_overrides(
            {"genre_slug": payload.get("genre_slug") or "", "title": "", "outline": {}, "roster": []}, payload
        )
    )
    outline = ctx.get("outline") or {}
    premise = str(payload.get("premise") or outline.get("premise") or payload.get("message") or "").strip()
    genre_slug = str(ctx.get("genre_slug") or payload.get("genre_slug") or "")
    genre_name, guidelines = await _load_genre_guidelines(genre_slug)
    title = str(
        outline.get("title")
        or payload.get("title")
        or (premise.split(".")[0][:60] if premise else "Untitled")
    )
    length = _coerce_int(payload.get("length"), 3000)  # G6: router may pass "2500 words"
    arc = _arc_summary(outline) if outline.get("chapters") or outline.get("story_arc_name") else ""
    research, _ = (
        await _chapter_research(
            premise,
            period=str(payload.get("period") or "contemporary"),
            title=title,
            focus=_research_focus(ctx) or f"Genre: {genre_slug}. Premise: {premise}",
        )
        if premise
        else ("", [])
    )
    structure = ""
    if outline.get("chapters"):
        structure = "## Story Outline (follow exactly)\n" + "\n".join(
            f"Beat {c.get('chapter_number') or c.get('number') or i}: {c.get('title', '')} — "
            f"{c.get('beat') or c.get('brief', '')}"
            for i, c in enumerate(outline["chapters"], 1)
        )
    model = _polish_model(payload, settings)
    system = (
        f"You are a world-class {genre_name} author.\n\n## Genre Guidelines\n{guidelines}\n\n"
        f"## Writing Prime Directive\n{_PRIME_DIRECTIVE}\n\n"
        + (f"## Story Arc\n{arc}\n\n" if arc else "")
        + "## Structure\nWrite a complete short story with natural scene breaks (use --- between scenes): "
        "(1) Opening — establish the world and protagonist; (2) Rising action — develop conflict and "
        "character; (3) Climax and resolution. Write the story text directly: no JSON, no metadata, "
        "no scene labels."
    )
    prompt = (
        f'Write a complete short story titled "{title}" of approximately {length} words.\n\n'
        f"Premise: {premise}\nTone: {payload.get('tone') or 'fitting the genre'}\n"
        f"{structure}\n\n## Research\n{research}"
    )
    try:
        resp = await get_router(service=STEP_NAME).complete(
            provider="anthropic", model=model, system=system, prompt=prompt, max_tokens=16384, stream=True
        )
    except ProviderNotRegistered:
        return {"written": False, "reason": "no provider"}
    body = _strip_em_dashes(_strip_scaffolding(resp.text.strip()))
    # NOT humanized, deliberately. A short story is fiction, and the measurement that settled this
    # (2026-10-17, a real 1431-word scene) showed both StealthGPT modes destroying the researched
    # period vocabulary a scene is grounded in: maize -> corn, packed earth -> flat stone, with
    # clay jar / thatch / sleeping mat / stars simply gone. Blog and newsletter are humanized; this
    # is not. If that ever changes it needs a protect list built from the project's canon.
    persist = await _persist_simple(
        payload,
        title=title,
        content_type="short_story",
        content_text=body,
        genre_slug=genre_slug,
        metadata={"premise": premise},
    )
    return {
        "written": True,
        "title": title,
        "content_text": body,
        "word_count": len(body.split()),
        "persist": persist,
    }


# ----------------------------------------------------------------------------------------------
# Volume planning: where does a 600,000-word manuscript become three printed books?
# ----------------------------------------------------------------------------------------------

VOLUME_ENDING_TAIL_WORDS = 1200
"""How much of a chapter's close to judge. The question is what the last pages do, not the chapter."""


def _build_volume_ending_system() -> str:
    """The reviewer that decides whether a chapter can END A VOLUME."""
    return (
        "You are deciding whether a chapter can be the LAST CHAPTER OF A PRINTED VOLUME in a "
        "multi-volume novel. The reader will close the book here and must choose whether to buy the "
        "next one.\n\n"
        "This is NOT the question 'is this a good chapter'. A chapter can be the best in the book and "
        "the worst possible place to stop, because it finishes things. Judge only the ending.\n\n"
        "SCORE HIGH (0.8-1.0) when the closing pages leave a reader unable to stop: a question asked "
        "and not answered, a reversal whose cost has not yet been paid, a decision taken but not "
        "acted on, someone arriving, a threat already in motion, a discovery that reframes what came "
        "before.\n"
        "SCORE LOW (0.0-0.3) when the closing pages tie off: a resolution, a summary, a farewell, a "
        "character at peace, a time-skip that releases tension, any sentence that functions as 'and "
        "so it was finished'.\n"
        "MIDDLE (0.4-0.7) for an ending that is merely a stopping place — nothing resolved, but "
        "nothing pulling either.\n\n"
        "Set `resolves` true when the passage ties things off, even if it is otherwise strong — that "
        "is the signal that this is the wrong place to break a volume.\n"
        "`unresolved` names in ONE sentence what is left hanging, or is empty if nothing is.\n"
        "`reason` is one sentence on why it does or does not work as an ending.\n\n"
        "Reply with strict JSON matching VolumeEndingJudgement "
        "{cliffhanger, unresolved, reason, resolves}."
    )


async def _judge_volume_ending(tail: str, chapter_number: int, title: str) -> VolumeEndingJudgement | None:
    """Judge one candidate ending. None when it could not be scored."""
    from writer_engine.config import get_settings

    if not tail.strip():
        return None
    router = get_router(service=STEP_NAME)
    try:
        judgement, _resp = await complete_structured(
            router,
            provider="anthropic",
            model=get_settings().model_default,
            system=_build_volume_ending_system(),
            prompt=(f"CHAPTER {chapter_number} — {title}\n\nThese are its CLOSING pages:\n\n{tail}"),
            schema=VolumeEndingJudgement,
            max_tokens=1024,
        )
        return judgement
    except ProviderNotRegistered:
        return None
    except ValueError as exc:
        logger.warning("volume.ending_unparseable", chapter=chapter_number, error=str(exc)[:200])
        return None


async def _op_plan_volumes(payload: dict) -> dict:
    """Split a project into printed volumes, choosing breaks on story rather than page count.

    The page cap is a CONSTRAINT (KDP stops at 828 pages); ending strength is the OBJECTIVE. Only
    chapters inside a feasible split window are sent to the judge — scoring all 96 to decide two
    boundaries would be most of a book's worth of calls.

    `persist` writes the plan to the project outline under `_volume_plan`, where the export reads it.
    """
    from writer_engine.supabase.client import get_supabase_admin
    from writer_engine.volumes import (
        ChapterInfo,
        compare_trims,
        minimum_volumes,
        plan_volumes,
        split_candidates,
    )

    project_id = str(payload.get("project_id") or "")
    if not project_id:
        return {"planned": False, "reason": "project_id required"}
    trim = str(payload.get("trim") or "6x9")
    requested = payload.get("volume_count")
    judge = payload.get("judge_endings", True) is not False

    client = await get_supabase_admin()
    rows: list[dict] = []
    page = 0
    while True:
        r = await (
            client.table("published_content_v2")
            .select("chapter_number,title,content_text")
            .eq("project_id", project_id)
            .eq("content_type", "chapter")
            .is_("deleted_at", None)
            .order("chapter_number")
            .range(page * 1000, page * 1000 + 999)
            .execute()
        )
        batch = getattr(r, "data", None) or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        page += 1
    rows = [x for x in rows if str(x.get("content_text") or "").strip()]
    if not rows:
        return {"planned": False, "reason": "no chapters with text"}

    chapters: list[ChapterInfo] = []
    for x in rows:
        text = str(x.get("content_text") or "")
        words = text.split()
        chapters.append(
            ChapterInfo(
                number=_coerce_chapter_number(x.get("chapter_number"), 0),
                title=str(x.get("title") or ""),
                words=len(words),
                tail=" ".join(words[-VOLUME_ENDING_TAIL_WORDS:]),
            )
        )

    n_vol = int(requested) if requested else minimum_volumes(chapters, trim)
    judged = 0
    if judge and n_vol > 1:
        candidates = split_candidates(chapters, trim=trim, volume_count=n_vol)
        # The last chapter is the end of the BOOK; it is allowed to resolve, and is never a break.
        candidates = [i for i in candidates if i < len(chapters) - 1]
        sem = asyncio.Semaphore(6)

        async def judge_one(idx: int) -> None:
            nonlocal judged
            info = chapters[idx]
            async with sem:
                verdict = await _judge_volume_ending(info.tail, info.number, info.title)
            if verdict is None:
                return
            # A chapter that ties things off is a bad break however strong it reads.
            info.cliffhanger = min(verdict.cliffhanger, 0.25) if verdict.resolves else verdict.cliffhanger
            info.cliffhanger_reason = verdict.reason or verdict.unresolved
            judged += 1

        await asyncio.gather(*[judge_one(i) for i in candidates])
        logger.info("volume.endings_judged", candidates=len(candidates), judged=judged)

    plan = plan_volumes(chapters, trim=trim, volume_count=int(requested) if requested else None)
    out = plan.as_dict()
    out["judged_candidates"] = judged
    # Every trim and what it costs, so the choice is made with the consequence visible rather than
    # inherited from a default. Trim decides how many books this becomes.
    out["trim_options"] = compare_trims(chapters)

    if payload.get("persist") and plan.volumes:
        try:
            pr = (
                await client.table("writing_projects_v2")
                .select("outline")
                .eq("id", project_id)
                .limit(1)
                .execute()
            )
            prows = getattr(pr, "data", None) or []
            outline = dict((prows or [{}])[0].get("outline") or {})
            outline["_volume_plan"] = out
            # touch() stamps updated_at. An outline write that leaves it alone is invisible to the
            # freshness probe's cheapest signal, so nothing reindexes against the change.
            from writer_engine.persist_helpers import touch

            await (
                client.table("writing_projects_v2")
                .update({"outline": outline, **touch()})
                .eq("id", project_id)
                .execute()
            )
            out["persisted"] = True
        except Exception as exc:
            logger.warning("volume.persist_failed", error=str(exc)[:200])
            out["persisted"] = False
    return out


OPS = {
    "write": _op_write,
    "plan": _op_plan,
    "plan-volumes": _op_plan_volumes,
    "rewrite": _op_rewrite,
    "repair": _op_repair,
    "qa": _op_qa,
    "review": _op_review,
    "scan-drift": _op_scan_drift,
    "evaluate-genre": _op_evaluate_genre,
    "extract-bible": _op_extract_bible,
    "blog": _op_blog,
    "newsletter": _op_newsletter,
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
    # CR-007 accounting now lives in the step-service template (A4), which wraps every step's /run
    # and injects the usage into payload["result"]["token_usage"] — the same place this used to, and
    # the place notifications.task_email reads. Keeping a second begin()/flush() here would reset
    # the template's context mid-request.
    result = await OPS[op](inp.payload)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": result},
    )


app = build_step_app(STEP_NAME, handler)
