"""StorySegment tolerates the title/content aliases Claude emits (observed on live DEV runs).

The segment LLM intermittently omits ``story_title`` or names the body ``content``/``section``.
Before the ``_coerce_segment`` validator this raised ``ValidationError`` inside ``complete_structured``,
which ``build_step_app`` swallowed into an empty payload — producing a blank newsletter (5 empty
segments). These cases lock in the coercion; the segment service backfills a still-empty title from
the authoritative story title afterwards.
"""

from __future__ import annotations

from writer_engine.schemas.newsletter import StorySegment


def test_title_alias_maps_to_story_title() -> None:
    seg = StorySegment.model_validate(
        {"title": "These AI models are free", "newsletter_section_content": "Body."}
    )
    assert seg.story_title == "These AI models are free"
    assert seg.newsletter_section_content == "Body."


def test_content_alias_maps_to_section_content() -> None:
    seg = StorySegment.model_validate(
        {"story_title": "T", "content": "The section body in a 'content' key."}
    )
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
