-- 044 — Exact cost recording: one labelled row per paid provider call, and server-side aggregation.
--
-- WHY. The owner asked for "the exact cost of every operation". token_usage_v2 recorded only the
-- engine's LLM calls, with the operation in workflow_name and everything else (project, provider,
-- cache tokens) buried in metadata; Perplexity search fees, KIE images, StealthGPT words, OpenAI
-- embeddings, ScraperAPI credits and every server-side (Node) Claude call were not recorded at all,
-- and CostDashboard summed a 2000-row capped select in the browser, so totals silently stopped
-- growing past the cap.
--
-- WHAT.
--   1. Columns on token_usage_v2 (NOT a base table — docs/schema-governance.md; it came in 002/006):
--        operation              '<step>.<op>' (engine) or the server route name; the label every
--                               cost view groups by. workflow_name stays for back-compat.
--        provider               anthropic | gemini | perplexity | openai | kieai | stealthgpt | scraperapi
--        project_id, content_id, chapter_number, run_id, request_id
--        cache_read_tokens, cache_write_tokens (5-minute), cache_write_1h_tokens
--        units, unit_type       non-token units: words, credits, images, requests
--        unit_prices            the exact prices used for this row (JSON), so a later price change
--                               never makes an old row unexplainable
--        cost_source            provider_reported | computed | estimated | unpriced
--        source                 engine | server
--      user_id loses NOT NULL (where it had it): a system job with no user still costs money, and
--      dropping its row is how recorded cost diverges from the invoice.
--   2. A partial UNIQUE index on (provider, request_id) so a provider task recorded twice (KIE status
--      polled twice after success, a retried write) cannot double-count.
--   3. Backfill of the new columns from workflow_name / metadata, and a re-price of the rows written
--      with the wrong Haiku 4.5 ($0.80/$4 instead of $1/$5) and Opus 4.8 ($15/$75 instead of $5/$25)
--      rates. Marked in metadata.repriced_from.
--   4. token_usage_breakdown(...) — server-side GROUP BY for the cost views (never sum a capped
--      select). Service role only.
--   5. The "Own data only" policy (USING true / WITH CHECK true) let any signed-in user read and
--      write every user's usage rows. Dropped: the engine and the server write with the service role
--      (which bypasses RLS), and reads keep "Users see own token usage" + "Admins see all".
--
-- Idempotent: safe to re-run. Applied to DEV only until release.

-- ---------------------------------------------------------------- 1. columns
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS operation TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS content_id TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS chapter_number INTEGER;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS units NUMERIC(14, 4);
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS unit_type TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS unit_prices JSONB;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS cost_source TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE token_usage_v2 ALTER COLUMN user_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_usage_v2_cost_source_check') THEN
    ALTER TABLE token_usage_v2 ADD CONSTRAINT token_usage_v2_cost_source_check
      CHECK (cost_source IS NULL OR cost_source IN ('provider_reported', 'computed', 'estimated', 'unpriced'));
  END IF;
END $$;

