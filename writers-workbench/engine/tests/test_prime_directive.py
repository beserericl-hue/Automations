"""Writing Prime Directive prompt helper (F1-A prereq #2)."""

from __future__ import annotations

from writer_engine.prompt_store.prime_directive import (
    PRIME_DIRECTIVE,
    PRIME_DIRECTIVE_KEY,
    get_prime_directive,
    prime_directive_prompt,
)


def test_default_directive_returned_when_no_override() -> None:
    assert get_prime_directive() == PRIME_DIRECTIVE
    assert "master storyteller" in PRIME_DIRECTIVE


def test_prompt_prefixes_directive_then_body() -> None:
    out = prime_directive_prompt("WRITE CHAPTER 3")
    assert out.startswith(PRIME_DIRECTIVE)
    assert out.endswith("WRITE CHAPTER 3")
    assert "\n\n" in out


def test_db_override_wins(monkeypatch) -> None:
    from writer_engine.prompt_store.store import get_prompt_store

    store = get_prompt_store()
    store.override(PRIME_DIRECTIVE_KEY, "CUSTOM DIRECTIVE")
    try:
        assert get_prime_directive() == "CUSTOM DIRECTIVE"
        assert prime_directive_prompt("x").startswith("CUSTOM DIRECTIVE")
    finally:
        store.clear_overrides()
