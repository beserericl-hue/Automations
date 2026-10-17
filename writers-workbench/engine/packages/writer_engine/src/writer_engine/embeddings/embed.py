"""OpenAI embeddings + pgvector match, behind the ENABLE_PYTHON_EMBEDDINGS flag.

The ``openai`` package is imported lazily inside :func:`embed_texts` so it is NOT a hard dependency
of the engine — the default-off path (n8n shim) never touches it. Install ``openai`` only on
services that flip the flag on.
"""

from __future__ import annotations

from typing import Any

from writer_engine import outline_keys
from writer_engine.config import get_settings
from writer_engine.rate_limit.provider_budget import call_provider
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

    # B8: budgeted like every other provider. The OpenAI SDK already retries a 429 itself, so this
    # adds the account-wide window (shared across instances) rather than another retry. Token count
    # is estimated at ~4 chars/token because the embedding limit is token-shaped.
    est_tokens = sum(len(t) for t in texts) // 4

    async def _embed() -> Any:
        return await client.embeddings.create(model=settings.embedding_model, input=texts)

    resp = await call_provider(
        "openai",
        _embed,
        model=settings.embedding_model,
        input_tokens=est_tokens,
        attempts=1,  # the OpenAI SDK retries a 429 itself; another layer would multiply the wait
        max_wait_s=30.0,
    )
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


# --- A3: the producer -------------------------------------------------------------------------
#
# Nothing in the engine wrote `writing_embeddings_v2` — `re_embed_project` only refreshes vectors on
# rows that already exist. So retrieval (match_project_canon) had nothing to find for any project the
# n8n `Sub - Embed Project Data` workflow had not already indexed, and once n8n is switched off (E1)
# no new project would ever get canon at all.
#
# Chunk conventions below mirror the rows n8n actually produced on DEV, so engine-indexed and
# n8n-indexed projects stay queryable by the same retrieval:
#
#   premise        doc_id "premise"      title "Book Premise"
#   book_arc       doc_id "book_arc"     title "Book Story Arc: <name>"
#   character      doc_id "<name>"       title "<name> (<role>)"
#   chapter_brief  doc_id "ch_<n>"       title "Ch <n> — <title>"
#   bible_entry    doc_id "<row uuid>"   title "[<entry_type>] <name>"

# A reindex replacing fewer than this fraction of the existing rows is treated as a chunker bug
# rather than a legitimate shrink. See the guard in index_project_canon.
MIN_REINDEX_COVERAGE = 0.6

CanonChunk = dict[str, Any]


def _chunk(doc_type: str, doc_id: str, doc_title: str, content: str) -> CanonChunk | None:
    body = (content or "").strip()
    return (
        {"doc_type": doc_type, "doc_id": str(doc_id), "doc_title": doc_title, "content": body}
        if body
        else None
    )


def build_canon_chunks(outline: dict[str, Any], bible_rows: list[dict[str, Any]]) -> list[CanonChunk]:
    """Turn a project's outline + story-bible rows into the chunk set to embed.

    Pure (no I/O) so the chunking is unit-testable without Supabase or OpenAI.
    """
    chunks: list[CanonChunk | None] = [
        _chunk("premise", "premise", "Book Premise", str(outline.get("premise") or "")),
    ]

    arc_name = str(outline.get("story_arc_name") or "").strip()
    if arc_name:
        arc_body = "\n".join(
            str(outline.get(k) or "") for k in ("story_arc_prompt", "dramatic_question")
        ).strip()
        chunks.append(_chunk("book_arc", "book_arc", f"Book Story Arc: {arc_name}", arc_body or arc_name))

    for c in outline.get("characters") or []:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        role = str(c.get("role") or "").strip()
        body = "\n".join(
            part
            for part in (
                f"Character: {name}",
                f"Role: {role}" if role else "",
                f"Description: {c.get('description') or ''}".strip(),
            )
            if part
        )
        chunks.append(_chunk("character", name, f"{name} ({role})" if role else name, body))

    for ch in outline.get("chapters") or []:
        if not isinstance(ch, dict):
            continue
        # Via writer_engine.outline_keys: this read only `number`, so for the sixteen engine-shaped
        # projects (which key on `chapter_number`) EVERY chapter was skipped — no chapter_brief and
        # no sub_chapter chunks were ever built, which is why only n8n-shaped projects had any rows
        # in writing_embeddings_v2 at all.
        num = outline_keys.chapter_number(ch)
        if num is None:
            continue
        title = str(ch.get("title") or "").strip()
        body = "\n".join(
            part
            for part in (
                outline_keys.chapter_body(ch),
                str(ch.get("arc_notes") or "").strip(),
                str(ch.get("bridge_from_prior") or "").strip(),
            )
            if part
        )
        chunks.append(
            _chunk("chapter_brief", f"ch_{num}", f"Ch {num} — {title}" if title else f"Ch {num}", body)
        )

        # sub_chapter is the LARGEST doc_type n8n produced (126 of 169 rows on one DEV project), and
        # the richest per-scene canon there is. Omitting it would make a reindex destructive: the
        # delete-then-insert would drop every sub_chapter row and never regenerate it.
        for sub in outline_keys.sub_chapters(ch):
            s_num = sub.get("number")
            s_title = str(sub.get("title") or "").strip()
            if s_num is None:
                continue
            s_body = "\n".join(
                part
                for part in (
                    f"Sub-chapter {s_num} of Chapter {num}: {s_title}".strip(),
                    f"Brief: {sub.get('brief') or sub.get('beat') or ''}".strip(),
                    f"Arc beat: {sub.get('arc_beat') or ''}".strip() if sub.get("arc_beat") else "",
                    f"Setting: {sub.get('setting') or ''}".strip() if sub.get("setting") else "",
                    f"Characters: {', '.join(str(c) for c in sub.get('characters') or [])}"
                    if sub.get("characters")
                    else "",
                    f"Emotional tone: {sub.get('emotional_tone') or ''}".strip()
                    if sub.get("emotional_tone")
                    else "",
                )
                if part and not part.endswith(":")
            )
            chunks.append(
                _chunk(
                    "sub_chapter",
                    f"ch{num}_sc{s_num}",
                    f"Ch{num} Sub{s_num}: {s_title}" if s_title else f"Ch{num} Sub{s_num}",
                    s_body,
                )
            )

    for row in bible_rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        etype = str(row.get("entry_type") or "entry").strip()
        if not name:
            continue
        body = f"{etype}: {name}\nDescription: {row.get('description') or ''}".strip()
        chunks.append(_chunk("bible_entry", str(row.get("id") or name), f"[{etype}] {name}", body))

    return [c for c in chunks if c]


