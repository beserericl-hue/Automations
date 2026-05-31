"""Verbatim n8n prompt seeds (ported from /tmp/wf.json `Content - Newsletter Agent V2`).

The original n8n expression-language tokens (``{{ ... }}``, ``$json``, ``$node[...]``, etc.) are preserved
verbatim — that is what makes this the L5 parity baseline. Because those tokens are not valid Python
``.format()`` placeholders, the seeds are loaded under a separate ``n8n_baseline.*`` namespace and the step
services keep using the placeholder seeds until the token-mapping work in Sprint 17 lands. After mapping,
flip the step service to read from ``n8n_baseline.*`` and the L5 parity diff vs n8n drops to near-zero.

Use ``writer_engine.prompt_store.get_prompt_store().get("n8n_baseline.newsletter.pick_top_stories.user_template")``
to inspect what the n8n workflow actually fed Gemini for each step.
"""

from __future__ import annotations

from importlib.resources import files

from writer_engine.prompt_store.store import get_prompt_store

N8N_BASELINE_PREFIX = "n8n_baseline."

N8N_SEED_KEYS: list[str] = [
    "newsletter.pick_top_stories.user_template",
    "newsletter.subject.user_template",
    "newsletter.segment.user_template",
    "newsletter.intro.user_template",
    "newsletter.other_top_stories.user_template",
    "newsletter.edit_top_stories.user_template",
    "newsletter.edit_subject_line.user_template",
    "newsletter.image.user_template",
]


def load_n8n_seeds() -> int:
    """Load every ``.txt`` shipped here under the ``n8n_baseline.*`` prefix. Idempotent."""
    store = get_prompt_store()
    pkg = files("writer_engine.prompt_store.n8n_seeds")
    loaded = 0
    for key in N8N_SEED_KEYS:
        try:
            text = (pkg / f"{key}.txt").read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        store.register_default(N8N_BASELINE_PREFIX + key, text)
        loaded += 1
    return loaded
