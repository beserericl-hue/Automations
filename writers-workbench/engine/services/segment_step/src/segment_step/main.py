"""segment-svc — write one newsletter section per selected story (called once per story for fan-out)."""

from __future__ import annotations

import re

from writer_engine.config import get_settings
from writer_engine.humanize import humanize_draft
from writer_engine.llm import LLMRouter, ProviderNotRegistered, complete_structured, get_router
from writer_engine.prompt_store import get_prompt_store, seed_default_prompts
from writer_engine.prompt_store.n8n_translate import render_live_prompt
from writer_engine.schemas import StepError, StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import StorySegment
from writer_engine.step_service import build_step_app
from writer_engine.telemetry.logging import get_logger

STEP_NAME = "segment"
logger = get_logger("segment_step")
seed_default_prompts()
DEFAULT_MODEL = "claude-sonnet-4-6"


def _fixture(story: dict) -> StorySegment:
    return StorySegment(
        story_title=str(story.get("title") or "Story"),
        newsletter_section_content="Placeholder section content — segment-svc fixture.",
        chosen_image_url=None,
        image_options=[],
    )


async def _write(
    router: LLMRouter,
    story: dict,
    sources: list[dict],
    image_options: list[str],
    model: str,
    *,
    ctx: dict | None = None,
) -> StorySegment:
    store = get_prompt_store()
    system = store.get("newsletter.segment.system")
    ctx = ctx or {}
    src_text = "\n\n".join(f"# {s.get('title', '')}\n{s.get('markdown', '')}" for s in sources)[:8000]
    # A2: the real n8n segment brief (16.5k chars) instead of the placeholder. Image options are not
    # part of the n8n prompt's field set, so they are appended rather than interpolated.
    user = render_live_prompt(
        "newsletter.segment.user_template",
        store,
        story_title=str(story.get("title") or ""),
        story_summary=str(story.get("summary") or ""),
        segment_sources=src_text,
        external_sources=src_text,
        subject_line=str(ctx.get("subject_line") or ""),
        pre_header=str(ctx.get("pre_header") or ""),
        newsletter_date=str(ctx.get("newsletter_date") or ""),
    )
    genre = str(ctx.get("genre") or "").strip()
    if genre and genre.lower() not in ("ai", "ai-news", "ai-marketing"):
        # The live n8n brief was written for the AI newsletter ("AI that helps professionals..."). On
        # a themed edition the model refused to write the section at all ({"error": "...no
        # connection to AI..."}), so the edition's own theme is stated and takes precedence.
        name = str(ctx.get("newsletter_name") or "this newsletter")
        user += (
            f"\n\nEDITION THEME (takes precedence over any instruction above about AI): this section "
            f"is for {name}, a newsletter about {genre.replace('-', ' ')}. Write the section about "
            "the story's own subject, from the sources given, in the same section format. Do not "
            "require or invent an AI angle."
        )
    if image_options:
        user += "\n\nAVAILABLE IMAGE URLS (choose at most one):\n" + "\n".join(image_options)
    segment, response = await complete_structured(
        router,
        provider="anthropic",
        model=model,
        system=system,
        prompt=user,
        schema=StorySegment,
    )
    if not segment.newsletter_section_content.strip():
        # Diagnostic for the EMPTY_SEGMENT error the handler returns: what did the model send?
        logger.warning(
            "segment.empty_reply",
            story=str(story.get("title") or "")[:80],
            reply_head=str(getattr(response, "text", "") or "")[:400],
        )
    return segment


async def handler(inp: StepInput) -> StepOutput:
    story = dict(inp.payload.get("story") or {})
    sources = list(inp.payload.get("sources") or [])
    image_options = [str(u) for u in (inp.payload.get("image_options") or [])]
    model = str(inp.payload.get("model") or DEFAULT_MODEL)
    router = get_router(service=STEP_NAME)
    fixture = False
    try:
        seg = await _write(
            router,
            story,
            sources,
            image_options,
            model,
            ctx={
                "subject_line": inp.payload.get("subject_line"),
                "pre_header": inp.payload.get("pre_header"),
                "newsletter_date": inp.payload.get("newsletter_date"),
                "genre": inp.payload.get("genre"),
                "newsletter_name": inp.payload.get("newsletter_name"),
            },
        )
    except ProviderNotRegistered:
        seg = _fixture(story)
        fixture = True
    # The model sometimes omits the title; backfill the authoritative story title so downstream
    # stages (image gate, chosen-image matching, assemble) can key on it reliably.
    if not seg.story_title:
        seg.story_title = str(story.get("title") or "Story")
    if not fixture and not seg.newsletter_section_content.strip():
        # An empty section is a failure, not a result. Returned as OK it was assembled into
        # editions with no story sections at all (every DEV send from 2026-10-24 to 2026-11-02, when
        # the model named the field "segment"); as an ERROR the saga stops and says why.
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error=StepError(
                code="EMPTY_SEGMENT",
                message=(
                    f"segment model returned no section text for {seg.story_title!r} "
                    "(its reply is logged as segment.empty_reply; a refusal usually means the story "
                    "does not fit the edition's brief)"
                ),
            ),
            payload={},
        )
    humanize_report = None if fixture else await _humanize_section(seg, inp.payload)
    out = seg.model_dump(mode="json")
    # Recorded beside the segment, not on StorySegment: that model is also the schema the LLM fills,
    # and a "humanize" field there would invite the model to invent one.
    out["humanize"] = humanize_report
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=out,
    )


