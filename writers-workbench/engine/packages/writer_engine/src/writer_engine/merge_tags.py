"""Fill the newsletter's ``{{first_name | fallback}}`` merge tag.

The intro brief (the n8n prompt, ``newsletter.intro.user_template``) has the model open with
``**Good morning, {{first_name | AI enthusiast}}.**`` — a tag the n8n-era email platform filled per
reader. Nothing in the engine did, so every issue went out, and was archived, with the raw tag in
its first line (found on DEV 2026-11-03 in every wasteland-wire send and a Content Studio issue).

deliver-svc fills it per subscriber; the stored copy (archive / "view in browser") gets the fallback.
"""

from __future__ import annotations

import re

_TAG = re.compile(r"\{\{\s*first_name\s*(?:\|\s*([^{}]*?))?\s*\}\}", re.IGNORECASE)
DEFAULT_FALLBACK = "there"


def first_name_of(display_name: str | None) -> str | None:
    """The first word of a subscriber's display name, when it looks like a name."""
    word = str(display_name or "").strip().split(" ")[0].strip(" ,.")
    return word if word and "@" not in word and len(word) <= 40 else None


def fill_merge_tags(text: str, first_name: str | None = None) -> str:
    """Replace every ``{{first_name}}`` / ``{{first_name | fallback}}`` with the reader's first name,
    else the tag's fallback, else "there"."""

    def sub(m: re.Match[str]) -> str:
        name = (first_name or "").strip()
        return name or (m.group(1) or "").strip() or DEFAULT_FALLBACK

    return _TAG.sub(sub, text or "")


__all__ = ["DEFAULT_FALLBACK", "fill_merge_tags", "first_name_of"]
