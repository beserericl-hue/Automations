"""Render a story outline (the ``writing_projects_v2.outline`` JSONB) to readable markdown.

Shared by ``library.email-content`` and the brainstorm completion email so the emailed outline is
the actual structured work (premise + characters + numbered chapters), not raw JSON or a bare notice.

G20: the chapter dicts an outline carries use varied keys across brainstorm/revise/plan
(``chapter_number`` vs ``number``, ``beat`` vs ``summary``/``brief``); render tolerates all of them so
no chapter comes out as a blank ``. **Title** —`` line.
"""

from __future__ import annotations

from typing import Any


def _chapter_num(ch: dict[str, Any]) -> str:
    for k in ("chapter_number", "number", "chapter", "index"):
        v = ch.get(k)
        if v is not None and str(v) != "":
            return str(v)
    return ""


def _chapter_beat(ch: dict[str, Any]) -> str:
    for k in ("beat", "summary", "brief", "description", "arc_notes"):
        v = ch.get(k)
        if v:
            return str(v)
    return ""


def render_outline_markdown(outline: dict[str, Any] | None, title: str = "") -> str:
    """Premise + story arc + characters + numbered chapters as markdown."""
    o = outline or {}
    lines: list[str] = [f"# {o.get('title') or title or 'Outline'}", ""]
    if o.get("premise"):
        lines += [str(o["premise"]), ""]
    if o.get("dramatic_question"):
        lines += [f"**Dramatic question:** {o['dramatic_question']}", ""]
    if o.get("story_arc_name"):
        lines += [f"**Story arc:** {o['story_arc_name']}", ""]
    themes = o.get("themes") or []
    if themes:
        lines += [f"**Themes:** {', '.join(str(t) for t in themes)}", ""]
    chars = o.get("characters") or []
    if chars:
        lines += ["## Characters", ""]
        for c in chars:
            if isinstance(c, dict):
                desc = c.get("description") or c.get("role") or ""
                lines.append(f"- **{c.get('name', 'Unnamed')}** — {desc}")
            elif c:
                lines.append(f"- {c}")
        lines.append("")
    chapters = o.get("chapters") or []
    if chapters:
        lines += ["## Chapters", ""]
        for ch in chapters:
            if not isinstance(ch, dict):
                continue
            num = _chapter_num(ch)
            ttl = ch.get("title", "")
            beat = _chapter_beat(ch)
            prefix = f"{num}. " if num else "- "
            line = f"{prefix}**{ttl}**" if ttl else prefix.rstrip()
            if beat:
                line += f" — {beat}"
            lines.append(line)
        lines.append("")
    return "\n".join(lines).strip() or "# Outline\n\n(empty outline)"
