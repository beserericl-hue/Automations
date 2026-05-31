"""Version-snapshot helpers for content_versions / outline_versions.

The n8n workflows auto-snapshot the previous value before each edit, numbering versions 1..N. This
centralizes the "what's the next version number" calc so the chapter/brainstorm/library ports agree.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def next_version_number(existing: Iterable[Any] | None) -> int:
    """Return the next 1-based version number given existing version rows (or their numbers).

    ``existing`` may be: a list of ints, a list of dicts with a ``version`` (or ``version_number``)
    key, or None/empty. Returns ``max(seen) + 1``, or 1 when there are none.
    """
    if not existing:
        return 1
    nums: list[int] = []
    for item in existing:
        if isinstance(item, bool):
            continue
        if isinstance(item, int):
            nums.append(item)
        elif isinstance(item, dict):
            v = item.get("version")
            if v is None:
                v = item.get("version_number")
            if isinstance(v, bool):
                continue
            if isinstance(v, int):
                nums.append(v)
            elif isinstance(v, str) and v.strip().isdigit():
                nums.append(int(v.strip()))
    return (max(nums) + 1) if nums else 1
