"""OpenAI embeddings + pgvector match, behind the ENABLE_PYTHON_EMBEDDINGS flag.

The ``openai`` package is imported lazily inside :func:`embed_texts` so it is NOT a hard dependency
of the engine — the default-off path (n8n shim) never touches it. Install ``openai`` only on
services that flip the flag on.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
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

CANON_STALE_GRACE_S = 120
"""Seconds an outline may be newer than its canon before the canon counts as stale. Covers the
indexer's own runtime plus clock skew between the app and Postgres."""

CanonChunk = dict[str, Any]


def _parse_ts(value: object) -> datetime | None:
    """Parse a PostgREST timestamp. None when it cannot be read."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _chunk(doc_type: str, doc_id: str, doc_title: str, content: str) -> CanonChunk | None:
    body = (content or "").strip()
    return (
        {"doc_type": doc_type, "doc_id": str(doc_id), "doc_title": doc_title, "content": body}
        if body
        else None
    )


RESEARCH_DOC_TYPE = "chapter_research"
"""Per-chapter research: the cited facts and local colour attached to a chapter's outline entry.

Its own doc type rather than extra text on ``chapter_brief``, for three reasons:

* **A brief and a fact answer different queries.** The brief is what the chapter is *supposed* to
  do; the research is what is *true* about the period and the object. Retrieval should be able to
  return one without the other, and a 4,000-character research block appended to a 300-character
  brief would swamp it in every similarity search.
* **It is separately refreshable.** Research is re-run far more often than an outline is rewritten.
* **It is attributable.** Each fact carries its source, so what the model is handed can be traced
  back to a citation rather than blended into the plan.