-- ---------------------------------------------------------------- 2. indexes
CREATE INDEX IF NOT EXISTS idx_token_usage_v2_operation_date ON token_usage_v2 (operation, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_v2_project_date ON token_usage_v2 (project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_usage_v2_run ON token_usage_v2 (run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_token_usage_v2_provider_request
  ON token_usage_v2 (provider, request_id) WHERE request_id IS NOT NULL;

-- ---------------------------------------------------------------- 3. backfill + re-price
UPDATE token_usage_v2
   SET operation = COALESCE(operation, workflow_name),
       provider = COALESCE(provider, metadata->>'provider'),
       project_id = COALESCE(project_id, NULLIF(metadata->>'project_id', '')),
       chapter_number = COALESCE(chapter_number,
         CASE WHEN (metadata->>'chapter_number') ~ '^[0-9]+$' THEN (metadata->>'chapter_number')::int END),
       cache_read_tokens = CASE WHEN cache_read_tokens = 0
         THEN COALESCE(NULLIF(metadata->>'cache_read_tokens', '')::int, 0) ELSE cache_read_tokens END,
       cache_write_tokens = CASE WHEN cache_write_tokens = 0
         THEN COALESCE(NULLIF(metadata->>'cache_write_tokens', '')::int, 0) ELSE cache_write_tokens END,
       source = COALESCE(source, CASE WHEN metadata ? 'provider' THEN 'engine' END),
       cost_source = COALESCE(cost_source, 'computed')
 WHERE operation IS NULL OR cost_source IS NULL;

-- Haiku 4.5: $1 in / $5 out / $0.10 cache read / $1.25 5m cache write (was $0.80 / $4 / $0.08 / $1).
UPDATE token_usage_v2
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('repriced_from', cost_usd),
       cost_usd = round((input_tokens * 1.00 + output_tokens * 5.00
                         + cache_read_tokens * 0.10 + cache_write_tokens * 1.25) / 1000000.0, 6)
 WHERE model IN ('claude-haiku-4-5-20251001', 'claude-haiku-4-5')
   AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'repriced_from')
   AND COALESCE(source, 'engine') = 'engine'
   AND unit_prices IS NULL;

-- Opus 4.8: $5 in / $25 out / $0.50 cache read / $6.25 5m cache write (was $15 / $75 / $1.50 / $18.75).
UPDATE token_usage_v2
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('repriced_from', cost_usd),
       cost_usd = round((input_tokens * 5.00 + output_tokens * 25.00
                         + cache_read_tokens * 0.50 + cache_write_tokens * 6.25) / 1000000.0, 6)
 WHERE model = 'claude-opus-4-8'
   AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'repriced_from')
   AND COALESCE(source, 'engine') = 'engine'
   AND unit_prices IS NULL;

-- ---------------------------------------------------------------- 4. aggregation
-- p_group: operation | provider | model | project | day | operation_model | user | total.
-- Every dimension column is returned; the ones not grouped on are NULL. Filters are optional.
CREATE OR REPLACE FUNCTION token_usage_breakdown(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_group TEXT DEFAULT 'operation',
  p_user_id TEXT DEFAULT NULL,
  p_project_id TEXT DEFAULT NULL,
  p_operation TEXT DEFAULT NULL,
  p_provider TEXT DEFAULT NULL,
  p_model TEXT DEFAULT NULL
)
RETURNS TABLE (
  operation TEXT,
  provider TEXT,
  model TEXT,
  project_id TEXT,
  user_id TEXT,
  day DATE,
  calls BIGINT,
  runs BIGINT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  units NUMERIC,
  unit_types TEXT,
  cost_usd NUMERIC,
  avg_cost_per_call NUMERIC,
  avg_cost_per_run NUMERIC,
  provider_reported_calls BIGINT,
  estimated_calls BIGINT,
  unpriced_calls BIGINT
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH f AS (
    SELECT t.*,
           COALESCE(t.operation, t.workflow_name, 'unknown') AS op,
           COALESCE(t.provider, t.metadata->>'provider', 'unknown') AS prov,
           COALESCE(t.model, 'unknown') AS mdl,
           COALESCE(t.project_id, NULLIF(t.metadata->>'project_id', '')) AS proj
      FROM token_usage_v2 t
     WHERE t.created_at >= p_from
       AND t.created_at < p_to
       AND (p_user_id IS NULL OR t.user_id = p_user_id)
       AND (p_project_id IS NULL OR COALESCE(t.project_id, t.metadata->>'project_id') = p_project_id)
       AND (p_operation IS NULL OR COALESCE(t.operation, t.workflow_name) = p_operation)
       AND (p_provider IS NULL OR COALESCE(t.provider, t.metadata->>'provider') = p_provider)
       AND (p_model IS NULL OR t.model = p_model)
  ), g AS (
    SELECT CASE WHEN p_group IN ('operation', 'operation_model') THEN f.op END AS g_operation,
           CASE WHEN p_group IN ('provider', 'model', 'operation_model') THEN f.prov END AS g_provider,
           CASE WHEN p_group IN ('model', 'operation_model') THEN f.mdl END AS g_model,
           CASE WHEN p_group = 'project' THEN f.proj END AS g_project,
           CASE WHEN p_group = 'user' THEN f.user_id END AS g_user,
           CASE WHEN p_group = 'day' THEN (f.created_at AT TIME ZONE 'UTC')::date END AS g_day,
           f.*
      FROM f
  )
  SELECT g.g_operation, g.g_provider, g.g_model, g.g_project, g.g_user, g.g_day,
         COUNT(*)::bigint,
         COUNT(DISTINCT g.run_id)::bigint,
         COALESCE(SUM(g.input_tokens), 0)::bigint,
         COALESCE(SUM(g.output_tokens), 0)::bigint,
         COALESCE(SUM(g.cache_read_tokens), 0)::bigint,
         COALESCE(SUM(g.cache_write_tokens + g.cache_write_1h_tokens), 0)::bigint,
         COALESCE(SUM(g.units), 0)::numeric,
         string_agg(DISTINCT g.unit_type, ',') ,
         COALESCE(SUM(g.cost_usd), 0)::numeric,
         round(COALESCE(SUM(g.cost_usd), 0) / NULLIF(COUNT(*), 0), 6),
         round(COALESCE(SUM(g.cost_usd) FILTER (WHERE g.run_id IS NOT NULL), 0)
               / NULLIF(COUNT(DISTINCT g.run_id), 0), 6),
         COUNT(*) FILTER (WHERE g.cost_source = 'provider_reported')::bigint,
         COUNT(*) FILTER (WHERE g.cost_source = 'estimated')::bigint,
         COUNT(*) FILTER (WHERE g.cost_source = 'unpriced')::bigint
    FROM g
   GROUP BY g.g_operation, g.g_provider, g.g_model, g.g_project, g.g_user, g.g_day
   ORDER BY 15 DESC;
$$;

REVOKE ALL ON FUNCTION token_usage_breakdown(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION token_usage_breakdown(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION token_usage_breakdown(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role';
  END IF;
END $$;

-- ---------------------------------------------------------------- 5. RLS
DROP POLICY IF EXISTS "Own data only" ON token_usage_v2;