async def index_project_canon(*, user_id: str, project_id: str) -> int:
    """(Re)build a project's canon vectors. Returns the number of chunks indexed.

    Idempotent by delete-then-insert scoped to ``(user_id, project_id)`` — the table has no unique
    constraint on (user_id, project_id, doc_type, doc_id), so a true upsert is not available and a
    full reindex is the honest operation. Embedding happens BEFORE the delete so a provider failure
    leaves the existing canon intact rather than wiping it.

    No-ops (returns 0) when embeddings are disabled.
    """
    if not embeddings_enabled():
        return 0

    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    proj_resp = (
        await client.table("writing_projects_v2")
        .select("outline")
        .eq("id", str(project_id))
        .limit(1)
        .execute()
    )
    proj = _rows(proj_resp)
    outline = (proj[0].get("outline") if proj else None) or {}
    if not isinstance(outline, dict):
        outline = {}

    bible_resp = (
        await client.table("story_bible_v2")
        .select("id, entry_type, name, description")
        .eq("project_id", str(project_id))
        .is_("deleted_at", "null")
        .execute()
    )
    chunks = build_canon_chunks(outline, _rows(bible_resp))
    if not chunks:
        return 0

    # Embed first: a provider failure here must not leave the project with no canon.
    vectors = await embed_texts([c["content"] for c in chunks])
    if len(vectors) != len(chunks):
        logger.warning("embeddings.index_vector_count_mismatch", chunks=len(chunks), vectors=len(vectors))
        return 0

    # Coverage guard. The reindex is delete-then-insert, so a chunker that silently stops producing
    # a doc_type would WIPE that canon. (Caught for real: the first version of build_canon_chunks
    # omitted sub_chapter, the largest doc_type — 126 of 169 rows on one project — so a reindex would
    # have destroyed ~75% of it.) Refuse to replace a materially larger existing set.
    existing_resp = (
        await client.table(EMBEDDINGS_TABLE)
        .select("id")
        .eq("user_id", user_id)
        .eq("project_id", str(project_id))
        .execute()
    )
    existing = len(_rows(existing_resp))
    if existing and len(chunks) < existing * MIN_REINDEX_COVERAGE:
        logger.error(
            "embeddings.index_refused_coverage_drop",
            project_id=str(project_id),
            existing=existing,
            new=len(chunks),
            min_ratio=MIN_REINDEX_COVERAGE,
        )
        raise RuntimeError(
            f"refusing to reindex project {project_id}: would replace {existing} canon rows with "
            f"only {len(chunks)} (below {MIN_REINDEX_COVERAGE:.0%} coverage). Check the chunker "
            "covers every doc_type before forcing this."
        )

    await (
        client.table(EMBEDDINGS_TABLE)
        .delete()
        .eq("user_id", user_id)
        .eq("project_id", str(project_id))
        .execute()
    )
    payload = [
        {
            "user_id": user_id,
            "project_id": str(project_id),
            "doc_type": c["doc_type"],
            "doc_id": c["doc_id"],
            "doc_title": c["doc_title"],
            "content": c["content"],
            "metadata": {},
            "embedding": vec,
        }
        for c, vec in zip(chunks, vectors, strict=False)
    ]
    await client.table(EMBEDDINGS_TABLE).insert(payload).execute()
    logger.info("embeddings.indexed", project_id=str(project_id), chunks=len(payload))
    return len(payload)
