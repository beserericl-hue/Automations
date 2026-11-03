-- 046 — Backfill the owner of newsletter + ingestion cost rows (token_usage_v2.user_id).
--
-- WHY. Until the engine fix that ships with this migration, the newsletter saga called its steps
-- without saying whose edition it was, and an ingestion tick (which walks feeds of many users) had
-- no owner at all. The step template takes the owner from the payload, so every pick / subject /
-- segment / humanize / assemble row and every `ingestion.run` row was written with user_id NULL.
-- New rows now carry the owner (and edition_id / send_date / feed_source_id in metadata). This
-- fixes the rows already written, ONLY where the owner can be derived without guessing.
--
-- RULES. A row is touched only if user_id IS NULL and source = 'engine'.
--   A. Newsletter steps: run_id is the saga's execution id (the template's default run id).
--      Owner = the single distinct user_id over newsletter_approvals_v2 + newsletter_sends_v2 rows
--      with that execution_id. Zero or several owners -> left NULL.
--   B. Ingestion (`ingestion.run`, `ingestion.feed`): feeds are ingested one at a time and each one
--      logs a newsletter_ingestion_runs_v2 row (feed, owner, edition, started_at..finished_at).
--      B1. created_at inside exactly ONE feed run's [started_at, finished_at] -> that run's owner,
--          plus edition_id + feed_source_id in metadata.
--      B2. otherwise (cost rows are written asynchronously and can land a moment after finished_at)
--          widen the window by 5 seconds; if every feed run in it belongs to ONE user -> that user
--          (no edition/feed: which feed is not certain). Several owners -> left NULL.
--   Rows that match none of these (e.g. `unattributed.*` calls made outside any context) stay NULL.
--
-- Every row this sets gets metadata.owner_backfill = '046:<rule>' so it can be told apart from a
-- row written with its owner, and reverted (SET user_id = NULL WHERE metadata ? 'owner_backfill').
--
-- Governance (docs/schema-governance.md): data UPDATE only; no table is altered. Idempotent: every
-- statement only touches rows whose user_id is still NULL.

BEGIN;

-- A. newsletter saga steps ------------------------------------------------------------------------
WITH owners AS (
    SELECT execution_id, min(user_id) AS user_id, min(edition_id) AS edition_id,
           count(DISTINCT edition_id) AS editions
      FROM (
            SELECT execution_id, user_id, edition_id FROM newsletter_approvals_v2
             WHERE execution_id IS NOT NULL AND user_id IS NOT NULL
            UNION ALL
            SELECT execution_id, user_id, edition_id FROM newsletter_sends_v2
             WHERE execution_id IS NOT NULL AND user_id IS NOT NULL
           ) s
     GROUP BY execution_id
    HAVING count(DISTINCT user_id) = 1
)
UPDATE token_usage_v2 t
   SET user_id  = o.user_id,
       metadata = COALESCE(t.metadata, '{}'::jsonb)
                  || jsonb_build_object('owner_backfill', '046:newsletter_execution')
                  || CASE WHEN o.editions = 1 AND o.edition_id IS NOT NULL
                          THEN jsonb_build_object('edition_id', o.edition_id, 'pipeline', 'newsletter')
                          ELSE jsonb_build_object('pipeline', 'newsletter') END
  FROM owners o
 WHERE t.user_id IS NULL
   AND t.source = 'engine'
   AND t.run_id = o.execution_id;

-- B1. ingestion row inside exactly one feed run ----------------------------------------------------
WITH matched AS (
    SELECT t.id, min(r.user_id) AS user_id, min(r.edition_id) AS edition_id,
           min(r.feed_source_id::text) AS feed_source_id
      FROM token_usage_v2 t
      JOIN newsletter_ingestion_runs_v2 r
        ON t.created_at BETWEEN r.started_at AND COALESCE(r.finished_at, r.started_at)
     WHERE t.user_id IS NULL
       AND t.source = 'engine'
       AND t.operation IN ('ingestion.run', 'ingestion.feed')
     GROUP BY t.id
    HAVING count(*) = 1
)
UPDATE token_usage_v2 t
   SET user_id  = m.user_id,
       metadata = COALESCE(t.metadata, '{}'::jsonb)
                  || jsonb_build_object('owner_backfill', '046:ingestion_feed_run',
                                        'edition_id', m.edition_id,
                                        'feed_source_id', m.feed_source_id)
  FROM matched m
 WHERE t.id = m.id;

-- B2. ingestion row within 5s of feed runs that all belong to one user -----------------------------
WITH matched AS (
    SELECT t.id, min(r.user_id) AS user_id
      FROM token_usage_v2 t
      JOIN newsletter_ingestion_runs_v2 r
        ON t.created_at BETWEEN r.started_at
                            AND COALESCE(r.finished_at, r.started_at) + interval '5 seconds'
     WHERE t.user_id IS NULL
       AND t.source = 'engine'
       AND t.operation IN ('ingestion.run', 'ingestion.feed')
     GROUP BY t.id
    HAVING count(DISTINCT r.user_id) = 1
)
UPDATE token_usage_v2 t
   SET user_id  = m.user_id,
       metadata = COALESCE(t.metadata, '{}'::jsonb)
                  || jsonb_build_object('owner_backfill', '046:ingestion_window_single_owner')
  FROM matched m
 WHERE t.id = m.id;

COMMIT;
