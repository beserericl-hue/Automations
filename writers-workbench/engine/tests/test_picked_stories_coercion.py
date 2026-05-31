"""PickedStory.identifiers / external_source_links coercion (F2 pick-step bug fix).

The picker LLM (Gemini) often returns ``identifiers`` as a dict ``{"id": "<uuid>"}`` or a list of
such dicts instead of a flat ``list[str]``, which previously failed PickedStories validation and
errored the whole saga at the pick stage. The mode="before" validator coerces these shapes.
"""

from __future__ import annotations

from writer_engine.schemas.newsletter import PickedStories, SelectedStory


def _story(identifiers, links=None):
    return SelectedStory(
        title="t",
        summary="s",
        identifiers=identifiers,
        external_source_links=links if links is not None else [],
    )


def test_identifiers_dict_with_id_becomes_list() -> None:
    s = _story({"id": "a17b9520-e1dd-446b-b30c-a716b1641bc8"})
    assert s.identifiers == ["a17b9520-e1dd-446b-b30c-a716b1641bc8"]


def test_identifiers_list_of_dicts() -> None:
    s = _story([{"id": "x1"}, {"id": "x2"}])
    assert s.identifiers == ["x1", "x2"]


def test_identifiers_plain_list_unchanged() -> None:
    s = _story(["x1", "x2"])
    assert s.identifiers == ["x1", "x2"]


def test_identifiers_bare_string_becomes_singleton() -> None:
    s = _story("x1")
    assert s.identifiers == ["x1"]


def test_identifiers_none_becomes_empty() -> None:
    s = _story(None)
    assert s.identifiers == []


def test_identifiers_dict_without_id_falls_back_to_first_value() -> None:
    s = _story({"value": "x9"})
    assert s.identifiers == ["x9"]


def test_identifiers_list_drops_empty_and_none() -> None:
    s = _story(["x1", "", None, {"id": None}])
    assert s.identifiers == ["x1"]


def test_external_source_links_dict_coerced_too() -> None:
    s = _story(["x1"], links={"url": "https://example.com/a"})
    assert s.external_source_links == ["https://example.com/a"]


def test_full_pickedstories_payload_with_dict_identifiers() -> None:
    """The exact shape that errored the DEV saga: top_selected_stories[].identifiers as dicts."""
    ps = PickedStories.model_validate(
        {
            "top_selected_stories": [
                {
                    "title": "Story A",
                    "summary": "...",
                    "identifiers": {"id": "a17b9520-e1dd-446b-b30c-a716b1641bc8"},
                    "external_source_links": [],
                }
            ],
            "chain_of_thought": "ok",
        }
    )
    assert ps.top_selected_stories[0].identifiers == ["a17b9520-e1dd-446b-b30c-a716b1641bc8"]
