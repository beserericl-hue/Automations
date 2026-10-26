"""The author's notes from the Outline / Write dialogs reach the prompt.

They used to be appended to a chat sentence ("write chapter 4 of X. ADDITIONAL INSTRUCTIONS: ...")
that the router reduced to a project and a chapter number, so neither the planner nor the writer
ever saw them. The Workbench now sends them as `author_notes`.
"""

from __future__ import annotations

from chapter_step import main as M

from writer_engine.schemas.chapter import WriteChapterRequest


def _req() -> WriteChapterRequest:
    return WriteChapterRequest.model_validate(
        {"project_id": "00000000-0000-0000-0000-000000000001", "chapter_number": 4}
    )


def test_notes_from_the_payload_land_in_the_chapter_header() -> None:
    ctx = M._apply_ctx_overrides(
        {"title": "The Ossuary", "genre_slug": "", "outline": {}, "roster": []},
        {"author_notes": "Open on the spring, not the bluff."},
    )
    header = M._chapter_header(ctx, [], _req())
    assert "THE AUTHOR'S INSTRUCTIONS FOR THIS CHAPTER" in header
    assert "Open on the spring, not the bluff." in header


def test_no_notes_no_block() -> None:
    ctx = M._apply_ctx_overrides(
        {"title": "T", "genre_slug": "", "outline": {}, "roster": []}, {"author_notes": "  "}
    )
    assert "AUTHOR'S INSTRUCTIONS" not in M._chapter_header(ctx, [], _req())
