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
        "library", "list-outlines", "info",
        intent="list/show all outlines, drafts, projects, or chapters the user has",
        params=("content_type",),
        aliases=("list", "list_content", "list-content", "list_outlines"),
    ),
    ToolSpec(
        "library", "retrieve", "info",
        intent="retrieve / pull up / open / fetch a specific project, outline, draft, or chapter by title",
        params=("project_title", "content_type", "chapter_number", "search_term"),
        aliases=("retrieve_content", "get", "fetch", "open"),
    ),
    ToolSpec(
        "library", "lifecycle", "info",
        intent="approve, publish, reject, or schedule a piece of content (no generation, a DB state change)",
        params=("project_title", "action", "schedule_date", "title", "content_type_filter"),
        aliases=("content_action", "approve", "publish", "reject", "schedule",
                 "delete", "undelete", "list_deleted", "trash"),
    ),
    ToolSpec(
        "library", "versions", "info",
        intent="show version history / list versions of a piece of content or an outline, or get one "
        "specific version (outline version history, 'version history for <id>', 'get version N of <id>')",
        params=("scope", "mode", "content_id", "project_title", "version_number"),
        aliases=("version_history", "list_versions", "get_version", "outline_versions"),
    ),
    ToolSpec(
        "story_bible", "list", "info",
        intent="list / show the story bible (series canon, characters, synopsis) for a project",
        params=("project_id", "project_title"),
        aliases=("list_bible", "show_bible"),
    ),
    ToolSpec(
        "media", "scrape-url", "info",
        intent="scrape / fetch the text content of a URL",
        params=("url",),
        required=("url",),
        aliases=("scrape", "scrape_url"),
    ),
    # ---------- task (async / queued) ----------
    ToolSpec(
        "chapter", "write", "task",
        intent="write a chapter, prologue, or epilogue (full narrative draft)",
        params=("project_id", "project_title", "chapter_number"),
        aliases=("write_chapter", "write-chapter"),
    ),
    ToolSpec(
        "chapter", "plan", "task",
        intent="plan a chapter / produce the chapter (sub-beat) outline before writing",
        params=("project_id", "project_title", "chapter_number"),
        aliases=("plan_chapter", "chapter_outline"),
    ),
    ToolSpec(
        "chapter", "rewrite", "task",
        intent="rewrite or revise an already-written chapter",
        params=("project_id", "project_title", "chapter_number", "directive"),
        aliases=("rewrite_chapter", "revise_chapter"),
    ),
    ToolSpec(
        "chapter", "repair", "task",
        intent="fix / repair a chapter that has drifted from the outline or roster",
        params=("project_id", "project_title", "chapter_number"),
        aliases=("repair_chapter", "fix_chapter"),
    ),
    ToolSpec(
        "chapter", "qa", "task",
        intent="run a quality check / craft QA on a chapter",
        params=("project_id", "project_title", "chapter_number"),
        aliases=("qa_chapter", "quality_check"),
    ),
    # NOTE: Kindle/.docx export is NOT an engine op. The Workbench Export tab builds the manuscript
    # server-side (POST /api/export/docx, the `docx` lib) and never calls the engine. The old engine
    # `chapter.format-kindle` op was a stub that returned a fake path, so it was removed (CR-010 A1).
    ToolSpec(
        "brainstorm", "story", "task",
        intent="brainstorm / outline a new story, book, or novel from a premise",
        params=("genre", "story_arc", "title", "target_chapter_count", "prompt"),
        aliases=("brainstorm_story", "outline_story"),
    ),
    ToolSpec(
        "brainstorm", "short-story", "task",
        intent="brainstorm / outline a SHORT STORY from a premise (develops a 3-beat structure)",
        params=("premise", "genre", "story_arc", "title"),
        aliases=("brainstorm_short_story", "short_story_outline"),
    ),
    ToolSpec(
        "chapter", "blog", "task",
        intent="write a blog post about a topic",
        params=("topic", "genre", "keywords", "target_length"),
        aliases=("write_blog", "write_blog_post", "blog_post"),
    ),
    ToolSpec(
        "chapter", "short-story", "task",
        intent="write a SHORT STORY from a premise or a brainstormed 3-beat outline",
        params=("premise", "genre", "story_arc", "title", "length"),
        aliases=("write_short_story", "short_story"),
    ),
    ToolSpec(
        "brainstorm", "revise-outline", "task",
        intent="revise / regenerate the whole outline of an existing project",
        params=("project_id", "project_title", "directive"),
        aliases=("revise_outline",),
    ),
    ToolSpec(
        "brainstorm", "edit-outline", "task",
        intent="make a small, targeted edit to an outline (rename a character, change an age, tweak a beat)",
        params=("project_id", "project_title", "directive"),
        aliases=("edit_outline",),
    ),
    ToolSpec(
        "brainstorm", "create-project", "task",
        intent="create a new empty project / book record",
        params=("title", "genre"),
        aliases=("create_project", "new_project"),
    ),
    ToolSpec(
        "research", "run", "task",
        intent="research a topic and produce a research report",
        params=("topic", "project_id", "project_title"),
        aliases=("research_report", "research"),
    ),
    ToolSpec(
        "media", "cover-art", "task",
        intent="generate cover art / an image for a project",
        params=("project_id", "project_title", "prompt"),
        aliases=("cover_art", "generate_cover"),
    ),
    ToolSpec(
        "media", "social-posts", "task",
        intent="repurpose content into social media posts",
        params=("project_id", "project_title", "platform"),
        aliases=("repurpose_social", "social"),
    ),
    ToolSpec(
        "library", "revert", "task",
        intent="revert / roll back an outline or a chapter to a previous saved version "
        "('revert the outline for X to version N', 'revert chapter 3 of Y to version 2')",
        params=("scope", "project_title", "chapter_number", "version_number"),
        aliases=("revert_outline", "revert_chapter", "rollback"),
    ),
    ToolSpec(
        "library", "email-content", "task",
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
    _BY_NAME[_spec.op] = _spec  # bare-op convenience (unique enough across tools we care about)
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


def render_catalog_prompt() -> str:
    """Render the catalog as a numbered tool menu for the router's system prompt."""
    lines: list[str] = []
    for spec in CATALOG:
        req = f" (requires: {', '.join(spec.required)})" if spec.required else ""
        params = f" — params: {', '.join(spec.params)}" if spec.params else ""
        lines.append(f"- {spec.name} [{spec.kind}]: {spec.intent}{params}{req}")
    return "\n".join(lines)


def tool_names() -> list[str]:
    return [spec.name for spec in CATALOG]