async def _humanize_section(seg: StorySegment, payload: dict) -> dict | None:
    """E6 for the newsletter saga: humanize the story section before it is assembled.

    Same guards as every other non-fiction pass (writer_engine.humanize): protected terms and links,
    structure, the collapse retry, and the spend ceiling — here the saga passes what is left of the
    WHOLE newsletter's ceiling (``humanize_budget_words``) so five sections cannot each spend the
    full per-run cap. Off with HUMANIZE_NEWSLETTER_SEGMENTS=false, or per run with
    ``humanize: false``. Returns the report (None = the pass did not run).
    """
    if not get_settings().humanize_newsletter_segments or not seg.newsletter_section_content.strip():
        return None
    raw_budget = payload.get("humanize_budget_words")
    budget = int(raw_budget) if isinstance(raw_budget, int) and not isinstance(raw_budget, bool) else None
    original = seg.newsletter_section_content
    # The section is a template: "# Title", "**The Recap:** ...", "**Unpacked:**" + bullets,
    # "**Bottom line:** ...". Measured on DEV 2026-11-02, StealthGPT drops every bold label, and as
    # protected terms the labels ("Recap") got every section rejected (5 of 5, 1,678 words billed,
    # nothing kept). So only the prose goes to the humanizer; headings and labels stay put and are
    # put back by position. A rewrite that changes the paragraph or bullet layout is not used.
    fixed, prose = _split_section(original)
    prose_text = "\n\n".join(prose)
    rewritten, report = await humanize_draft(
        prose_text,
        content_type="newsletter_segment",
        payload=payload,
        budget_words=budget,
    )
    if report is None:
        return None
    new_prose = [p.strip() for p in re.split(r"\n\s*\n", rewritten.strip()) if p.strip()]
    if not report.get("applied") or rewritten.strip() == prose_text.strip():
        seg.newsletter_section_content = original
        return report
    if len(new_prose) != len(prose):
        # StealthGPT sometimes puts a blank line between list items. Same items, same order: put
        # the list back together. Only whole bullet paragraphs are merged, and the bullet count of
        # every block is still checked below, so a dropped or merged item still gets rejected.
        new_prose = _merge_split_bullets(new_prose)
    reason = _layout_change(prose, new_prose)
    if reason:
        # Recorded where every other rejection is (report["rejected"]), so the send's humanize
        # summary says WHY this section kept its original, not just "applied=false".
        rejected = {str(k): v for k, v in (report.get("rejected") or {}).items()}
        rejected["layout"] = reason
        report["rejected"] = rejected
        report["rejected_layout"] = {"paragraphs": [len(prose), len(new_prose)], "reason": reason}
        report["applied"] = False
        logger.warning(
            "humanize.rejected",
            content_type="newsletter_segment",
            story_title=seg.story_title,
            chunk="layout",
            reason=reason,
        )
        seg.newsletter_section_content = original
        return report
    seg.newsletter_section_content = _join_section(fixed, new_prose)
    return report


def _layout_change(before: list[str], after: list[str]) -> str:
    """Why the rewritten prose cannot be put back by position ("" = it can)."""
    if len(after) != len(before):
        return f"layout_changed:paragraphs:{len(before)}->{len(after)}"
    for i, (a, b) in enumerate(zip(before, after, strict=True)):
        if _bullets(a) != _bullets(b):
            return f"layout_changed:bullets[{i}]:{_bullets(a)}->{_bullets(b)}"
    return ""


def _is_bullet_block(paragraph: str) -> bool:
    """Every line is a list item (or a wrapped continuation of one)."""
    lines = [ln for ln in paragraph.splitlines() if ln.strip()]
    return bool(lines) and lines[0].lstrip().startswith(("- ", "* "))


def _merge_split_bullets(paragraphs: list[str]) -> list[str]:
    """Rejoin a list whose items came back as separate paragraphs ("- a\n\n- b" -> "- a\n- b")."""
    merged: list[str] = []
    for para in paragraphs:
        if merged and _is_bullet_block(para) and _is_bullet_block(merged[-1]):
            merged[-1] = merged[-1] + "\n" + para
        else:
            merged.append(para)
    return merged


_LABEL_RE = re.compile(r"\*\*[^*\n]{1,40}:\*\*")


def _bullets(paragraph: str) -> int:
    return sum(1 for line in paragraph.splitlines() if line.lstrip().startswith(("- ", "* ")))


def _split_section(text: str) -> tuple[list[tuple[str, int | None]], list[str]]:
    """Paragraphs -> a layout of (fixed prefix, index of its prose or None) and the prose list."""
    layout: list[tuple[str, int | None]] = []
    prose: list[str] = []
    for para in [p for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]:
        stripped = para.strip()
        if stripped.startswith("#") or _LABEL_RE.fullmatch(stripped):
            layout.append((stripped, None))
            continue
        m = re.match(r"(\*\*[^*\n]{1,40}:\*\*)\s*", stripped)
        prefix = m.group(1) + " " if m else ""
        body = stripped[m.end() :] if m else stripped
        if not body.strip():
            layout.append((stripped, None))
            continue
        layout.append((prefix, len(prose)))
        prose.append(body)
    return layout, prose


def _join_section(layout: list[tuple[str, int | None]], prose: list[str]) -> str:
    return "\n\n".join(prefix + prose[idx] if idx is not None else prefix for prefix, idx in layout)


def section_labels(text: str) -> list[str]:
    """The bold format labels a section is built from, e.g. ``**The Recap:**``."""
    return list(dict.fromkeys(_LABEL_RE.findall(text)))


app = build_step_app(STEP_NAME, handler)
