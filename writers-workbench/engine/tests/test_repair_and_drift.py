"""Chapter repair op + hardened drift detection (DriftReport tolerance)."""

from __future__ import annotations

import asyncio

from chapter_step.main import OPS as CHAPTER_OPS
from chapter_step.main import _outline_chapter_act

from writer_engine.schemas.chapter import DriftReport


def test_repair_op_registered() -> None:
    assert "repair" in CHAPTER_OPS


def test_repair_needs_text() -> None:
    out = asyncio.run(CHAPTER_OPS["repair"]({"chapter_number": 4}))  # no text, no DB
    assert out["repaired"] is False and "no chapter text" in out["reason"]


def test_outline_chapter_act() -> None:
    outline = {"chapters": [{"chapter_number": 4, "act": "Act I", "title": "X"}]}
    assert _outline_chapter_act(outline, 4) == "Act I"
    assert _outline_chapter_act(outline, 9) == ""


def test_drift_report_tolerant_of_dict_items_and_nulls() -> None:
    # the live shapes: {"item": ...} entries, null lists, a wrapper
    d = DriftReport.model_validate({
        "story_drift": [{"item": "skips the hearing beat"}, None],
        "character_drift": None, "research_gaps": "price of copper",
    })
    assert d.story_drift == ["skips the hearing beat"]  # dict flattened, None dropped
    assert d.character_drift == []
    assert d.research_gaps == ["price of copper"]
