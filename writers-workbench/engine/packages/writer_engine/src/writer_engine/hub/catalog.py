"""Hub tool catalog — the single source of truth for what the engine hub can route to.

Each entry maps a user intent onto an engine ``tool.op`` and declares its ``kind``:

* ``info``  — fast, read-mostly (retrieve / list / lifecycle). Dispatched **synchronously**;
  the hub returns the data in the same response.
* ``task``  — load-bearing generation (chapter / brainstorm / research / media). Dispatched
  **async** onto the arq queue (CR-003); the hub returns ``{job_id, status:"queued"}`` immediately.

The same list is rendered into the Gemini router's system prompt (so the model picks from exactly
the tools that exist) and consulted by ``dispatch.build_dispatch_plan`` to decide sync vs async.
Keep it in lockstep with each step service's ``OPS`` dict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Kind = Literal["info", "task"]


@dataclass(frozen=True)
class ToolSpec:
    """One routable capability: a (tool, op) pair plus how to dispatch and call it."""

    tool: str
    op: str
    kind: Kind
    intent: str
    """Plain-language trigger shown to the router so it knows when to pick this."""
    params: tuple[str, ...] = ()
    """Param names the router should try to extract from the message (best-effort)."""
    required: tuple[str, ...] = ()
    """Params that must be present (from the message or conversation context) to dispatch."""
    aliases: tuple[str, ...] = field(default_factory=tuple)
    """Extra names the router may emit for this op (defensive mapping)."""

    @property
    def name(self) -> str:
        return f"{self.tool}.{self.op}"


# Ordered by routing specificity — retrieve/list/lifecycle (info) before generation (task) so the
# router prefers a cheap read when the message is ambiguous ("revert outline" must not brainstorm).
CATALOG: tuple[ToolSpec, ...] = (
    # ---------- info (synchronous) ----------
    ToolSpec(
        "library",
        "list-outlines",
        "info",
        intent="list/show all outlines, drafts, projects, or chapters the user has",
        params=("content_type",),
        aliases=("list", "list_content", "list-content", "list_outlines"),
    ),
    ToolSpec(
        "library",
        "retrieve",
        "info",
        intent="retrieve / pull up / open / fetch a specific project, outline, draft, or chapter by title",
        params=("project_title", "content_type", "chapter_number", "search_term"),
        aliases=("retrieve_content", "get", "fetch", "open"),
    ),
    ToolSpec(
        "library",
        "lifecycle",
        "info",
        intent="approve, publish, reject, or schedule a piece of content (no generation, a DB state change)",
        params=("project_title", "action", "schedule_date", "title", "content_type_filter"),
        aliases=(
            "content_action",
            "approve",
            "publish",
            "reject",
            "schedule",
            "delete",
            "undelete",
            "list_deleted",
            "trash",
        ),
    ),
    ToolSpec(
        "library",
        "versions",
        "info",
        intent="show version history / list versions of a piece of content or an outline, or get one "
        "specific version (outline version history, 'version history for <id>', 'get version N of <id>')",
        params=("scope", "mode", "content_id", "project_title", "version_number"),
        aliases=("version_history", "list_versions", "get_version", "outline_versions"),
    ),
    ToolSpec(
        "story_bible",
        "list",
        "info",
        intent="list / show the story bible (series canon, characters, synopsis) for a project",
        params=("project_id", "project_title", "name"),
        aliases=("list_bible", "show_bible"),
    ),
    ToolSpec(
        "story_bible",
        "add",
        "info",
        intent="add a NEW character, place, object, concept or event to a project's story bible "
        "('add a character named Mara Voss to the story bible for X: a salvage pilot', 'put the "
        "Ironhold fortress in the story bible as a place'). entry_type is one of character|place|"
        "object|concept|event",
        params=("project_id", "project_title", "name", "entry_type", "description"),
        aliases=("add_bible_entry", "add_to_bible", "bible_add"),
    ),
    ToolSpec(
        "story_bible",
        "update",
        "info",
        intent="change an EXISTING story bible entry — its description, its name (rename), or its type "
        "('update Mara Voss in the story bible: she is now captain', 'rename Osei to Osei Asante in the "
        "story bible'). name = the entry as it is now; new_name / new_entry_type / description = the "
        "change; mode=append adds to the description instead of replacing it",
        params=(
            "project_id",
            "project_title",
            "name",
            "entry_type",
            "description",
            "new_name",
            "new_entry_type",
            "mode",
        ),
        aliases=("update_bible_entry", "edit_bible_entry", "bible_update"),
    ),
    ToolSpec(
        "media",
        "scrape-url",
        "info",
        intent="scrape / fetch the text content of a URL",
        params=("url",),
        required=("url",),
        aliases=("scrape", "scrape_url"),
    ),
    # ---------- task (async / queued) ----------
    ToolSpec(
        "chapter",
        "write",
        "task",
        intent="write a chapter, prologue, or epilogue (full narrative draft)",
        params=("project_id", "project_title", "chapter_number"),
        aliases=("write_chapter", "write-chapter"),
    ),
    ToolSpec(
        "chapter",
        "plan",
        "task",
        intent="plan a chapter / produce the chapter (sub-beat) outline before writing",
        params=("project_id", "project_title", "chapter_number"),
        aliases=("plan_chapter", "chapter_outline"),
    ),
    ToolSpec(
        "chapter",
        "rewrite",
        "task",
        intent="rewrite or revise an already-written chapter",
        params=("project_id", "project_title", "chapter_number", "directive"),
        aliases=("rewrite_chapter", "revise_chapter"),
    ),
    ToolSpec(
        "chapter",
        "repair",
        "task",
        intent="fix / repair a chapter that has drifted from the outline or roster",
        params=("project_id", "project_title", "chapter_number"),
        aliases=("repair_chapter", "fix_chapter"),
    ),
    ToolSpec(
        "chapter",
        "qa",
        "task",
        intent="run a quality check / craft QA on a chapter",
        params=("project_id", "project_title", "chapter_number"),
        aliases=("qa_chapter", "quality_check"),
    ),
    ToolSpec(
        "chapter",
        "review",
        "task",
        intent=(
            "run a named editorial review lens over a chapter — Hemingway (cut), Sorkin (momentum), "
            "Hitchcock (tension), the hostile reader, a developmental or line edit, the Follett "
            "guardrails, or a whole panel"
        ),
        params=("project_id", "project_title", "chapter_number", "lenses"),
        aliases=("review_chapter", "critique_chapter", "editorial_review"),
    ),
    # NOTE: Kindle/.docx export is NOT an engine op. The Workbench Export tab builds the manuscript
    # server-side (POST /api/export/docx, the `docx` lib) and never calls the engine. The old engine
    # `chapter.format-kindle` op was a stub that returned a fake path, so it was removed (CR-010 A1).
    ToolSpec(
        "brainstorm",
        "story",
        "task",
        intent="brainstorm / outline a new story, book, or novel from a premise",
        params=("genre", "story_arc", "title", "target_chapter_count", "prompt"),
        aliases=("brainstorm_story", "outline_story"),
    ),
    ToolSpec(
        "brainstorm",
        "short-story",
        "task",
        intent="brainstorm / outline a SHORT STORY from a premise (develops a 3-beat structure)",
        params=("premise", "genre", "story_arc", "title"),
        aliases=("brainstorm_short_story", "short_story_outline"),
    ),
    ToolSpec(
        "chapter",
        "blog",
        "task",
        intent="write a blog post about a topic",
        params=("topic", "genre", "keywords", "target_length"),
        aliases=("write_blog", "write_blog_post", "blog_post"),
    ),
    ToolSpec(
        "chapter",
        "newsletter",
        "task",
        intent="write a newsletter about a topic for a genre (subject line, intro, sections, outro)",
        params=("topic", "genre", "genre_slug", "date"),
        aliases=("write_newsletter", "newsletter"),
    ),
    ToolSpec(
        "chapter",
        "short-story",
        "task",
        intent="write a SHORT STORY from a premise or a brainstormed 3-beat outline",
        params=("premise", "genre", "story_arc", "title", "length"),
        aliases=("write_short_story", "short_story"),
    ),
    ToolSpec(
        "brainstorm",
        "revise-outline",
        "task",
        intent="revise / regenerate the whole outline of an existing project",
        params=("project_id", "project_title", "directive"),
        aliases=("revise_outline",),
    ),
    ToolSpec(
        "brainstorm",
        "edit-outline",
        "task",
        intent="make a small, targeted edit to an outline (rename a character, change an age, tweak a beat)",
        params=("project_id", "project_title", "directive"),
        aliases=("edit_outline",),
    ),
    ToolSpec(
        "brainstorm",
        "create-project",
        "task",
        intent="create a new empty project / book record",
        params=("title", "genre"),
        aliases=("create_project", "new_project"),
    ),
    ToolSpec(
        "research",
        "run",
        "task",
        intent="research a topic and produce a research report",
        params=("topic", "project_id", "project_title"),
        aliases=("research_report", "research"),
    ),
    ToolSpec(
        "media",
        "cover-art",
        "task",
        intent="generate cover art / an image for a project",
        params=("project_id", "project_title", "prompt"),
        aliases=("cover_art", "generate_cover"),
    ),
    ToolSpec(
        "media",
        "social-posts",
        "task",
        intent="repurpose content into social media posts",
        params=("project_id", "project_title", "platform"),
        aliases=("repurpose_social", "social"),
    ),
    ToolSpec(
        "notify",
        "eve-callback",
        "task",
        intent="pull up a piece of content and CALL ME BACK by phone to review or brainstorm it "
        "('pull up my X and call me back', '… and call me back to brainstorm')",
        params=("content_type", "search_term", "callback_mode"),
        aliases=("eve_callback", "callback", "call_me_back"),
    ),
    ToolSpec(
        "library",
        "revert",
        "task",
        intent="revert / roll back an outline or a chapter to a previous saved version "
        "('revert the outline for X to version N', 'revert chapter 3 of Y to version 2')",
        params=("scope", "project_title", "chapter_number", "version_number"),
        aliases=("revert_outline", "revert_chapter", "rollback"),
    ),
    # ---------- Content Studio (newsletter admin; only routed from the studio page) ----------
    # The studio ops act on ONE edition the caller owns; the edition always comes from the page's
    # context (dispatch fills it), never from the message. See writer_engine.studio.
    ToolSpec(
        "studio",
        "slate",
        "info",
        intent="CONTENT STUDIO: show this week's radar slate / topics / menu for the edition",
        params=("week_of",),
        aliases=("studio_slate", "show_slate"),
    ),
    ToolSpec(
        "studio",
        "queue",
        "info",
        intent="CONTENT STUDIO: list the drafts, approved posts, or the scheduled queue ('list the queue', "
        "'show my drafts', 'show #3')",
        params=("status", "posts"),
        aliases=("studio_queue", "list_queue"),
    ),
    ToolSpec(
        "studio",
        "update",
        "info",
        intent="CONTENT STUDIO: approve / unapprove / discard / cancel / requeue / unschedule posts, or "
        "turn the image on/off ('approve #3', 'cancel 4', 'no image on #2'). action is one of approve, "
        "unapprove, discard, cancel, requeue, unschedule, image_on, image_off; posts = '#3, 5-7' or 'all'",
        params=("action", "posts"),
        aliases=("studio_update",),
    ),
    ToolSpec(
        "studio",
        "schedule",
        "info",
        intent="CONTENT STUDIO: schedule or publish posts ('schedule all approved', 'schedule #3 tuesday "
        "afternoon', 'publish #5 now'). posts = '#3' | 'approved' | 'drafts'; mode = next|slot|at|now; "
        "day, slot (morning|afternoon), time, channels",
        params=("posts", "mode", "day", "slot", "time", "channels"),
        aliases=("studio_schedule",),
    ),
    ToolSpec(
        "studio",
        "issue",
        "info",
        intent="CONTENT STUDIO: choose the posts in the edition's next newsletter issue ('put 1-6 in this "
        "week's newsletter', 'remove #3 from the newsletter', 'show the newsletter'). action = show|set|add|"
        "remove|new; ranks = slate numbers; posts = post numbers",
        params=("action", "ranks", "posts"),
        aliases=("studio_issue",),
    ),
    ToolSpec(
        "studio",
        "generate",
        "task",
        intent="CONTENT STUDIO: generate / draft posts from slate topics ('generate 1-5 and 8'); numbers = "
        "slate ranks or 'all'",
        params=("numbers", "week_of", "redo"),
        aliases=("studio_generate",),
    ),
    ToolSpec(
        "studio",
        "revise",
        "task",
        intent="CONTENT STUDIO: revise a draft with an instruction ('make #3 shorter'), regenerate it, or "
        "undo the last revision. mode = revise|regenerate|undo",
        params=("posts", "instruction", "mode"),
        aliases=("studio_revise",),
    ),
    ToolSpec(
        "studio",
        "email",
        "task",
        intent="CONTENT STUDIO: email me a draft ('email #3') or the week's slate digest ('email the roundup')",
        params=("posts", "target"),
        aliases=("studio_email",),
    ),
    ToolSpec(
        "studio",
        "batch",
        "task",
        intent="CONTENT STUDIO: TWO OR MORE of the studio actions above in one message, run in order "
        "('make #3 punchier and schedule it thursday afternoon', 'approve #4 and email it to me'). "
        "steps = a list of {op, ...that op's params}, each naming its posts by #number (resolve 'it' to "
        "the post named earlier); at most 4 steps",
        params=("steps",),
        aliases=("studio_batch",),
    ),
    ToolSpec(
        "library",
        "email-content",
        "task",
        intent="email me / send me an email of an EXISTING outline, short story, chapter, newsletter, "
        "research report, or blog — OR email inline content the message provides "
        "('send me an email with this content: …'). NOT for showing/opening content (that is retrieve)",
        params=("content_type", "title", "search_term", "chapter_number", "subject", "recipient", "content"),
        aliases=("email_content", "email_report", "send_email", "email_me", "email"),
    ),
)


_BY_NAME: dict[str, ToolSpec] = {}
for _spec in CATALOG:
    _BY_NAME[_spec.name] = _spec
    if _spec.tool != "studio":
        # bare-op convenience (unique enough across tools we care about). Not for the studio, whose
        # bare ops ("schedule", "email", "generate") are other tools' words.
        _BY_NAME[_spec.op] = _spec
    for _alias in _spec.aliases:
        _BY_NAME.setdefault(_alias, _spec)


def lookup(tool: str | None, op: str | None) -> ToolSpec | None:
    """Resolve a (tool, op) — or an alias the router emitted — to a ToolSpec. Tolerant of either
    field being missing: tries ``tool.op``, then the bare op/alias, then a tool-only default."""
    if tool and op:
        spec = _BY_NAME.get(f"{tool}.{op}")
        if spec:
            return spec
    for key in (op, tool):
        if key and key in _BY_NAME:
            return _BY_NAME[key]
    # tool-only: first op for that tool
    if tool:
        for spec in CATALOG:
            if spec.tool == tool:
                return spec
    return None


STUDIO_TOOL = "studio"


def render_catalog_prompt(*, studio: bool = False) -> str:
    """Render the catalog as a numbered tool menu for the router's system prompt.

    The general chat sees every tool except the studio's (those act on the edition open in the
    Content Studio page, which a chat message has no way to name); the studio page sees only its own.
    """
    lines: list[str] = []
    for spec in CATALOG:
        if (spec.tool == STUDIO_TOOL) != studio:
            continue
        req = f" (requires: {', '.join(spec.required)})" if spec.required else ""
        params = f" — params: {', '.join(spec.params)}" if spec.params else ""
        lines.append(f"- {spec.name} [{spec.kind}]: {spec.intent}{params}{req}")
    return "\n".join(lines)


def tool_names() -> list[str]:
    return [spec.name for spec in CATALOG]
