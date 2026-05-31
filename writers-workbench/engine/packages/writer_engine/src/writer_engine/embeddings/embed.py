"""OpenAI embeddings + pgvector match, behind the ENABLE_PYTHON_EMBEDDINGS flag.

The ``openai`` package is imported lazily inside :func:`embed_texts` so it is NOT a hard dependency
of the engine — the default-off path (n8n shim) never touches it. Install ``openai`` only on
services that flip the flag on.
"""

from __future__ import annotations

from typing import Any

from writer_engine.config import get_settings


def embeddings_enabled() -> bool:
    """True when the Python embeddings path is turned on. Callers fall through to n8n when False."""
    return bool(get_settings().enable_python_embeddings)


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Return an embedding vector per input string via OpenAI.

    Raises ``RuntimeError`` if the flag is off or ``OPENAI_API_KEY`` is unset, and ``ImportError``
    (surfaced as RuntimeError) if the optional ``openai`` package is not installed — callers should
    gate on :func:`embeddings_enabled` first.
    """
    settings = get_settings()
    if not settings.enable_python_embeddings:
        raise RuntimeError("Python embeddings disabled (ENABLE_PYTHON_EMBEDDINGS=false)")
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY not set — cannot embed")
    if not texts:
        return []

    try:
        from openai import AsyncOpenAI
    except ImportError as exc:  # pragma: no cover - optional dep
        raise RuntimeError(
            "openai package not installed; add it to the service that sets "
            "ENABLE_PYTHON_EMBEDDINGS=true"
        ) from exc

    client = AsyncOpenAI(api_key=settings.openai_api_key)
    resp = await client.embeddings.create(model=settings.embedding_model, input=texts)
    # Preserve input order (OpenAI returns data sorted by index, but be explicit).
    ordered = sorted(resp.data, key=lambda d: d.index)
    return [d.embedding for d in ordered]


async def match_writing_documents(
    *,
    query: str,
    user_id: str,
    project_title: str | None = None,
    match_count: int = 5,
    match_threshold: float = 0.7,
) -> list[dict[str, Any]]:
    """pgvector similarity search over a user's writing documents via a Supabase RPC.

    Embeds ``query`` then calls the ``EMBEDDING_MATCH_RPC`` Postgres function (default
    ``match_writing_documents``) with the query embedding. Returns the matched rows (possibly empty).
    Returns ``[]`` when embeddings are disabled rather than raising, so retrieval degrades gracefully.
    """
    if not embeddings_enabled():
        return []
    settings = get_settings()
    vectors = await embed_texts([query])
    if not vectors:
        return []

    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    params: dict[str, Any] = {
        "query_embedding": vectors[0],
        "match_count": match_count,
        "match_threshold": match_threshold,
        "p_user_id": user_id,
    }
    if project_title:
        params["p_project_title"] = project_title
    resp = await client.rpc(settings.embedding_match_rpc, params).execute()
    return list(resp.data or [])


async def re_embed_project(*, user_id: str, project_title: str) -> int:
    """Re-embed every stored chunk for a project. Best-effort; returns the count re-embedded.

    No-ops (returns 0) when embeddings are disabled. Reads chunks from ``writing_documents``,
    embeds them in one batch, and upserts the vectors back. Kept intentionally simple — the heavy
    chunking lives upstream; this only refreshes vectors after a model/content change.
    """
    if not embeddings_enabled():
        return 0

    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    rows_resp = (
        await client.table("writing_documents")
        .select("id, content")
        .eq("user_id", user_id)
        .eq("project_title", project_title)
        .execute()
    )
    rows = list(rows_resp.data or [])
    if not rows:
        return 0

    vectors = await embed_texts([r.get("content") or "" for r in rows])
    count = 0
    for row, vec in zip(rows, vectors, strict=False):
        await (
            client.table("writing_documents")
            .update({"embedding": vec})
            .eq("id", row["id"])
            .execute()
        )
        count += 1
    return count
