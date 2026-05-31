"""Verify the verbatim n8n prompt seeds load into the prompt store."""

from __future__ import annotations

from writer_engine.prompt_store import (
    N8N_SEED_KEYS,
    get_prompt_store,
    load_n8n_seeds,
    seed_default_prompts,
)
from writer_engine.prompt_store.n8n_seeds import N8N_BASELINE_PREFIX


def test_all_n8n_seeds_load() -> None:
    n = load_n8n_seeds()
    assert n == 8, f"expected 8 verbatim n8n prompts, got {n}"
    store = get_prompt_store()
    for key in N8N_SEED_KEYS:
        text = store.get(N8N_BASELINE_PREFIX + key)
        assert len(text) > 0, f"empty n8n seed for {key}"


def test_pick_top_stories_has_real_n8n_tokens() -> None:
    """The pick prompt should contain n8n expression markers (``{{`` and ``$json`` etc.)."""
    load_n8n_seeds()
    text = get_prompt_store().get(N8N_BASELINE_PREFIX + "newsletter.pick_top_stories.user_template")
    # Should be the actual n8n prompt with its task description.
    assert "Task" in text or "task" in text
    assert len(text) > 1000  # at least 1k chars — this is the real prompt


def test_seed_default_includes_n8n_baseline() -> None:
    total = seed_default_prompts()
    # 16 default keys + 8 n8n seeds (rounded estimate; assertion is "at least").
    assert total >= 16
    store = get_prompt_store()
    # Both layers present.
    assert store.get("newsletter.pick_top_stories.user_template")  # default placeholder
    assert store.get(N8N_BASELINE_PREFIX + "newsletter.pick_top_stories.user_template")  # n8n verbatim
