"""OpenAI embeddings + pgvector match, behind the ENABLE_PYTHON_EMBEDDINGS flag.

The ``openai`` package is imported lazily inside :func:`embed_texts` so it is NOT a hard dependency
of the engine — the default-off path (n8n shim) never touches it. Install ``openai`` only on
services that flip the flag on.
"""

from __future__ import annotations

from typing import Any

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

logger = get_logger("embeddings")

# The table the n8n `Sub - Embed Project Data` workflow actually populates. NOT
# `writing_documents`, which this module previously referenced and which exists nowhere (A3).
EMBEDDINGS_TABLE = "writing_embeddings_v2"


def _rows(resp: Any) -> list[dict[str, Any]]:
    """Coerce a Supabase/postgrest response's ``.data`` into a list of row dicts.

    postgrest types ``.data`` as a broad JSON union, so indexing it or calling ``.get`` on its
    elements is unchecked and would raise at runtime on an unexpected shape. Guard once at the
    boundary instead of casting at every use.
    """
    data = getattr(resp, "data", None)
    if not isinstance(data, list):
        return []
    return [row for row in data if isinstance(row, dict)]


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
            "openai package not installed; add it to the service that sets ENABLE_PYTHON_EMBEDDINGS=true"
        ) from exc

    client = AsyncOpenAI(api_key=settings.openai_api_key)
    resp = await client.embeddings.create(model=settings.embedding_model, input=texts)
    # Preserve input order (OpenAI returns data sorted by index, but be explicit).
    ordered = sorted(resp.data, key=lambda d: d.index)
    return [d.embedding for d in ordered]


async def match_project_canon(
    *,
    query: str,
    user_id: str,
    project_id: str | None = None,
    match_count: int = 5,
    match_threshold: float = 0.7,
) -> list[dict[str, Any]]:
    """pgvector similarity search over a project's canon (``writing_embeddings_v2``).

    A3 corrections (2026-10-16): this previously sent ``p_project_title`` to an RPC named
    ``match_writing_documents``. Probing DEV showed NO such function exists under that or any
    related name — n8n did its vector search through the Supabase Vector Store node's own SQL rather
    than a stored function — and the table scoping key is ``project_id``, not a title. The function
    ships as migration 027; until it is applied this returns ``[]``.

    Returns ``[]`` when embeddings are disabled or the RPC is absent, so retrieval degrades
    gracefully instead of failing a chapter write.
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
    if project_id:
        params["p_project_id"] = str(project_id)
    try:
        resp = await client.rpc(settings.embedding_match_rpc, params).execute()
    except Exception as exc:
        # Most likely PGRST202 — migration 027 not applied in this environment yet.
        logger.warning("embeddings.match_unavailable", rpc=settings.embedding_match_rpc, error=str(exc)[:160])
        return []
    return _rows(resp)


async def re_embed_project(*, user_id: str, project_id: str) -> int:
    """Re-embed every stored canon chunk for a project. Best-effort; returns the count re-embedded.

    A3 correction (2026-10-16): this read and wrote a table named ``writing_documents``, which does
    not exist in either Supabase project — the real table is ``writing_embeddings_v2`` (populated by
    the n8n ``Sub - Embed Project Data`` workflow) — and it filtered on ``project_title`` where the
    real scoping column is ``project_id``. As written it would have 404'd on every call, which is
    why enabling ENABLE_PYTHON_EMBEDDINGS was never a flag flip.

    No-ops (returns 0) when embeddings are disabled. The heavy chunking lives upstream; this only
    refreshes vectors for rows that already exist.
    """
    if not embeddings_enabled():
        return 0

    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    rows_resp = (
        await client.table(EMBEDDINGS_TABLE)
        .select("id, content")
        .eq("user_id", user_id)
        .eq("project_id", str(project_id))
        .execute()
    )
    rows = _rows(rows_resp)
    if not rows:
        return 0

    vectors = await embed_texts([str(r.get("content") or "") for r in rows])
    count = 0
    for row, vec in zip(rows, vectors, strict=False):
        await client.table(EMBEDDINGS_TABLE).update({"embedding": vec}).eq("id", row["id"]).execute()
        count += 1
    return count
