"""library_helpers — small data/utility helpers shared by the F1-A write-workshop step ports.

These mirror logic that lived inline in the n8n tool workflows + the WW Express server, extracted so
the chapter / brainstorm / library / story-bible / notify step services reuse one implementation.

Modules:
- chapter_number : Prologue(0) / Epilogue(999) / Chapter-N normalization + labels
- title_resolver : normalize / fuzzy-match a project title
- email_recipients : resolve recipient + bcc from app_config with trigger overrides
- versions        : content/outline version snapshot helpers
- story_bible     : merge/normalize story-bible JSON
- jsonb_merge     : deep-merge dicts for JSONB columns (DB-write-safe)
"""

from __future__ import annotations

from .chapter_number import (
    EPILOGUE_NUMBER,
    PROLOGUE_NUMBER,
    chapter_label,
    normalize_chapter_number,
)
from .email_recipients import resolve_recipients
from .jsonb_merge import jsonb_deep_merge
from .story_bible import merge_story_bible
from .title_resolver import normalize_title, titles_match
from .versions import next_version_number

__all__ = [
    "EPILOGUE_NUMBER",
    "PROLOGUE_NUMBER",
    "chapter_label",
    "jsonb_deep_merge",
    "merge_story_bible",
    "next_version_number",
    "normalize_chapter_number",
    "normalize_title",
    "resolve_recipients",
    "titles_match",
]
