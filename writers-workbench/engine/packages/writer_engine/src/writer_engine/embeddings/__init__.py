"""Embeddings adapter (F1-A prereq #5).

Gated behind ``EngineSettings.enable_python_embeddings`` (env ``ENABLE_PYTHON_EMBEDDINGS``).
When the flag is OFF (the default), :func:`embeddings_enabled` returns False and callers fall
through to the existing n8n embedding shim — so shipping this package is non-breaking.

Public surface (mirrors the n8n embedding sub-flow):
- :func:`embed_texts` — OpenAI embeddings for a batch of strings.
- :func:`match_project_canon` — pgvector similarity search over writing_embeddings_v2 (A3).
- :func:`re_embed_project` — re-embed all chunks for a project (async, best-effort).
"""

from __future__ import annotations

from .embed import (
    embed_texts,
    embeddings_enabled,
    match_project_canon,
    re_embed_project,
)

__all__ = [
    "embed_texts",
    "embeddings_enabled",
    "match_project_canon",
    "re_embed_project",
]
