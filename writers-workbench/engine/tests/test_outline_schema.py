"""Item 7 — one outline schema, validated on every write.

The cases live in ``writers-workbench/shared/outline-schema-cases.json`` and the server's
``outline-schema.test.ts`` runs the same file, so the engine and the server cannot disagree about
what an outline is.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from writer_engine import outline_keys
from writer_engine.outline_schema import OutlineValidationError, is_canonical, normalize_outline

CASES_FILE = Path(__file__).resolve().parents[2] / "shared" / "outline-schema-cases.json"
CASES = json.loads(CASES_FILE.read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_case(case: dict[str, Any]) -> None:
    original = copy.deepcopy(case["in"])
    if "reject" in case:
        with pytest.raises(OutlineValidationError) as exc:
            normalize_outline(case["in"])
        for needle in case["reject"]:
            assert needle in str(exc.value), f"{needle!r} not in {exc.value}"
    else:
        out = normalize_outline(case["in"])
        assert out == case["out"]
        # idempotent: the canonical form normalises to itself
        assert normalize_outline(out) == out
        assert is_canonical(out)
    assert case["in"] == original, "normalize_outline mutated its input"


def test_legacy_and_canonical_read_the_same_after_normalising() -> None:
    """The point of normalising: after a write, every reader sees chapter_number + beat."""
    legacy = {"chapters": [{"number": 7, "title": "t", "brief": "the brief"}]}
    ch = normalize_outline(legacy)["chapters"][0]
    assert "number" not in ch and "brief" not in ch
    assert outline_keys.chapter_number(ch) == 7
    assert outline_keys.chapter_body(ch) == "the brief"


def test_the_error_names_every_problem() -> None:
    with pytest.raises(OutlineValidationError) as exc:
        normalize_outline({"logline": "x", "chapters": [{"title": "a"}, "b"]})
    assert len(exc.value.problems) == 3
    assert str(exc.value).startswith("Outline rejected: ")


def test_a_canonical_outline_reports_itself_canonical_and_a_legacy_one_does_not() -> None:
    assert is_canonical({"chapters": [{"chapter_number": 1, "title": "t"}]})
    assert not is_canonical({"chapters": [{"number": 1, "title": "t"}]})
    assert not is_canonical({"chapters": "nope"})
