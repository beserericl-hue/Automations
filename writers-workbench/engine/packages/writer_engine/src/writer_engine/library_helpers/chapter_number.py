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


def optional_int(value: Any) -> int | None:
    """Coerce to ``int``, or ``None`` when absent or not a number.

    The companion to :func:`normalize_chapter_number` for callers that must distinguish "no value
    supplied" from a value. ``normalize_chapter_number`` defaults to 1, which is right when writing
    (chapter 1 is a sensible default) and WRONG when selecting (defaulting a missing
    ``chapter_number`` or ``version_number`` to 1 would revert or mutate the wrong row).

    Also the type-safe replacement for the ``if x not in (None, ""): int(x)`` pattern — that guard
    does not narrow ``Any | None`` for a type checker, so those sites each carried a
    ``contextlib.suppress(TypeError, ValueError)`` to cover the crash it could not rule out (H8).
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


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
