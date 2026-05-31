"""writer_engine.library_helpers — unit tests (F1-A prereq #2)."""

from __future__ import annotations

from writer_engine.library_helpers import (
    EPILOGUE_NUMBER,
    PROLOGUE_NUMBER,
    chapter_label,
    jsonb_deep_merge,
    merge_story_bible,
    next_version_number,
    normalize_chapter_number,
    normalize_title,
    resolve_recipients,
    titles_match,
)


# --- chapter_number ---------------------------------------------------------
def test_normalize_chapter_number_words() -> None:
    assert normalize_chapter_number("Prologue") == PROLOGUE_NUMBER
    assert normalize_chapter_number("  epilogue ") == EPILOGUE_NUMBER
    assert normalize_chapter_number("7") == 7
    assert normalize_chapter_number(3) == 3
    assert normalize_chapter_number(None) == 1
    assert normalize_chapter_number("garbage") == 1
    assert normalize_chapter_number(True) == 1  # bool guard


def test_chapter_label() -> None:
    assert chapter_label("Prologue", "Dawn") == "Prologue — Dawn"
    assert chapter_label(999, "The End") == "Epilogue — The End"
    assert chapter_label(5, "Storm") == "Chapter 5 — Storm"
    assert chapter_label(2, "") == "Chapter 2"


# --- title_resolver ---------------------------------------------------------
def test_normalize_title() -> None:
    assert normalize_title("  The Lost City. ") == "the lost city"
    assert normalize_title(None) == ""


def test_titles_match() -> None:
    assert titles_match("The Lost City", "lost city") is True  # article drop
    assert titles_match("Dune", "Dune: Part Two") is True  # substring
    assert titles_match("Dune", "Foundation") is False
    assert titles_match("", "x") is False


# --- email_recipients -------------------------------------------------------
def test_resolve_recipients_precedence() -> None:
    r = resolve_recipients(
        trigger_recipient="t@x.com",
        config={"recipient_email": "cfg@x.com", "bcc_email": "bcc@x.com"},
    )
    assert r.to == "t@x.com"  # trigger wins
    assert r.bcc == "bcc@x.com"  # falls back to config


def test_resolve_recipients_blank_trigger_falls_back() -> None:
    r = resolve_recipients(trigger_recipient="  ", config={"recipient_email": "cfg@x.com"})
    assert r.to == "cfg@x.com"
    assert r.bcc is None


# --- versions ---------------------------------------------------------------
def test_next_version_number() -> None:
    assert next_version_number(None) == 1
    assert next_version_number([]) == 1
    assert next_version_number([1, 2, 3]) == 4
    assert next_version_number([{"version": 2}, {"version": 5}]) == 6
    assert next_version_number([{"version_number": "4"}]) == 5


# --- jsonb_merge ------------------------------------------------------------
def test_jsonb_deep_merge() -> None:
    base = {"a": 1, "nested": {"x": 1, "y": 2}, "list": [1, 2]}
    patch = {"nested": {"y": 3, "z": 4}, "list": [9], "drop": None}
    out = jsonb_deep_merge(base, patch)
    assert out == {"a": 1, "nested": {"x": 1, "y": 3, "z": 4}, "list": [9]}
    # base not mutated
    assert base["nested"]["y"] == 2


def test_jsonb_deep_merge_none_deletes() -> None:
    assert jsonb_deep_merge({"a": 1, "b": 2}, {"b": None}) == {"a": 1}


# --- story_bible ------------------------------------------------------------
def test_merge_story_bible_preserves_existing_characters() -> None:
    base = {
        "characters": [{"name": "Alice", "role": "lead"}, {"name": "Bob"}],
        "setting": "Mars",
    }
    patch = {
        "characters": [{"name": "Alice", "age": 30}, {"name": "Carol"}],
        "setting": "Mars 2200",
    }
    out = merge_story_bible(base, patch)
    names = {c["name"] for c in out["characters"]}
    assert names == {"Alice", "Bob", "Carol"}  # nobody dropped
    alice = next(c for c in out["characters"] if c["name"] == "Alice")
    assert alice["role"] == "lead" and alice["age"] == 30  # merged, not replaced
    assert out["setting"] == "Mars 2200"


def test_merge_story_bible_empty_inputs() -> None:
    assert merge_story_bible(None, None) == {}
    assert merge_story_bible({"characters": [{"name": "A"}]}, None) == {
        "characters": [{"name": "A"}]
    }
