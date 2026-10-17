"""One reader for the two outline shapes in the data.

Measured on DEV 2026-10-17 across 26 projects with outlines. Chapter entries come in two mutually
exclusive shapes, because two different producers wrote them:

    ENGINE shape (16 projects, incl. The Burial Mound, The Last Ship, The Last Breath)
        chapter_number · title · act · arc_point · pov_character · beat · bridge_from_prior

    n8n shape (10 projects, incl. The Clockwork Rebellion, The Invisible Wall)
        number · title · brief · arc_notes · chapter_outline · research_topics

Every reader in the codebase understood exactly one of them, and they disagreed about which:

    chapter_step._compact_outline_view   keyed on `chapter_number`  -> blind to the n8n shape
    embeddings.build_canon_chunks        keyed on `number`          -> blind to the engine shape

The consequences were both real and both invisible, because each failure mode is a silent empty
string rather than an error:

* An n8n-shaped project got NO "THIS CHAPTER" block in the write prompt — no beat, no brief, no
  bridge from the prior chapter. The writer saw the premise, the arc and a chapter index whose
  numbers all rendered as "None".
* An engine-shaped project got NO chapter_brief and NO sub_chapter canon chunks, so vector
  retrieval had nothing of the story's own structure to return. That is why, of 26 projects with
  outlines, only the n8n-shaped ones had any rows in writing_embeddings_v2 at all.

So the accessors live here, once, and both readers use them. A third reader cannot drift again.
"""

from __future__ import annotations

from typing import Any

# Ordered by preference. `chapter_number` first because it is what the engine writes today.
NUMBER_KEYS = ("chapter_number", "number")

# The chapter's own instruction to the writer. `beat` is the engine's word, `brief` is n8n's;
# `summary` appears in hand-edited outlines.
BODY_KEYS = ("beat", "brief", "summary")

# Extra context worth carrying when present. `bridge_from_prior` matters most: it is the ONLY field
# that tells a chapter how it connects to the one before it, and cross-chapter continuity otherwise
# depends entirely on a titles-only index.
CONTEXT_KEYS = ("act", "arc_point", "pov_character", "bridge_from_prior", "arc_notes")


def chapter_number(entry: Any) -> int | None:
    """The entry's chapter number under either key, or None when it has neither."""
    if not isinstance(entry, dict):
        return None
    for key in NUMBER_KEYS:
        value = entry.get(key)
        if value is None or value == "":
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def chapter_body(entry: Any) -> str:
    """The chapter's instruction text under whichever key this shape uses."""
    if not isinstance(entry, dict):
        return ""
    for key in BODY_KEYS:
        text = str(entry.get(key) or "").strip()
        if text:
            return text
    return ""


def matches(entry: Any, number: int | str) -> bool:
    """Whether ``entry`` is the outline entry for chapter ``number``.

    Compared as integers, not strings: a stored "04" or 4.0 is still chapter 4, and the old
    ``str(num) == str(chapter_number)`` comparison treated those as different chapters.
    """
    mine = chapter_number(entry)
    if mine is None:
        return False
    try:
        return mine == int(number)
    except (TypeError, ValueError):
        return False


def sub_chapters(entry: Any) -> list[dict[str, Any]]:
    """The saved sub-chapter plan for this entry, if any."""
    if not isinstance(entry, dict):
        return []
    plan = entry.get("chapter_outline")
    subs = plan.get("sub_chapters") if isinstance(plan, dict) else None
    return [s for s in (subs or []) if isinstance(s, dict)]


__all__ = [
    "BODY_KEYS",
    "CONTEXT_KEYS",
    "NUMBER_KEYS",
    "chapter_body",
    "chapter_number",
    "matches",
    "sub_chapters",
]
