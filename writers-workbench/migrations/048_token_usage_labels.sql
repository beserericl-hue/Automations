-- 048 — Every token_usage_v2 row names its provider and operation.
--
-- WHY. 47 DEV rows written 2026-11-02 21:29–21:45Z have provider, operation and source all NULL.
-- They are engine rows (chapter.repair, research.run, media.social-posts) written by the pre-044
-- engine image, whose persist_token_usage put the provider only in metadata and never set the 044
-- columns. Migration 044 had already run (its own backfill covered rows that existed then) while the
-- old image was still serving, so these slipped between the two. The cost view cannot group or
-- price a row it cannot label. The engine and server writers now label every row themselves and log
-- at error when they had to default (persist_helpers.label_token_rows, cost-recorder.buildUsageRow);
-- this migration adds the same guarantee at the database for any other writer (an old image during a
-- deploy, a test fixture, an n8n workflow), and fixes the 47.
--
-- 1. BEFORE INSERT trigger: a row missing provider/operation is still written (billing data must not
--    be dropped) but defaulted — provider from metadata.provider, else 'unknown'; operation from
--    workflow_name, else 'unattributed.<provider>' — tagged metadata.label_defaulted, and a WARNING
--    is raised into the Postgres log. INSERT only: updates (e.g. repricing) are untouched.
-- 2. Backfill, only where the writer is certain: source, provider and operation all NULL, the
--    provider recorded in metadata, workflow_name in the engine's `<step>.<op>` form (n8n names like
--    'Hub V2' never match), written on/after 2026-11-02 (the 044 rollout). Sets operation,
--    provider, source='engine', and project_id / chapter_number from metadata where the column is
--    empty. Tagged metadata.label_backfill = '048:pre044_engine_writer'. Anything else (e.g. the E2E
--    fixture row 'E2E Cost Regression') is left alone.
--
-- Governance (docs/schema-governance.md): token_usage_v2 is not a base table; a trigger + function
-- are added and no column is altered. Idempotent: CREATE OR REPLACE / DROP TRIGGER IF EXISTS, and
-- the backfill only matches rows whose labels are still NULL.

BEGIN;

CREATE OR REPLACE FUNCTION token_usage_v2_default_labels() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    missing text[] := ARRAY[]::text[];
BEGIN
    IF NEW.provider IS NULL OR btrim(NEW.provider) = '' THEN
        missing := missing || 'provider'::text;
        NEW.provider := COALESCE(NULLIF(btrim(NEW.metadata->>'provider'), ''), 'unknown');
    END IF;
    IF NEW.operation IS NULL OR btrim(NEW.operation) = '' THEN
        missing := missing || 'operation'::text;
        NEW.operation := COALESCE(NULLIF(btrim(NEW.workflow_name), ''), 'unattributed.' || NEW.provider);
    END IF;
    IF array_length(missing, 1) > 0 THEN
        NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
                        || jsonb_build_object('label_defaulted', to_jsonb(missing));
        RAISE WARNING 'token_usage_v2: row written without %, defaulted (provider=%, operation=%, model=%, source=%)',
            array_to_string(missing, ','), NEW.provider, NEW.operation, NEW.model, COALESCE(NEW.source, 'NULL');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS token_usage_v2_default_labels ON token_usage_v2;
CREATE TRIGGER token_usage_v2_default_labels
    BEFORE INSERT ON token_usage_v2
    FOR EACH ROW EXECUTE FUNCTION token_usage_v2_default_labels();

UPDATE token_usage_v2
   SET operation      = workflow_name,
       provider       = metadata->>'provider',
       source         = 'engine',
       project_id     = COALESCE(project_id, NULLIF(metadata->>'project_id', '')),
       chapter_number = COALESCE(chapter_number,
                                 CASE WHEN metadata->>'chapter_number' ~ '^[0-9]+$'
                                      THEN (metadata->>'chapter_number')::int END),
       metadata       = metadata || jsonb_build_object('label_backfill', '048:pre044_engine_writer')
 WHERE provider IS NULL
   AND operation IS NULL
   AND source IS NULL
   AND NULLIF(btrim(metadata->>'provider'), '') IS NOT NULL
   AND workflow_name ~ '^[a-z]+(\.[a-z][a-z0-9-]*)+$'
   AND created_at >= '2026-11-02';

COMMIT;
