"""The picker's response shapes, including the one that lost a whole edition.

Observed on the first newsletter run driven by the engine's own cadence scheduler (2026-10-17, DEV,
with n8n off): the model returned its answer nested under its own schema name and validation failed
with "top_selected_stories: Field required". The editorial work was done correctly and thrown away
over a layer of braces.

This is the third instance of the same failure in this file's schemas — `SubjectLineProposal`
unwraps a `primary` envelope and `ChapterCraftQa` a `scores` one — so it is handled the same way.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from writer_engine.schemas.newsletter import PickedStories

STORY = {"title": "A thing happened", "summary": "It did.", "identifiers": ["k1"]}


class TestEnvelopes:
    def test_the_flat_shape_still_works(self) -> None:
        got = PickedStories.model_validate({"top_selected_stories": [STORY], "chain_of_thought": "because"})
        assert len(got.top_selected_stories) == 1
        assert got.chain_of_thought == "because"

    def test_the_observed_self_named_envelope(self) -> None:
        """The exact payload from the live failure."""
        got = PickedStories.model_validate({"PickedStories": {"top_selected_stories": [STORY]}})
        assert got.top_selected_stories[0].title == "A thing happened"

    def test_any_single_key_envelope(self) -> None:
        for key in ("result", "output", "picked_stories", "response"):
            got = PickedStories.model_validate({key: {"top_selected_stories": [STORY]}})
            assert len(got.top_selected_stories) == 1, key

    @pytest.mark.parametrize("alias", ["stories", "selected_stories", "top_stories", "picks"])
    def test_the_list_under_an_alias(self, alias: str) -> None:
        got = PickedStories.model_validate({alias: [STORY]})
        assert len(got.top_selected_stories) == 1

    def test_the_n8n_chain_of_thought_alias_survives(self) -> None:
        """A2: the editorial brief asks for `top_selected_stories_chain_of_thought` by that name."""
        got = PickedStories.model_validate(
            {"top_selected_stories": [STORY], "top_selected_stories_chain_of_thought": "reasoning"}
        )
        assert got.chain_of_thought == "reasoning"

    def test_the_alias_survives_inside_an_envelope(self) -> None:
        got = PickedStories.model_validate(
            {"PickedStories": {"top_selected_stories": [STORY], "top_selected_stories_chain_of_thought": "r"}}
        )
        assert got.chain_of_thought == "r"

    def test_a_genuinely_empty_selection_is_not_invented(self) -> None:
        """An empty list is a real answer — "nothing today" — and must not become a validation error
        or a fabricated story."""
        assert PickedStories.model_validate({"top_selected_stories": []}).top_selected_stories == []

    def test_a_shape_with_no_stories_still_fails(self) -> None:
        """The unwrap must not paper over a response that genuinely has no selection in it."""
        with pytest.raises(ValidationError):
            PickedStories.model_validate({"something_else": {"unrelated": 1}})
