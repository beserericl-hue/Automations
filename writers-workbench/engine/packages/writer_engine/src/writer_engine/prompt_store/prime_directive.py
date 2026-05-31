"""Writing Prime Directive — the standing instruction prefixed to content-generating prompts.

In the n8n system the "Writing Prime Directive" was injected into all six content-generating
workflows (blog, newsletter, short story, chapter, social posts, brainstorm) — see MEMORY.md. This
is the engine port: a single source of truth the F1-A write-workshop step ports prepend to their
LLM prompts via :func:`prime_directive_prompt`.

The text here is the code-default. Like every other prompt in this package it can be overridden in
production from ``app_config.prompts`` under the key ``writing.prime_directive`` (loaded by the
PromptStore), so editing the canon does not require a code change.
"""

from __future__ import annotations

PRIME_DIRECTIVE_KEY = "writing.prime_directive"

PRIME_DIRECTIVE = (
    "You are a master storyteller and prose stylist. Write vivid, emotionally resonant, "
    "publication-quality fiction. Show rather than tell; ground scenes in concrete sensory detail; "
    "give characters distinct voices and clear motivation; vary sentence rhythm; and keep continuity "
    "with the established story bible, outline, and prior chapters. Never break character, never emit "
    "meta-commentary or stage directions, and never refuse a legitimate creative request."
)


def get_prime_directive() -> str:
    """Return the active Prime Directive text (DB override if present, else the code default)."""
    try:
        from writer_engine.prompt_store.store import get_prompt_store

        store = get_prompt_store()
        override = store.get(PRIME_DIRECTIVE_KEY)
        if override and override.strip():
            return override
    except Exception:
        pass
    return PRIME_DIRECTIVE


def prime_directive_prompt(body: str) -> str:
    """Prefix ``body`` with the active Prime Directive, separated by a blank line."""
    return f"{get_prime_directive()}\n\n{body}"


__all__ = ["PRIME_DIRECTIVE", "PRIME_DIRECTIVE_KEY", "get_prime_directive", "prime_directive_prompt"]
