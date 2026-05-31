"""Deep-merge dicts for JSONB columns.

Used when updating a JSONB column (story_bible, metadata, outline) where we want to preserve keys the
caller didn't touch rather than overwrite the whole blob — the bug the n8n workflows hit when they
PATCHed a JSONB column with a partial object and silently dropped existing keys.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any


def jsonb_deep_merge(base: dict[str, Any] | None, patch: dict[str, Any] | None) -> dict[str, Any]:
    """Return a new dict = ``base`` deep-merged with ``patch`` (patch wins on conflicts).

    - Nested dicts merge recursively.
    - Non-dict values (including lists) are replaced wholesale by the patch value.
    - A patch value of ``None`` deletes the key from the result (so callers can prune).
    - Inputs are not mutated.
    """
    out: dict[str, Any] = deepcopy(base) if base else {}
    if not patch:
        return out
    for key, pval in patch.items():
        if pval is None:
            out.pop(key, None)
            continue
        bval = out.get(key)
        if isinstance(bval, dict) and isinstance(pval, dict):
            out[key] = jsonb_deep_merge(bval, pval)
        else:
            out[key] = deepcopy(pval)
    return out
