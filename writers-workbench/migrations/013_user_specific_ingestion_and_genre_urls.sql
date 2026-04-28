-- ============================================
-- Migration 013 — Side sprint: per-user ingestion URLs + admin/superuser
-- ingestion read access on top of Sprint 8's RBAC.
--
-- Tier: DEV first (gvbvwcnmjkdpclcisqrr). PROD waits for release-time
-- promotion via scripts/promote-dev-to-prod.py. Do NOT apply to PROD
-- during this sprint.
--
-- Governance: additive only.
--   - Adds one new table (genre_ingestion_urls_v2)
--   - Replaces ONE policy on content_ingestion_v2 (a 009 table, not a base
--     table — base-table immutability check still passes)
--   - No base-table mutations
--
-- Background:
--   genre_config_v2 already enforces public-vs-private genre rows via
--   user_id IS NULL (admin/public) vs user_id = caller (private). Per-genre
--   URL lists, however, live as text[] columns ON the genre row, which
--   means a user cannot add a URL to a public genre without becoming the
--   owner of the whole genre. This migration adds the per-URL row pattern
--   so users can augment public genres with their own URLs.
--
--   content_ingestion_v2 carried RLS that hid rows from admins and super-
--   users (own-row only). Sprint 8 added is_admin_v2() and is_superuser_v2();
--   we lean on the former here so admin/superuser can see all ingestion
--   rows. Writes stay user-only.
--
-- See also: writers-workbench/docs/schema-governance.md (meta-table pattern).
-- ============================================

-- ============================================
-- 1. genre_ingestion_urls_v2
--    Per-user, per-URL ingestion source rows. Lives alongside the existing
--    text[] columns on genre_config_v2 — those remain canonical for the
--    seeded public URLs that admins curated. New user-added URLs go here.
-- ============================================
CREATE TABLE IF NOT EXISTS genre_ingestion_urls_v2 (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  genre_slug          TEXT NOT NULL,
  url                 TEXT NOT NULL,
  url_type            TEXT NOT NULL CHECK (url_type IN ('rss','source','subreddit','goodreads')),
  visibility          TEXT NOT NULL CHECK (visibility IN ('public','private')) DEFAULT 'private',
  created_by_user_id  TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  label               TEXT,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One user cannot add the same URL+type to the same genre twice. Two
-- different users can add the same URL to the same genre (each gets their
-- own private row). Admin can also add a public row with the same URL —
-- visibility is part of the key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_genre_urls_unique
  ON genre_ingestion_urls_v2 (genre_slug, url_type, lower(url), visibility, created_by_user_id);

-- Read pattern: "give me URLs for genre X of type Y that I'm allowed to see".
CREATE INDEX IF NOT EXISTS idx_genre_urls_lookup
  ON genre_ingestion_urls_v2 (genre_slug, url_type, visibility) WHERE active = true;

-- "Show me the URLs I added across all genres" + future indexed-by-user
-- requirement.
CREATE INDEX IF NOT EXISTS idx_genre_urls_owner
  ON genre_ingestion_urls_v2 (created_by_user_id, genre_slug);

-- updated_at upkeep (re-uses the function newsletter_touch_updated_at()
-- created in migration 009 — same shape, single source of truth).
DROP TRIGGER IF EXISTS trg_genre_ingestion_urls_v2_touch ON genre_ingestion_urls_v2;
CREATE TRIGGER trg_genre_ingestion_urls_v2_touch
  BEFORE UPDATE ON genre_ingestion_urls_v2
  FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();

ALTER TABLE genre_ingestion_urls_v2 ENABLE ROW LEVEL SECURITY;

-- SELECT: public rows are visible to everyone authenticated; private rows
-- only to their owner; admins and superusers see everything (matches the
-- ingestion-row policy below for consistency).
DROP POLICY IF EXISTS genre_urls_select ON genre_ingestion_urls_v2;
CREATE POLICY genre_urls_select ON genre_ingestion_urls_v2
  FOR SELECT
  USING (
    visibility = 'public'
    OR created_by_user_id = get_current_user_id()
    OR is_admin_v2()
  );

-- INSERT: caller may only insert rows they own. Public rows require admin
-- (or superuser via admin's hierarchy). The CHECK runs against the row
-- being inserted.
DROP POLICY IF EXISTS genre_urls_insert ON genre_ingestion_urls_v2;
CREATE POLICY genre_urls_insert ON genre_ingestion_urls_v2
  FOR INSERT
  WITH CHECK (
    created_by_user_id = get_current_user_id()
    AND (visibility = 'private' OR is_admin_v2())
  );

-- UPDATE / DELETE: owner OR admin. Two policies because Postgres applies
-- ALL of FOR-ALL to SELECT too, which would re-narrow reads.
DROP POLICY IF EXISTS genre_urls_update ON genre_ingestion_urls_v2;
CREATE POLICY genre_urls_update ON genre_ingestion_urls_v2
  FOR UPDATE
  USING (created_by_user_id = get_current_user_id() OR is_admin_v2())
  WITH CHECK (created_by_user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS genre_urls_delete ON genre_ingestion_urls_v2;
CREATE POLICY genre_urls_delete ON genre_ingestion_urls_v2
  FOR DELETE
  USING (created_by_user_id = get_current_user_id() OR is_admin_v2());

-- Service role bypasses RLS by default; no explicit policy needed.

-- ============================================
-- 2. content_ingestion_v2 — extend SELECT for admin/superuser visibility
--
-- Previously: own rows only (excluding deleted). That meant a superuser
-- could not survey ingestion runs across users without dropping to service
-- role. The user model the side sprint codifies is: ingestion data is
-- private to its owner BUT admins and superusers may read across users for
-- support / oversight. Writes stay user-only — admins do not write into
-- another user's ingestion stream; if needed, they impersonate (Sprint 8).
-- ============================================
DROP POLICY IF EXISTS "Own ingestion rows readable" ON content_ingestion_v2;
CREATE POLICY "Own or admin ingestion rows readable" ON content_ingestion_v2
  FOR SELECT
  USING (
    (user_id = get_current_user_id() OR is_admin_v2())
    AND deleted_at IS NULL
  );

-- "Own ingestion rows writable" stays as-is (FOR ALL; user_id = caller).
-- Admins/superusers must impersonate to write into another user's stream.

-- ============================================
-- 3. (Future-proofing) confirm user-scoped indexes already exist on the
--    other newsletter / ingestion / editions tables. This is a no-op set
--    of CREATE INDEX IF NOT EXISTS guards so a future fresh-clone keeps
--    the same query characteristics. Actual creation is idempotent.
-- ============================================
CREATE INDEX IF NOT EXISTS idx_content_ingestion_v2_user_id
  ON content_ingestion_v2 (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_newsletter_editions_v2_user_id
  ON newsletter_editions_v2 (user_id) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_newsletter_sends_v2_user_date
  ON newsletter_sends_v2 (user_id, send_date DESC);
CREATE INDEX IF NOT EXISTS idx_newsletter_approvals_v2_user_id
  ON newsletter_approvals_v2 (user_id);
