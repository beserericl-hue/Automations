"""Best-effort JSON repair for LLM outputs.

LLMs occasionally emit JSON wrapped in chatter, prefixed with explanatory text, or with
common mistakes the strict ``json.loads`` parser rejects (trailing commas, single-quoted
keys, smart quotes, // line comments). This module gives step services a single helper:

    try_repair_json(text) -> str  # best-effort cleaned string
    extract_and_parse(text, schema) -> tuple[T, dict]  # convenience over Pydantic

The repair is intentionally conservative — it only fixes mistakes we have observed in the
wild from Anthropic / Gemini / Perplexity responses. It does NOT attempt to reconstruct
broken JSON structure (missing braces, truncated arrays); those raise a ValueError so the
caller can retry the LLM.
"""

from __future__ import annotations

import json
import re
from typing import TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)
# Match keys that are NOT already double-quoted: '{ key: ...' or ", key: ..." but not ", "key": ...".
_UNQUOTED_KEY_RE = re.compile(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:")
_SINGLE_QUOTED_KEY_RE = re.compile(r"([{,]\s*)'([^']+?)'\s*:")
# Trailing comma immediately before a closing } or ].
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")
# // line comments outside a string. Conservative — only matches when the // starts a line or
# follows whitespace. Will not handle //-in-string-literal correctly; LLMs rarely produce that.
_LINE_COMMENT_RE = re.compile(r"(?m)^\s*//.*$")
# Smart quotes -> straight quotes.
_SMART_QUOTES = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'"})


def _strip_fence(text: str) -> str:
    match = _FENCE_RE.search(text)
    if match:
        return match.group(1).strip()
    return text


def _find_json_span(text: str) -> tuple[int, int] | None:
    """Return the byte span of the largest plausible JSON object/array, or None.

    Scans for matching braces, ignoring quoted strings. Returns the span of the outermost
    pair that closes properly. Used to peel off leading/trailing prose ("Sure, here's the
    JSON:" / "Hope this helps!").
    """
    depth = 0
    start = -1
    in_str = False
    str_char = ""
    escape = False
    open_char = ""
    close_char = ""
    for i, ch in enumerate(text):
        if escape:
            escape = False
            continue
        if in_str:
            if ch == "\\":
                escape = True
            elif ch == str_char:
                in_str = False
            continue
        if ch in ('"', "'"):
            in_str = True
            str_char = ch
            continue
        if depth == 0 and ch in "{[":
            start = i
            open_char = ch
            close_char = "}" if ch == "{" else "]"
            depth = 1
            continue
        if depth > 0:
            if ch == open_char:
                depth += 1
            elif ch == close_char:
                depth -= 1
                if depth == 0 and start >= 0:
                    return start, i + 1
    return None


def try_repair_json(text: str) -> str:
    """Apply conservative repairs to text that should be JSON. Returns the cleaned string."""
    cleaned = text.translate(_SMART_QUOTES)
    cleaned = _strip_fence(cleaned)
    cleaned = _LINE_COMMENT_RE.sub("", cleaned)
    span = _find_json_span(cleaned)
    if span is not None:
        start, end = span
        cleaned = cleaned[start:end]
    cleaned = _SINGLE_QUOTED_KEY_RE.sub(r'\1"\2":', cleaned)
    cleaned = _UNQUOTED_KEY_RE.sub(r'\1"\2":', cleaned)
    cleaned = _TRAILING_COMMA_RE.sub(r"\1", cleaned)
    return cleaned.strip()


def extract_and_parse(text: str, schema: type[T]) -> T:
    """Repair → ``json.loads`` → validate against ``schema``. Raises ``ValueError`` on failure."""
    raw = try_repair_json(text)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LLM did not return valid JSON: {exc}; raw={text[:300]!r}") from exc
    try:
        return schema.model_validate(data)
    except ValidationError as exc:
        raise ValueError(f"LLM JSON failed schema {schema.__name__}: {exc}") from exc
