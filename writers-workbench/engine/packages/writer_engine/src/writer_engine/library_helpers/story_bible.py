"""Story-bible normalization + merge.

The story bible is a JSONB blob of {characters, locations, timeline, notes, ...}. Revisions must
PRESERVE existing characters rather than overwrite the blob (the n8n CHARACTER LOCK rule). This
helper deep-merges a patch into an existing bible and de-duplicates list sections by name/id.
"""

from __future__ import annotations

from typing import Any

from .jsonb_merge import jsonb_deep_merge

# Sections that are lists-of-named-entities and should be union-merged by identity, not replaced.
_LIST_SECTIONS = ("characters", "locations", "factions", "items")


def _entity_key(item: Any) -> str | None:
    if isinstance(item, dict):
        for k in ("id", "name", "title"):
            v = item.get(k)
            if v:
                return str(v).strip().lower()
    elif isinstance(item, str):
        return item.strip().lower()
    return None


def _union_by_key(base: list[Any], patch: list[Any]) -> list[Any]:
    """Append patch entities not already present (by name/id); update in place when keys collide."""
    out = list(base)
    index = {k: i for i, item in enumerate(out) if (k := _entity_key(item)) is not None}
    for item in patch:
        key = _entity_key(item)
        if key is not None and key in index:
            existing = out[index[key]]
            if isinstance(existing, dict) and isinstance(item, dict):
                out[index[key]] = jsonb_deep_merge(existing, item)
            else:
                out[index[key]] = item
        else:
            out.append(item)
            if key is not None:
                index[key] = len(out) - 1
    return out


def merge_story_bible(
    base: dict[str, Any] | None, patch: dict[str, Any] | None
) -> dict[str, Any]:
    """Merge ``patch`` into the existing story bible, preserving existing entities.

    List sections (characters, locations, factions, items) are union-merged by name/id so a revision
    never drops a previously-defined character. Everything else deep-merges via jsonb_deep_merge.
    """
    base = base or {}
    patch = patch or {}
    # Pull list sections out of the patch so jsonb_deep_merge doesn't wholesale-replace them.
    scalar_patch = {k: v for k, v in patch.items() if k not in _LIST_SECTIONS}
    merged = jsonb_deep_merge(base, scalar_patch)
    for section in _LIST_SECTIONS:
        if section in patch and isinstance(patch[section], list):
            base_list = base.get(section) if isinstance(base.get(section), list) else []
            merged[section] = _union_by_key(base_list, patch[section])
    return merged
