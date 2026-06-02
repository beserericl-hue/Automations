"""ChapterCraftQa tolerates the LLM's score shapes (found on a live DB regression).

The craft-QA model nests the seven guide dimensions under a ``scores`` envelope and/or returns
0-100 ints; both must coerce to flat 0-1 floats rather than fail validation.
"""

from __future__ import annotations

from writer_engine.schemas.chapter import ChapterCraftQa

_DIMS = {
    "character_follows_guide": 0.9,
    "outline_follows_guide": 0.9,
    "dialogue_follows_guide": 0.9,
    "prose_transparent": 0.9,
    "story_turn_density": 0.9,
    "no_boring_paragraphs": 0.9,
    "period_language_ok": 0.9,
}


def test_flat_shape_unchanged() -> None:
    qa = ChapterCraftQa.model_validate({**_DIMS, "findings": []})
    assert qa.character_follows_guide == 0.9


def test_scores_envelope_hoisted() -> None:
    qa = ChapterCraftQa.model_validate({"scores": _DIMS, "findings": [{"dimension": "x", "fix": "y"}]})
    assert qa.dialogue_follows_guide == 0.9
    assert qa.findings == [{"dimension": "x", "fix": "y"}]


def test_0_to_100_ints_coerced() -> None:
    qa = ChapterCraftQa.model_validate({"scores": {k: 85 for k in _DIMS}})
    assert qa.prose_transparent == 0.85
