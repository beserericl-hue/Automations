"""SubjectLineProposal envelope-unwrap (F2 subject-step bug fix).

The subject LLM (Gemini) returns a nested ``{"primary": {...}, "alternatives": [...]}`` envelope
instead of flat fields, which errored the saga at the subject stage. The mode="before" model
validator flattens it.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from writer_engine.schemas.newsletter import SubjectLineProposal


def test_flat_shape_still_works() -> None:
    p = SubjectLineProposal(subject_line="Hi", pre_header_text="Preview")
    assert p.subject_line == "Hi"
    assert p.pre_header_text == "Preview"


def test_primary_envelope_unwrapped() -> None:
    p = SubjectLineProposal.model_validate(
        {
            "primary": {
                "subject_line": "AI breakthroughs this week",
                "pre_header_text": "Tools offering solutions.",
                "subject_line_reasoning": "punchy",
            },
            "alternatives": ["Alt one", "Alt two"],
        }
    )
    assert p.subject_line == "AI breakthroughs this week"
    assert p.pre_header_text == "Tools offering solutions."
    assert p.subject_line_reasoning == "punchy"
    assert p.additional_subject_lines == ["Alt one", "Alt two"]


def test_alternatives_list_of_dicts() -> None:
    p = SubjectLineProposal.model_validate(
        {
            "subject_line": "S",
            "pre_header_text": "P",
            "alternatives": [{"subject_line": "A1"}, {"subject": "A2"}],
        }
    )
    assert p.additional_subject_lines == ["A1", "A2"]


def test_additional_subject_lines_field_with_dicts() -> None:
    """The field itself populated with {subject_line: ...} dicts (observed on a live DEV run)."""
    p = SubjectLineProposal.model_validate(
        {
            "subject_line": "S",
            "pre_header_text": "P",
            "additional_subject_lines": [
                {"subject_line": "Your AI brief"},
                {"subject": "Catch newsletter readers"},
                "Already a string",
            ],
        }
    )
    assert p.additional_subject_lines == [
        "Your AI brief",
        "Catch newsletter readers",
        "Already a string",
    ]


def test_additional_subject_lines_drops_empty() -> None:
    p = SubjectLineProposal.model_validate(
        {"subject_line": "S", "pre_header_text": "P", "additional_subject_lines": [{}, None, "", "keep"]}
    )
    assert p.additional_subject_lines == ["keep"]


def test_aliases_subject_and_preheader() -> None:
    p = SubjectLineProposal.model_validate({"subject": "Aliased", "preheader": "Prev"})
    assert p.subject_line == "Aliased"
    assert p.pre_header_text == "Prev"


def test_recommended_envelope_alias() -> None:
    p = SubjectLineProposal.model_validate(
        {"recommended": {"subject_line": "R", "pre_header_text": "RP"}}
    )
    assert p.subject_line == "R"
    assert p.pre_header_text == "RP"


def test_missing_fields_still_raise() -> None:
    with pytest.raises(ValidationError):
        SubjectLineProposal.model_validate({"primary": {"foo": "bar"}})
