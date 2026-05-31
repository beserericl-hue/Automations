"""Project-title normalization + fuzzy matching.

Mirrors the n8n ``ilike``-style title matching used across the write-workshop tools, where the user
types a title loosely ("the lost city ") and it must match the stored ``writing_projects`` row.
"""

from __future__ import annotations

import re

_WS = re.compile(r"\s+")
_ARTICLES = ("the ", "a ", "an ")


def normalize_title(title: str | None) -> str:
    """Lower-case, collapse whitespace, strip surrounding punctuation. Stable key for comparison."""
    if not title:
        return ""
    t = _WS.sub(" ", str(title).strip().lower())
    return t.strip(" \t\n\r\"'.,;:!?-")


def titles_match(a: str | None, b: str | None) -> bool:
    """True when two titles refer to the same project.

    Exact after :func:`normalize_title`, or equal once a leading article (the/a/an) is dropped from
    either side, or one normalized title is a substring of the other (the n8n ilike '%title%' behavior).
    """
    na, nb = normalize_title(a), normalize_title(b)
    if not na or not nb:
        return False
    if na == nb:
        return True

    def _strip_article(s: str) -> str:
        for art in _ARTICLES:
            if s.startswith(art):
                return s[len(art):]
        return s

    sa, sb = _strip_article(na), _strip_article(nb)
    if sa == sb:
        return True
    return na in nb or nb in na
