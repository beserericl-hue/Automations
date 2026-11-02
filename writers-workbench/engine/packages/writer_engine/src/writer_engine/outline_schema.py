"""The one outline schema, enforced on every write (item 7).

``writing_projects_v2.outline`` is JSONB with no shape of its own, and two producers wrote two shapes
(see ``outline_keys``): 16 DEV projects use the ENGINE shape (``chapter_number`` + ``beat``), 10 the
legacy n8n shape (``number`` + ``brief``). Every reader had to know both, and the ones that knew only
one silently produced empty prompts and empty embeddings.

This module fixes the shape at the point of writing instead:

* the CANONICAL shape is the engine's: each chapter is keyed by ``chapter_number`` (an integer) and
  carries its instruction in ``beat``;
* a write in an ACCEPTED legacy shape is normalised on the way in — ``number`` becomes
  ``chapter_number``, ``brief`` becomes ``beat``, ``"04"`` becomes ``4``, a comma-separated ``themes``
  string becomes a list, a bare character name becomes ``{"name": ...}``;
* anything else is REJECTED with an :class:`OutlineValidationError` that names every problem, rather
  than written and discovered later as a blank chapter.

Keys starting with ``_`` are engine/Workbench metadata (``_volume_plan``, ``_marketing``,
``_landing_page`` ...). They are carried through untouched: their owners validate them.

The server mirrors this exactly in ``server/src/lib/outline-schema.ts``; both are tested against the
same cases in ``writers-workbench/shared/outline-schema-cases.json`` so the two cannot drift.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

TOP_LEVEL_STRING_KEYS = ("title", "premise", "story_arc_name", "dramatic_question", "wow_factor", "form")
TOP_LEVEL_KEYS = frozenset({*TOP_LEVEL_STRING_KEYS, "themes", "characters", "chapters"})

CHAPTER_STRING_KEYS = (
    "title",
    "beat",
    "act",
    "arc_point",
    "pov_character",
    "bridge_from_prior",
    "arc_notes",
    "arc_notes_extended",
)
CHAPTER_OBJECT_KEYS = ("chapter_outline", "research", "last_qa_report")
CHAPTER_LIST_KEYS = ("research_topics",)

# Legacy key -> canonical key. Accepted on write, never written back.
LEGACY_CHAPTER_KEYS = {"number": "chapter_number", "brief": "beat"}

MAX_PROBLEMS = 20


class OutlineValidationError(ValueError):
    """The outline is not in the canonical shape or an accepted legacy one."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems[:MAX_PROBLEMS]
        more = len(problems) - len(self.problems)
        detail = "; ".join(self.problems) + (f"; and {more} more" if more > 0 else "")
        super().__init__(f"Outline rejected: {detail}")


# --- the canonical shape, as pydantic models -----------------------------------------------------


class OutlineChapter(BaseModel):
    """One chapter in canonical form. Extra keys are allowed (hand edits, future fields)."""

    model_config = ConfigDict(extra="allow", strict=True)

    chapter_number: int = Field(ge=0)
    title: str = ""
    beat: str = ""
    act: str | None = None
    arc_point: str | None = None
    pov_character: str | None = None
    bridge_from_prior: str | None = None
    arc_notes: str | None = None
    arc_notes_extended: str | None = None
    chapter_outline: dict[str, Any] | None = None
    research: dict[str, Any] | None = None
    last_qa_report: dict[str, Any] | None = None
    research_topics: list[Any] | None = None


class Outline(BaseModel):
    """A project outline in canonical form. ``_``-prefixed metadata keys pass through."""

    model_config = ConfigDict(extra="allow", strict=True)

    title: str | None = None
    premise: str | None = None
    story_arc_name: str | None = None
    dramatic_question: str | None = None
    wow_factor: str | None = None
    form: str | None = None
    themes: list[str] = Field(default_factory=list)
    characters: list[dict[str, Any]] = Field(default_factory=list)
    chapters: list[OutlineChapter] = Field(default_factory=list)


# --- normalisation -------------------------------------------------------------------------------


