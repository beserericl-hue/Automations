"""The two outline shapes, and the readers that each understood only one of them.

Measured on DEV 2026-10-17 across 26 projects with outlines:

    ENGINE shape  16 projects   chapter_number · beat · bridge_from_prior · act · arc_point · pov
    n8n shape     10 projects   number · brief · arc_notes · chapter_outline · research_topics

`_compact_outline_view` keyed on `chapter_number`; `build_canon_chunks` keyed on `number`. Each was
therefore blind to half the data, and both failures are silent — an empty string, never an error:

* n8n-shaped project -> no "THIS CHAPTER" block in the write prompt at all. No beat, no brief, no
  bridge from the prior chapter.
* engine-shaped project -> no chapter_brief and no sub_chapter canon chunks, so vector retrieval had
  nothing of the story's own structure to return. Confirmed in the data: of 26 projects, the ONLY
  ones with rows in writing_embeddings_v2 were n8n-shaped.

These tests use the real field names from both shapes, so a regression reproduces the live bug
rather than a synthetic one.
"""

from __future__ import annotations

from typing import Any

import pytest

from writer_engine import outline_keys

# Real shapes, as the DEV rows carry them.
ENGINE_ENTRY: dict[str, Any] = {
    "chapter_number": 0,
    "title": "Prologue: Static",
    "act": "I",
    "arc_point": "Ordinary World",
    "pov_character": "Mara",
    "bridge_from_prior": "None — opening",
    "beat": "Seven years after the Cascade, Mara lives alone in a fortified farmhouse.",
}

N8N_ENTRY: dict[str, Any] = {
    "number": 0,
    "title": "The Winding Key",
    "brief": "Elena discovers the automaton's ledger hidden in the clock tower.",
    "arc_notes": "Sets up the rebellion's first fracture.",
    "chapter_outline": {"sub_chapters": [{"number": 1, "title": "The Tower", "beat": "She climbs."}]},
    "research_topics": ["clockwork", "Prague 1890"],
}


@pytest.mark.parametrize("entry", [ENGINE_ENTRY, N8N_ENTRY], ids=["engine", "n8n"])
def test_the_number_is_found_in_either_shape(entry: dict[str, Any]) -> None:
    assert outline_keys.chapter_number(entry) == 0


@pytest.mark.parametrize("entry", [ENGINE_ENTRY, N8N_ENTRY], ids=["engine", "n8n"])
def test_the_body_is_found_in_either_shape(entry: dict[str, Any]) -> None:
    """`beat` in one shape, `brief` in the other — this text IS the chapter's instruction."""
    assert outline_keys.chapter_body(entry)


@pytest.mark.parametrize("entry", [ENGINE_ENTRY, N8N_ENTRY], ids=["engine", "n8n"])
def test_matching_works_in_either_shape(entry: dict[str, Any]) -> None:
    assert outline_keys.matches(entry, 0) is True
    assert outline_keys.matches(entry, 1) is False


def test_a_numeric_string_or_float_is_the_same_chapter() -> None:
    """The old comparison was str(num) == str(n), so "04" and 4.0 were different chapters."""
    assert outline_keys.matches({"chapter_number": "4"}, 4) is True
    assert outline_keys.matches({"chapter_number": 4.0}, 4) is True
    assert outline_keys.matches({"number": "04"}, 4) is True


def test_an_entry_with_no_number_matches_nothing() -> None:
    assert outline_keys.chapter_number({"title": "x"}) is None
    assert outline_keys.matches({"title": "x"}, 1) is False


def test_garbage_is_tolerated() -> None:
    """Outlines are LLM output; a non-dict or an unparseable number must not raise."""
    for junk in (None, "a string", 42, [], {"chapter_number": "not a number"}):
        assert outline_keys.chapter_number(junk) is None
        assert outline_keys.chapter_body(junk) == ""
        assert outline_keys.matches(junk, 0) is False
    assert outline_keys.sub_chapters(None) == []
    assert outline_keys.sub_chapters({"chapter_outline": "not a dict"}) == []
    assert outline_keys.sub_chapters({"chapter_outline": {"sub_chapters": [None, 1]}}) == []


def test_the_engine_shape_prefers_chapter_number_when_both_exist() -> None:
    """A hand-merged outline could carry both; chapter_number is what the engine writes today."""
    assert outline_keys.chapter_number({"chapter_number": 7, "number": 9}) == 7


# --- the two readers that drifted ---------------------------------------------------------------


def _view(outline: dict[str, Any], n: int) -> str:
    from chapter_step.main import _compact_outline_view

    return _compact_outline_view(outline, n)


@pytest.mark.parametrize("entry", [ENGINE_ENTRY, N8N_ENTRY], ids=["engine", "n8n"])
def test_the_write_prompt_contains_this_chapter_in_either_shape(entry: dict[str, Any]) -> None:
    """The regression: an n8n-shaped project used to get no THIS CHAPTER block whatsoever."""
    view = _view({"title": "Book", "premise": "P", "chapters": [entry]}, 0)
    assert "THIS CHAPTER" in view
    assert outline_keys.chapter_body(entry)[:30] in view


def test_the_index_never_renders_a_none_chapter_number() -> None:
    """Every index line for an n8n-shaped outline used to read "None. Title"."""
    view = _view({"chapters": [N8N_ENTRY, {**N8N_ENTRY, "number": 1, "title": "Second"}]}, 0)
    assert "None." not in view
    assert "0. The Winding Key" in view
    assert "1. Second" in view


def test_the_bridge_from_the_prior_chapter_reaches_the_prompt() -> None:
    """It is the only field that says how this chapter connects to the one before it."""
    entry = {**ENGINE_ENTRY, "chapter_number": 5, "bridge_from_prior": "Mara leaves the farmhouse."}
    view = _view({"chapters": [entry]}, 5)
    assert "Mara leaves the farmhouse." in view


@pytest.mark.parametrize("entry", [ENGINE_ENTRY, N8N_ENTRY], ids=["engine", "n8n"])
def test_canon_chunks_are_built_for_either_shape(entry: dict[str, Any]) -> None:
    """The other half: engine-shaped projects produced NO chapter chunks, so retrieval had nothing."""
    from writer_engine.embeddings import build_canon_chunks

    chunks = build_canon_chunks({"premise": "P", "chapters": [entry]}, [])
    kinds = {c["doc_type"] for c in chunks}
    assert "chapter_brief" in kinds
    briefs = [c for c in chunks if c["doc_type"] == "chapter_brief"]
    assert briefs[0]["doc_id"] == "ch_0"
    assert outline_keys.chapter_body(entry)[:30] in briefs[0]["content"]


def test_sub_chapter_chunks_survive_in_the_n8n_shape() -> None:
    """sub_chapter is the largest doc_type n8n produced; dropping it makes a reindex destructive."""
    from writer_engine.embeddings import build_canon_chunks

    chunks = build_canon_chunks({"premise": "P", "chapters": [N8N_ENTRY]}, [])
    assert any(c["doc_type"] == "sub_chapter" for c in chunks)
