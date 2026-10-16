-- 027_engine_embedding_match.sql
--
-- A3 (remaining-work inventory): give the engine a server-side vector search over
-- `writing_embeddings_v2` so chapter writes can be grounded in project canon.
--
-- WHY THIS IS NEEDED AT ALL. The inventory recorded A3 as "code exists, flag off" — enable
-- ENABLE_PYTHON_EMBEDDINGS and go. That was wrong, and this migration is the missing half:
--
--   * `writer_engine.embeddings.embed` was written against a table named `writing_documents`,
--     which does not exist in either Supabase project (the real table is `writing_embeddings_v2`,
--     384 rows on DEV, populated by the n8n `Sub - Embed Project Data` workflow).
--   * `EngineSettings.embedding_match_rpc` defaults to `match_writing_documents`, and NO
--     match function exists under that or any related name. Probed on DEV 2026-10-16:
--     match_writing_documents / match_writing_embeddings / match_writing_embeddings_v2 /
--     match_documents all return PGRST202 (no such function), including when probed with the
--     exact parameter names the code sends.
--
-- n8n never needed a stored function — its Supabase Vector Store node issues its own SQL — so
-- turning the engine's flag on today would 404 on every call. Retrieval has to be built, not
-- enabled.
--
-- GOVERNANCE. Additive only: creates one new function. Touches no base table, so it is legal for a
-- migration numbered >= 008 per docs/schema-governance.md ("May create new tables, indexes,
-- functions"). `CREATE OR REPLACE` here is on a brand-new function, not one any base table depends
-- on, so it does not hit the forbidden-operations list.
--
-- NOT YET APPLIED. Apply to DEV first (the pooler DSN lives in the Railway `WritersWorkbench`
-- service `DATABASE_URL`; the engine `.env` carries REST credentials only, which cannot run DDL).
-- PROD application is a Tier-3 change and needs explicit sign-off.

-- p_project_id is text and compared with a cast so this works whether `project_id` is typed uuid or
-- text, and so PostgREST can call it with a plain JSON string.
CREATE OR REPLACE FUNCTION match_writing_embeddings_v2(
    query_embedding vector,
    match_count     int   DEFAULT 8,
    match_threshold float DEFAULT 0.0,
    p_user_id       text  DEFAULT NULL,
    p_project_id    text  DEFAULT NULL
)
RETURNS TABLE (
    id         uuid,
    doc_type   text,
    doc_id     text,
    doc_title  text,
    content    text,
    metadata   jsonb,
    similarity float
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        e.id,
        e.doc_type,
        e.doc_id,
        e.doc_title,
        e.content,
        e.metadata,
        -- Cosine distance (<=>) inverted into a 0..1 similarity, matching the convention the
        -- engine's match_writing_documents() caller expects.
        1 - (e.embedding <=> query_embedding) AS similarity
    FROM writing_embeddings_v2 e
    WHERE (p_user_id    IS NULL OR e.user_id = p_user_id)
      AND (p_project_id IS NULL OR e.project_id::text = p_project_id)
      AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
    ORDER BY e.embedding <=> query_embedding
    LIMIT GREATEST(match_count, 1);
$$;

COMMENT ON FUNCTION match_writing_embeddings_v2 IS
    'A3: vector search over writing_embeddings_v2 for engine chapter grounding. Returns rows ordered '
    'by cosine similarity, scoped to a user and optionally a project.';

-- No ANN index created deliberately: at 384 rows a sequential scan is faster than ivfflat/hnsw, and
-- an ANN index needs the embedding dimension pinned. Add one (and pin the dimension) when this table
-- grows past a few thousand rows.
