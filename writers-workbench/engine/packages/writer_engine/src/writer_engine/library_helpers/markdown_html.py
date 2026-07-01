"""Minimal, dependency-free markdown → HTML for outbound email bodies.

The engine has no markdown package and email clients want simple, inline-friendly HTML. This renders
the subset real content uses: ATX headings (`#`..`###`), unordered (`- `/`* `) and ordered (`1. `)
lists (grouped into `<ul>`/`<ol>`), `**bold**` / `*italic*`, paragraphs, and blank-line breaks.
Everything is HTML-escaped first so user/content text can't inject markup. Used by
``library.email-content`` (CR-010 A2 / E2E-1); render_step keeps its own newsletter-specific renderer.
"""

from __future__ import annotations

import re
from html import escape

_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITALIC = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)")
_ORDERED = re.compile(r"^\s*\d+\.\s+(.*)$")
_UNORDERED = re.compile(r"^\s*[-*]\s+(.*)$")
_HEADING = re.compile(r"^\s*(#{1,3})\s+(.*)$")  # G5: tolerate leading whitespace before ## / ###


def _inline(text: str) -> str:
    """Escape HTML, then apply inline bold/italic on the escaped text."""
    out = escape(text)
    out = _BOLD.sub(r"<strong>\1</strong>", out)
    out = _ITALIC.sub(r"<em>\1</em>", out)
    return out


def markdown_to_html(md: str) -> str:
    """Render a markdown string to a compact HTML fragment (headings, lists, bold/italic, paragraphs)."""
    lines = (md or "").split("\n")
    out: list[str] = []
    list_mode: str | None = None  # "ul" | "ol" | None

    def close_list() -> None:
        nonlocal list_mode
        if list_mode:
            out.append(f"</{list_mode}>")
            list_mode = None

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            close_list()
            continue

        h = _HEADING.match(line)
        if h:
            close_list()
            level = len(h.group(1))
            out.append(f"<h{level}>{_inline(h.group(2))}</h{level}>")
            continue

        om = _ORDERED.match(line)
        if om:
            if list_mode != "ol":
                close_list()
                out.append("<ol>")
                list_mode = "ol"
            out.append(f"<li>{_inline(om.group(1))}</li>")
            continue

        um = _UNORDERED.match(line)
        if um:
            if list_mode != "ul":
                close_list()
                out.append("<ul>")
                list_mode = "ul"
            out.append(f"<li>{_inline(um.group(1))}</li>")
            continue

        close_list()
        out.append(f"<p>{_inline(line)}</p>")

    close_list()
    return "\n".join(out)
