"""Conservative JSON repair for messy LLM output."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from writer_engine.llm import extract_and_parse, try_repair_json


class _Person(BaseModel):
    name: str
    age: int


def test_strips_markdown_fence() -> None:
    text = '```json\n{"name": "Eve", "age": 42}\n```'
    assert try_repair_json(text) == '{"name": "Eve", "age": 42}'


def test_strips_leading_prose() -> None:
    text = 'Sure, here is the JSON you asked for:\n{"name": "Eve", "age": 42}\nHope this helps!'
    repaired = try_repair_json(text)
    assert repaired == '{"name": "Eve", "age": 42}'


def test_fixes_trailing_comma_in_object() -> None:
    text = '{"name": "Eve", "age": 42,}'
    assert try_repair_json(text) == '{"name": "Eve", "age": 42}'


def test_fixes_trailing_comma_in_array() -> None:
    text = '{"names": ["Eve", "Adam",]}'
    assert try_repair_json(text) == '{"names": ["Eve", "Adam"]}'


def test_quotes_unquoted_keys() -> None:
    text = "{name: \"Eve\", age: 42}"
    assert try_repair_json(text) == '{"name": "Eve", "age": 42}'


def test_quotes_single_quoted_keys() -> None:
    text = "{'name': \"Eve\", 'age': 42}"
    assert try_repair_json(text) == '{"name": "Eve", "age": 42}'


def test_strips_line_comments() -> None:
    text = '{\n  // top-level comment\n  "name": "Eve",\n  "age": 42\n}'
    repaired = try_repair_json(text)
    assert "//" not in repaired
    assert '"name": "Eve"' in repaired


def test_smart_quotes_to_straight() -> None:
    text = '{“name”: “Eve”, “age”: 42}'
    repaired = try_repair_json(text)
    assert repaired == '{"name": "Eve", "age": 42}'


def test_extract_and_parse_roundtrips_to_pydantic() -> None:
    text = '```json\n{"name": "Eve", "age": 42,}\n```'
    person = extract_and_parse(text, _Person)
    assert person.name == "Eve"
    assert person.age == 42


def test_extract_and_parse_raises_on_truncated() -> None:
    """Repair stops at structural breakage — caller decides to retry the LLM."""
    text = '{"name": "Eve", "age": '  # truncated mid-value
    with pytest.raises(ValueError):
        extract_and_parse(text, _Person)


def test_extract_and_parse_raises_on_schema_mismatch() -> None:
    text = '{"name": "Eve", "age": "forty-two"}'  # age should be int
    with pytest.raises(ValueError, match="failed schema"):
        extract_and_parse(text, _Person)
