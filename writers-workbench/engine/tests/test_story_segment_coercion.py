"""StorySegment tolerates the title/content aliases Claude emits (observed on live DEV runs).

The segment LLM intermittently omits ``story_title`` or names the body ``content``/``section``.
Before the ``_coerce_segment`` validator this raised ``ValidationError`` inside ``complete_structured``,
which ``build_step_app`` swallowed into an empty payload — producing a blank newsletter (5 empty
segments). These cases lock in the coercion; the segment service backfills a still-empty title from
the authoritative story title afterwards.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from writer_engine.schemas import StepInput, StepStatus
from writer_engine.schemas.newsletter import StorySegment


def test_title_alias_maps_to_story_title() -> None:
    seg = StorySegment.model_validate(
        {"title": "These AI models are free", "newsletter_section_content": "Body."}
    )
    assert seg.story_title == "These AI models are free"
    assert seg.newsletter_section_content == "Body."


def test_content_alias_maps_to_section_content() -> None:
    seg = StorySegment.model_validate({"story_title": "T", "content": "The section body in a 'content' key."})
    assert seg.newsletter_section_content == "The section body in a 'content' key."


def test_missing_title_defaults_empty_for_backfill() -> None:
    # No title alias at all — validation must still pass (default ""), so the service can backfill.
    seg = StorySegment.model_validate(
        {"newsletter_section_content": "Body without any title.", "chosen_image_url": None}
    )
    assert seg.story_title == ""
    assert seg.newsletter_section_content == "Body without any title."


def test_canonical_shape_unchanged() -> None:
    seg = StorySegment.model_validate(
        {
            "story_title": "Canonical",
            "newsletter_section_content": "Body.",
            "chosen_image_url": "https://x/y.png",
            "image_options": ["https://x/y.png"],
        }
    )
    assert seg.story_title == "Canonical"
    assert seg.chosen_image_url == "https://x/y.png"
    assert seg.image_options == ["https://x/y.png"]


def test_section_and_headline_aliases() -> None:
    seg = StorySegment.model_validate({"headline": "H", "section": "S body"})
    assert seg.story_title == "H"
    assert seg.newsletter_section_content == "S body"


def test_segment_key_maps_to_section_content() -> None:
    """The live segment brief answers {"segment": "..."}; DEV stored those sections EMPTY from 2026-10-24."""
    seg = StorySegment.model_validate({"segment": "# Seed banks\n\n**The Recap:** ..."})
    assert seg.newsletter_section_content.startswith("# Seed banks")


def test_wrapped_or_unknown_key_falls_back_to_the_longest_prose() -> None:
    body = "A section about seed libraries, long enough to be prose and not a label. " * 2
    seg = StorySegment.model_validate({"output": {"whatever": body, "link": "https://x.y/z"}})
    assert seg.newsletter_section_content == body.strip()


def test_a_refusal_is_never_taken_as_the_section() -> None:
    refusal = (
        "I cannot write this newsletter section. The provided story has no connection to AI at all, sorry."
    )
    seg = StorySegment.model_validate({"error": refusal})
    assert seg.newsletter_section_content == ""


async def _empty_write(*args: object, **kwargs: object) -> StorySegment:
    return StorySegment(story_title="T", newsletter_section_content="")


@pytest.mark.asyncio
async def test_an_empty_section_is_an_error_not_a_blank_newsletter(monkeypatch: pytest.MonkeyPatch) -> None:
    from segment_step import main as segment_main

    monkeypatch.setattr(segment_main, "_write", _empty_write)
    out = await segment_main.handler(
        StepInput(execution_id=uuid4(), step_name="segment", payload={"story": {"title": "T"}})
    )
    assert out.status is StepStatus.ERROR
    assert out.error is not None and out.error.code == "EMPTY_SEGMENT"