def _type(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def _as_int(v: Any) -> int | None:
    """4, 4.0 and "04" are chapter 4. True, 4.5, "four" and "" are not chapter numbers."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v) if v.is_integer() else None
    if isinstance(v, str):
        s = v.strip()
        if s.isdigit():
            return int(s)
    return None


def _as_text(v: Any, where: str, problems: list[str]) -> Any:
    """A text field: strings pass, numbers become strings (an LLM's ``"act": 2``), null stays null."""
    if v is None or isinstance(v, str):
        return v
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)
    problems.append(f"{where} must be text, got {_type(v)}")
    return v


def _normalize_chapter(ch: Any, i: int, problems: list[str]) -> Any:
    where = f"chapters[{i}]"
    if not isinstance(ch, dict):
        problems.append(f"{where} must be an object, got {_type(ch)}")
        return ch

    has_canonical = ch.get("chapter_number") is not None
    raw_number = ch.get("chapter_number") if has_canonical else ch.get("number")
    number = _as_int(raw_number)
    if raw_number is None:
        problems.append(
            f"{where} has no chapter number (expected 'chapter_number'; legacy 'number' is accepted)"
        )
    elif number is None or number < 0:
        problems.append(f"{where} chapter number {raw_number!r} is not a whole number >= 0")
    if has_canonical and ch.get("number") is not None and _as_int(ch.get("number")) != number:
        problems.append(
            f"{where} has both chapter_number={ch.get('chapter_number')!r} and number={ch.get('number')!r}"
        )

    beat = ch.get("beat")
    brief = ch.get("brief")
    if isinstance(beat, str) and beat.strip() and isinstance(brief, str) and brief.strip() and beat != brief:
        problems.append(f"{where} has both 'beat' and legacy 'brief' with different text; keep one")

    beat_text = beat if isinstance(beat, str) and beat.strip() else None
    brief_text = brief if isinstance(brief, str) and brief.strip() else None
    out: dict[str, Any] = {}
    for key, value in ch.items():  # rebuilt in the original key order, legacy keys renamed in place
        if key == "number":
            if not has_canonical:
                out["chapter_number"] = number if number is not None else value
        elif key == "brief":
            if beat_text is None:
                out["beat"] = value
        elif key == "beat":
            if beat_text is not None or brief_text is None:
                out["beat"] = value
        elif key == "chapter_number":
            out[key] = number if number is not None else value
        else:
            out[key] = value

    for key in CHAPTER_STRING_KEYS:
        if key in out:
            out[key] = _as_text(out[key], f"{where}.{key}", problems)
    if "title" not in out:
        out["title"] = ""
    for key in CHAPTER_OBJECT_KEYS:
        if key in out and out[key] is not None and not isinstance(out[key], dict):
            problems.append(f"{where}.{key} must be an object, got {_type(out[key])}")
    for key in CHAPTER_LIST_KEYS:
        if key in out and out[key] is not None and not isinstance(out[key], list):
            problems.append(f"{where}.{key} must be a list, got {_type(out[key])}")
    return out


def normalize_outline(outline: Any) -> dict[str, Any]:
    """Return ``outline`` in canonical form, or raise :class:`OutlineValidationError`.

    Never mutates its argument. Idempotent: normalising a canonical outline returns an equal one.
    """
    if not isinstance(outline, dict):
        raise OutlineValidationError([f"outline must be an object, got {_type(outline)}"])

    problems: list[str] = []
    out: dict[str, Any] = {}
    for key, value in outline.items():
        if key.startswith("_"):
            out[key] = value
            continue
        if key not in TOP_LEVEL_KEYS:
            problems.append(
                f"unknown top-level key {key!r} (allowed: {', '.join(sorted(TOP_LEVEL_KEYS))}, or _metadata)"
            )
            continue
        if key in TOP_LEVEL_STRING_KEYS:
            out[key] = _as_text(value, key, problems)
        elif key == "themes":
            if isinstance(value, str):
                out[key] = [t.strip() for t in value.split(",") if t.strip()]
            elif isinstance(value, list):
                themes = []
                for j, t in enumerate(value):
                    if isinstance(t, str):
                        themes.append(t)
                    elif isinstance(t, (int, float)) and not isinstance(t, bool):
                        themes.append(str(t))
                    else:
                        problems.append(f"themes[{j}] must be text, got {_type(t)}")
                out[key] = themes
            elif value is None:
                out[key] = []
            else:
                problems.append(f"themes must be a list of text, got {_type(value)}")
        elif key == "characters":
            if value is None:
                out[key] = []
            elif not isinstance(value, list):
                problems.append(f"characters must be a list, got {_type(value)}")
            else:
                chars = []
                for j, c in enumerate(value):
                    if isinstance(c, dict):
                        chars.append(c)
                    elif isinstance(c, str) and c.strip():
                        chars.append({"name": c.strip()})
                    else:
                        problems.append(f"characters[{j}] must be an object, got {_type(c)}")
                out[key] = chars
        elif key == "chapters":
            if value is None:
                out[key] = []
            elif not isinstance(value, list):
                problems.append(f"chapters must be a list, got {_type(value)}")
            else:
                out[key] = [_normalize_chapter(ch, i, problems) for i, ch in enumerate(value)]

    seen: dict[int, int] = {}
    for i, ch in enumerate(out.get("chapters") or []):
        n = ch.get("chapter_number") if isinstance(ch, dict) else None
        if isinstance(n, int) and not isinstance(n, bool):
            if n in seen:
                problems.append(f"chapters[{i}] repeats chapter number {n} (also chapters[{seen[n]}])")
            else:
                seen[n] = i

    if not problems:
        # Belt and braces: the canonical models must accept what the normaliser produced.
        try:
            Outline.model_validate(out)
        except ValidationError as exc:
            for err in exc.errors()[:MAX_PROBLEMS]:
                loc = ".".join(str(p) for p in err.get("loc", ()))
                problems.append(f"{loc}: {err.get('msg')}")
    if problems:
        raise OutlineValidationError(problems)
    return out


def is_canonical(outline: Any) -> bool:
    """True when ``outline`` is already exactly canonical (normalising it would change nothing)."""
    try:
        return normalize_outline(outline) == outline
    except OutlineValidationError:
        return False


__all__ = [
    "LEGACY_CHAPTER_KEYS",
    "TOP_LEVEL_KEYS",
    "Outline",
    "OutlineChapter",
    "OutlineValidationError",
    "is_canonical",
    "normalize_outline",
]
