-- ============================================
-- Migration 016 — Multi-user newsletter ingestion: feed sources + runs
--
-- Tier: DEV first (gvbvwcnmjkdpclcisqrr). PROD waits for release-time
-- promotion via scripts/promote-dev-to-prod.py. Do NOT apply to PROD
-- during this sprint.
--
-- Governance: additive only. Adds two new tables, four RLS policies,
-- four indexes, three triggers. No base-table mutations. Schema
-- governance check still passes (15 -> 17 migrations, 9 base tables
-- protected — this delta would be reported as +2 non-base tables).
--
-- Why this exists:
--   The legacy `AI News Data Ingestion V2` n8n workflow has 17 hardcoded
--   feed URLs (one trigger node per source) all writing to a single
--   superuser's account. To support multiple users with their own
--   newsletters and feed lists, the URLs need to live in the database
--   and a single cron-driven n8n workflow needs to fan out per-user.
--
--   This migration adds:
--   1. newsletter_feed_sources_v2 — per-user/per-edition feed URL list.
--   2. newsletter_ingestion_runs_v2 — append-only run log; one row per
--      successful or failed cron tick of a feed.
--
-- See also: writers-workbench/docs/newsletter-ingestion-feeds-baseline.md
-- (the inventory of the 17 hardcoded URLs we're replacing).
-- ============================================

-- ============================================
-- 1. newsletter_feed_sources_v2
--    One row per feed URL a user wants polled. user_id is NOT NULL —
--    every feed belongs to someone. edition_id is a soft FK to
--    newsletter_editions_v2.id (text slug). When the cron worker fans
--    out, the user_id from this row becomes the user_id on the
--    resulting content_ingestion_v2 rows so /api/ingestion/search
--    keeps returning per-user results.
-- ============================================
CREATE TABLE IF NOT EXISTS newsletter_feed_sources_v2 (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 text NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  edition_id              text NOT NULL,
  name                    text NOT NULL,
  url                     text NOT NULL,
  url_type                text NOT NULL CHECK (url_type IN ('rss','reddit','source','firecrawl_scrape')),
  active                  boolean NOT NULL DEFAULT true,
  fetch_interval_minutes  int NOT NULL DEFAULT 240 CHECK (fetch_interval_minutes BETWEEN 5 AND 1440),
  last_fetched_at         timestamptz,
  last_item_count         int,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- "Which feeds are due?" — cron worker's primary lookup. NULLS FIRST so a
-- newly-added feed (never fetched) jumps to the head of the queue.
CREATE INDEX IF NOT EXISTS idx_feed_sources_due
  ON newsletter_feed_sources_v2 (last_fetched_at NULLS FIRST)
  WHERE active = true;

-- "My feeds for this edition" — UI listing.
CREATE INDEX IF NOT EXISTS idx_feed_sources_owner
  ON newsletter_feed_sources_v2 (user_id, edition_id);

-- One user/edition can't have the same URL twice (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_sources_dup
  ON newsletter_feed_sources_v2 (user_id, edition_id, lower(url));

-- updated_at upkeep (re-uses the function from migration 009).
DROP TRIGGER IF EXISTS trg_newsletter_feed_sources_v2_touch ON newsletter_feed_sources_v2;
CREATE TRIGGER trg_newsletter_feed_sources_v2_touch
  BEFORE UPDATE ON newsletter_feed_sources_v2
  FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();

ALTER TABLE newsletter_feed_sources_v2 ENABLE ROW LEVEL SECURITY;

-- SELECT: own rows or admin/superuser. Service-role bypasses RLS so the
-- /feeds/due cron route (service-role + ingestion-secret guarded) can
-- still see all rows.
DROP POLICY IF EXISTS feed_sources_select ON newsletter_feed_sources_v2;
CREATE POLICY feed_sources_select ON newsletter_feed_sources_v2
  FOR SELECT
  USING (user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS feed_sources_insert ON newsletter_feed_sources_v2;
CREATE POLICY feed_sources_insert ON newsletter_feed_sources_v2
  FOR INSERT
  WITH CHECK (user_id = get_current_user_id());

DROP POLICY IF EXISTS feed_sources_update ON newsletter_feed_sources_v2;
CREATE POLICY feed_sources_update ON newsletter_feed_sources_v2
  FOR UPDATE
  USING (user_id = get_current_user_id() OR is_admin_v2())
  WITH CHECK (user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS feed_sources_delete ON newsletter_feed_sources_v2;
CREATE POLICY feed_sources_delete ON newsletter_feed_sources_v2
  FOR DELETE
  USING (user_id = get_current_user_id() OR is_admin_v2());


-- ============================================
-- 2. newsletter_ingestion_runs_v2
--    One row per cron-driven fan-out per feed. Append-only; never
--    updated. Powers the per-feed "run history" drawer in the UI and
--    gives Ops a queryable log when feeds go quiet or start erroring.
-- ============================================
CREATE TABLE IF NOT EXISTS newsletter_ingestion_runs_v2 (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_source_id           uuid NOT NULL REFERENCES newsletter_feed_sources_v2(id) ON DELETE CASCADE,
  user_id                  text NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  edition_id               text NOT NULL,
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  items_fetched            int,
  items_uploaded           int,
  items_skipped_existing   int,
  error_message            text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- "Show me the last N runs for this feed" — UI drawer query.
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_feed_started
  ON newsletter_ingestion_runs_v2 (feed_source_id, started_at DESC);

-- "Show me errors across my feeds today" — health dashboard.
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_user_errors
  ON newsletter_ingestion_runs_v2 (user_id, started_at DESC)
  WHERE error_message IS NOT NULL;

ALTER TABLE newsletter_ingestion_runs_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ingestion_runs_select ON newsletter_ingestion_runs_v2;
CREATE POLICY ingestion_runs_select ON newsletter_ingestion_runs_v2
  FOR SELECT
  USING (user_id = get_current_user_id() OR is_admin_v2());

-- Inserts are service-role-only via the cron callback route. RLS denies
-- direct inserts from authenticated roles by omitting an INSERT policy.
