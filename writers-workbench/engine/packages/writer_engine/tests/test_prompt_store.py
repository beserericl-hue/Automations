"""Prompt store: defaults + overrides + KeyError on unknown."""

from __future__ import annotations

import pytest

from writer_engine.prompt_store import PromptStore


def test_default_lookup() -> None:
    store = PromptStore(defaults={"pick.system": "default-system"})
    assert store.get("pick.system") == "default-system"


def test_override_wins() -> None:
    store = PromptStore(defaults={"pick.system": "default"})
    store.override("pick.system", "override")
    assert store.get("pick.system") == "override"
    store.clear_overrides()
    assert store.get("pick.system") == "default"


def test_unknown_raises() -> None:
    store = PromptStore()
    with pytest.raises(KeyError):
        store.get("missing")


def test_unknown_fallback_default() -> None:
    store = PromptStore()
    assert store.get("missing", default="fallback") == "fallback"