Found on The Ossuary, 2026-10-18: 149 cited facts were attached to the outline by a chapter-by-
chapter research study and were invisible to ``chapter.write``, because ``build_canon_chunks`` read
only ``beat``/``arc_notes``/``bridge_from_prior``. The study was in the product and not in the prose.
"""

_MAX_RESEARCH_FACTS = 12
"""Cap per chapter, so one richly-researched chapter cannot dominate retrieval for the whole book."""


def _research_chunk(ch: dict[str, Any], num: int, title: str) -> CanonChunk | None:
    """The ``chapter_research`` chunk for one chapter, or None when it carries no research.

    Facts keep their sources inline: the writer is told *that* a number is attested and *where*,
    which is what stops a researched detail being quietly rounded off in the prose.
    """
    research = ch.get("research")
    if not isinstance(research, dict):
        return None

    parts: list[str] = []
    period = str(research.get("period") or "").strip()
    if period:
        parts.append(f"Period: {period}")

    facts = [f for f in (research.get("facts") or []) if isinstance(f, dict)]
    for fact in facts[:_MAX_RESEARCH_FACTS]:
        text = str(fact.get("fact") or "").strip()
        if not text:
            continue
        source = str(fact.get("source") or "").strip()
        parts.append(f"FACT: {text}" + (f" [{source}]" if source else ""))

    for colour in (research.get("local_color") or [])[:_MAX_RESEARCH_FACTS]:
        text = str(colour or "").strip()
        if text:
            parts.append(f"LOCAL COLOUR: {text}")

    # Flags are deliberately INCLUDED. They are the places the research contradicts the outline or
    # marks something as invention, and a writer who cannot see them will confidently dramatise a
    # pre-contact epidemic the record does not support.
    for flag in (research.get("flags") or [])[:_MAX_RESEARCH_FACTS]:
        text = str(flag or "").strip()
        if text:
            parts.append(f"CAUTION: {text}")

    if not parts:
        return None
    heading = f"Ch {num} research — {title}" if title else f"Ch {num} research"
    return _chunk(RESEARCH_DOC_TYPE, f"ch_{num}_research", heading, "\n".join(parts))


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
        chunks.append(_research_chunk(ch, num, title))

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
    #
    # Counted over the CANON doc types only. `chapter_prose` is written by index_chapter_prose, not
    # by this chunker, so including it compares apples to oranges — and after J1's backfill that
    # comparison locked reindexing out of the project it was built for: The Burial Mound carries
    # 2,996 vectors of which 1,879 are prose, so a canon reindex producing ~1,100 chunks read as a
    # 63% coverage DROP and raised RuntimeError. Measured 2026-10-18.
    existing_resp = (
        await client.table(EMBEDDINGS_TABLE)
        .select("id")
        .eq("user_id", user_id)
        .eq("project_id", str(project_id))
        .neq("doc_type", PROSE_DOC_TYPE)
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

    # Scoped to the CANON doc types. Without the `neq`, this delete took the project's
    # `chapter_prose` rows with it — so a canon reindex silently destroyed J3's prose index (1,879
    # chunks on The Burial Mound) and it only came back one chapter at a time, as each was next
    # written. The two indexes have different owners and different lifecycles; neither may clear the
    # other's rows.
    await (
        client.table(EMBEDDINGS_TABLE)
        .delete()
        .eq("user_id", user_id)
        .eq("project_id", str(project_id))
        .neq("doc_type", PROSE_DOC_TYPE)
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


# --- J3: the written prose, not just the plan --------------------------------------------------
#
# `build_canon_chunks` indexes the outline and the bible, so retrieval returns what a chapter was
# SUPPOSED to contain and never what it said. Measured on The Burial Mound: chapter 50 was written
# knowing chapter 49's one-line brief, not its prose. Cross-chapter continuity rested entirely on
# the outline plus `bridge_from_prior`, which held for 96 chapters of an unusually detailed outline
# and would not hold for a thin one. This is the substance of I3.
#
# Three decisions:
#
# * **One chunk per SCENE, not per chapter.** A 7k-word chapter embedded as a single vector averages
#   everything in it and retrieves nothing specific. Scenes are ~1.4k words and the `---` separators
#   now exist (A13). Chapters written before A13 have none, so those fall back to word windows.
# * **Indexed incrementally, after a chapter persists.** `index_project_canon` runs on every outline
#   save; re-embedding a whole novel each time would be wasteful and slow. A chapter's prose is
#   re-indexed only when that chapter is written.
# * **Scoped deletes.** The prose refresh deletes only `ch_<n>_s*` for the one chapter, so it cannot
#   touch the outline canon or another chapter's scenes.

PROSE_DOC_TYPE = "chapter_prose"

# Fallback window for pre-A13 chapters with no scene separators. 400 words is small enough that an
# embedding still means something and large enough to carry a scene's worth of context.
PROSE_WINDOW_WORDS = 400

_SCENE_SPLIT_RE = re.compile(r"\n\s*-{3,}\s*\n")


def build_prose_chunks(
    *, chapter_number: int, title: str, text: str, window_words: int = PROSE_WINDOW_WORDS
) -> list[CanonChunk]:
    """Scene-level chunks for one written chapter."""
    body = (text or "").strip()
    if not body:
        return []
    scenes = [s.strip() for s in _SCENE_SPLIT_RE.split(body) if s.strip()]
    if len(scenes) <= 1:
        # Pre-A13 chapter: no separators, so fall back to paragraph-aligned word windows rather
        # than embedding the whole chapter as one averaged vector.
        scenes = []
        current: list[str] = []
        count = 0
        for para in re.split(r"\n\s*\n", body):
            words = len(para.split())
            if current and count + words > window_words:
                scenes.append("\n\n".join(current))
                current, count = [], 0
            current.append(para.strip())
            count += words
        if current:
            scenes.append("\n\n".join(current))

    label = str(title or "").strip()
    out: list[CanonChunk] = []
    for i, scene in enumerate(scenes, 1):
        head = f"Ch {chapter_number}" + (f" — {label}" if label else "")
        chunk = _chunk(
            PROSE_DOC_TYPE,
            f"ch_{chapter_number}_s{i}",
            f"{head} (scene {i})",
            f"From chapter {chapter_number}" + (f', "{label}"' if label else "") + f", scene {i}:\n{scene}",
        )
        if chunk:
            out.append(chunk)
    return out


async def index_chapter_prose(
    *, user_id: str, project_id: str, chapter_number: int, title: str, text: str
) -> int:
    """Index one written chapter's prose as retrievable canon. Returns the chunk count.

    Best-effort and never raises: a chapter that is written and persisted must not fail because its
    vectors could not be built.
    """
    if not embeddings_enabled():
        return 0
    chunks = build_prose_chunks(chapter_number=chapter_number, title=title, text=text)
    if not chunks:
        return 0
    try:
        vectors = await embed_texts([c["content"] for c in chunks])
        if len(vectors) != len(chunks):
            logger.warning("embeddings.prose_vector_count_mismatch", chunks=len(chunks), vectors=len(vectors))
            return 0

        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        # Scoped to this chapter's scenes only — never the outline canon, never another chapter.
        await (
            client.table(EMBEDDINGS_TABLE)
            .delete()
            .eq("user_id", user_id)
            .eq("project_id", str(project_id))
            .eq("doc_type", PROSE_DOC_TYPE)
            .like("doc_id", f"ch_{chapter_number}_s%")
            .execute()
        )
        rows = [
            {
                "user_id": user_id,
                "project_id": str(project_id),
                "doc_type": c["doc_type"],
                "doc_id": c["doc_id"],
                "doc_title": c["doc_title"],
                "content": c["content"],
                "embedding": vec,
            }
            for c, vec in zip(chunks, vectors, strict=False)
        ]
        await client.table(EMBEDDINGS_TABLE).insert(rows).execute()
        logger.info(
            "embeddings.prose_indexed", project_id=str(project_id), chapter=chapter_number, scenes=len(rows)
        )
        return len(rows)
    except Exception as exc:
        logger.warning(
            "embeddings.prose_index_failed",
            project_id=str(project_id),
            chapter=chapter_number,
            error=f"{type(exc).__name__}: {str(exc)[:160]}",
        )
        return 0


# --- canon freshness ----------------------------------------------------------------------------
#
# `index_project_canon` only ever ran from a brainstorm outline SAVE (`_REINDEX_OPS` in
# brainstorm_step: story / short-story / edit-outline / revise-outline). Anything else that changes
# an outline leaves the vectors behind, and retrieval then serves a plan that no longer exists.
#
# Measured on The Ossuary, 2026-10-18: the outline was edited four times in one session — factual
# corrections, place names, and 149 research facts — by writes that did not go through a brainstorm
# op. None of it re-embedded. The project kept serving 97 `chapter_brief` vectors built before every
# one of those edits.
#
# A trigger on every write path cannot fix this on its own, because an outline can legitimately be
# changed by something that is not an engine op at all (a migration, an admin fix, a direct edit).
# So the engine detects staleness from the data instead of trusting that it was told.


async def canon_staleness(*, user_id: str, project_id: str) -> dict[str, Any]:
    """Is this project's canon older than its outline?

    Returns ``{stale, project_updated_at, canon_indexed_at, canon_rows, reason}``. Never raises:
    an unanswerable question reports ``stale=False`` with a reason, because blocking a chapter write
    on a freshness probe would be a worse failure than writing against slightly old canon.
    """
    from writer_engine.supabase.client import get_supabase_admin

    out: dict[str, Any] = {
        "stale": False,
        "project_updated_at": None,
        "canon_indexed_at": None,
        "canon_rows": 0,
        "reason": "",
    }
    try:
        client = await get_supabase_admin()
        proj = _rows(
            await client.table("writing_projects_v2")
            .select("updated_at")
            .eq("id", str(project_id))
            .limit(1)
            .execute()
        )
        if not proj:
            out["reason"] = "project not found"
            return out
        out["project_updated_at"] = proj[0].get("updated_at")

        newest = _rows(
            await client.table(EMBEDDINGS_TABLE)
            .select("created_at")
            .eq("user_id", user_id)
            .eq("project_id", str(project_id))
            .neq("doc_type", PROSE_DOC_TYPE)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        count_rows = _rows(
            await client.table(EMBEDDINGS_TABLE)
            .select("id")
            .eq("user_id", user_id)
            .eq("project_id", str(project_id))
            .neq("doc_type", PROSE_DOC_TYPE)
            .execute()
        )
        out["canon_rows"] = len(count_rows)
        if not newest:
            out["stale"] = True
            out["reason"] = "no canon indexed for this project"
            return out
        out["canon_indexed_at"] = newest[0].get("created_at")
    except Exception as exc:
        out["reason"] = f"freshness probe failed: {type(exc).__name__}"
        return out

    pu = _parse_ts(out["project_updated_at"])
    ci = _parse_ts(out["canon_indexed_at"])
    if pu is None or ci is None:
        out["reason"] = "unreadable timestamp"
        return out
    # A grace window, because the indexer itself touches nothing but takes time: a reindex that
    # finishes seconds after the outline write that triggered it must not read as stale.
    if pu > ci + timedelta(seconds=CANON_STALE_GRACE_S):
        out["stale"] = True
        out["reason"] = f"outline changed {int((pu - ci).total_seconds())}s after the last reindex"
    else:
        out["reason"] = "fresh"
    return out


async def reindex_if_stale(*, user_id: str, project_id: str) -> dict[str, Any]:
    """Reindex a project's canon when its outline is newer than its vectors.

    Best-effort in both directions: it never raises, and it reports what it decided so a caller can
    log it. Cheap enough to be worth doing on the write path — a 96-chapter project is a few cents
    of text-embedding-3-small — and the alternative is prose written against a superseded plan.
    """
    state = await canon_staleness(user_id=user_id, project_id=project_id)
    if not state["stale"]:
        return {"reindexed": False, **state}
    try:
        chunks = await index_project_canon(user_id=user_id, project_id=project_id)
    except Exception as exc:
        logger.warning(
            "embeddings.stale_reindex_failed",
            project_id=str(project_id),
            error=f"{type(exc).__name__}: {exc}"[:200],
        )
        return {"reindexed": False, "error": f"{type(exc).__name__}: {exc}"[:200], **state}
    logger.info(
        "embeddings.stale_reindex",
        project_id=str(project_id),
        chunks=chunks,
        reason=state["reason"],
    )
    return {"reindexed": True, "chunks": chunks, **state}
