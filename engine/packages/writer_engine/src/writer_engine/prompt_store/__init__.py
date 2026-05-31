"""Prompt registry — code defaults + verbatim n8n overrides + DB override with hot reload.

Three layers:

1. :data:`DEFAULT_PROMPTS` — minimal placeholders (always available, parse-friendly).
2. ``n8n_seeds/*.txt`` — verbatim text ported from the n8n ``Content - Newsletter Agent V2`` workflow; loaded as
   overrides above the placeholders. Preserves n8n expression tokens (``{{ ... }}``, ``$json``, ``$node[...]``).
3. ``app_config.prompts`` (Supabase) — true production overrides; reloaded on ``POST /admin/reload-prompts``.
"""

from .n8n_seeds import N8N_SEED_KEYS, load_n8n_seeds
from .seeds import DEFAULT_PROMPTS, seed_default_prompts
from .store import PromptStore, get_prompt_store

__all__ = [
    "DEFAULT_PROMPTS",
    "N8N_SEED_KEYS",
    "PromptStore",
    "get_prompt_store",
    "load_n8n_seeds",
    "seed_default_prompts",
]
