"""Load a story-arc definition (the structural beats) from ``story_arcs_v2`` (E2E-4).

Arcs were referenced by NAME only — the actual beats (Hero's Journey stages, Ki/Shō/Ten/Ketsu, the
8 Story-Circle beats, Fichtean rising line) were never injected, so generated outlines/chapter plans
couldn't honour them. This loads the arc's ``prompt_text`` so brainstorm.story and chapter.plan can
ground the arc_beat / arc_notes in the real structure. Best-effort: returns ``(name, "")`` on miss.
"""

from __future__ import annotations

from typing import Any


async def load_story_arc(client: Any, name: str | None) -> tuple[str, str]:
    """Resolve an arc name to ``(canonical_name, prompt_text)`` via a case-insensitive match on
    ``story_arcs_v2.name``. Returns ``(name or "", "")`` when there's no client, no name, or no row."""
    if not client or not name or not str(name).strip():
        return (str(name or ""), "")
    term = str(name).strip()
    try:
        resp = await (
            client.table("story_arcs_v2").select("name,description,prompt_text")
            .ilike("name", f"%{term}%").limit(1).execute()
        )
        rows = getattr(resp, "data", None) or []
        if rows:
            r = rows[0]
            return (r.get("name") or term, str(r.get("prompt_text") or r.get("description") or ""))
    except Exception:
        pass
    return (term, "")


def arc_prompt_block(label: str, name: str, prompt_text: str) -> str:
    """Render an arc definition into a labelled prompt block (empty string when there's nothing)."""
    if not name and not prompt_text:
        return ""
    body = f"\n{prompt_text}" if prompt_text else ""
    return f"{label}: {name}{body}".rstrip()
