"""Chapter-number normalization + labels.

Canonical convention (mirrors writers-workbench/server/src/routes/export.ts getChapterLabel and the
n8n write_chapter workflow): Prologue → 0, Epilogue → 999, regular chapters → their integer.
"""

from __future__ import annotations

from typing import Any

PROLOGUE_NUMBER = 0
EPILOGUE_NUMBER = 999


def normalize_chapter_number(value: Any) -> int:
    """Coerce a chapter identifier into the canonical integer.

    Accepts ints, numeric strings, and the words "Prologue"/"Epilogue" (any case, surrounding
    whitespace ok). Unknown / empty values default to 1 (the first regular chapter), matching the
    n8n workflow's fallback.
    """
    if value is None:
        return 1
    if isinstance(value, bool):  # guard: bool is an int subclass
        return 1
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = str(value).strip()
    if not text:
        return 1
    low = text.lower()
    if low == "prologue":
        return PROLOGUE_NUMBER
    if low == "epilogue":
        return EPILOGUE_NUMBER
    try:
        return int(text)
    except ValueError:
        return 1


def chapter_label(chapter_number: Any, title: str | None = None) -> str:
    """Human label for a chapter: "Prologue — t" / "Epilogue — t" / "Chapter N — t".

    ``chapter_number`` is normalized first, so it accepts the same inputs as
    :func:`normalize_chapter_number`. When ``title`` is falsy the em-dash + title is omitted.
    """
    n = normalize_chapter_number(chapter_number)
    if n == PROLOGUE_NUMBER:
        base = "Prologue"
    elif n == EPILOGUE_NUMBER:
        base = "Epilogue"
    else:
        base = f"Chapter {n}"
    title = (title or "").strip()
    return f"{base} — {title}" if title else base
