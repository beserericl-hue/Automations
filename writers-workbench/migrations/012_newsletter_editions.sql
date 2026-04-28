-- ============================================
-- Migration 012 — Sprint: Compose Newsletter Phase 2a — Story S1
-- newsletter_editions_v2 + send/approval edition_id columns + ai-news seed
--
-- Tier: DEV first (gvbvwcnmjkdpclcisqrr). PROD waits for release-time
-- promotion via scripts/promote-dev-to-prod.py. Do NOT apply to PROD
-- during this sprint.
--
-- Governance: additive only. Adds one new table + adds three columns to
-- newsletter_sends_v2 (introduced in migration 009 — same release cycle,
-- not a base table) + adds one column to newsletter_approvals_v2 (also
-- 009). No base-table mutations.
--
-- Sibling migration 011 (token_usage_v2 timing columns) is in flight on
-- a separate S12-5 PR; numbers don't collide because that one stays
-- reserved at 011 and this one explicitly takes 012 per the design doc.
-- ============================================

-- ============================================
-- 1. newsletter_editions_v2
--    One row per branded edition (ai-news, future genres). Row stores
--    masthead + color tokens; future per-genre newsletters ship as
--    INSERTs, no schema change.
-- ============================================
CREATE TABLE IF NOT EXISTS newsletter_editions_v2 (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  subheader       TEXT NOT NULL,
  genre           TEXT NOT NULL,
  description     TEXT,
  newsletter_name TEXT NOT NULL,
  primary_color   TEXT NOT NULL DEFAULT '#14288c',
  paper_color     TEXT NOT NULL DEFAULT '#fbf8f2',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  user_id         TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_editions_v2_user_id
  ON newsletter_editions_v2 (user_id) WHERE enabled = true;

-- updated_at auto-touch trigger reuses the function from migration 009
-- (newsletter_touch_updated_at) so we don't redefine it.
DROP TRIGGER IF EXISTS trg_newsletter_editions_v2_updated_at ON newsletter_editions_v2;
CREATE TRIGGER trg_newsletter_editions_v2_updated_at
  BEFORE UPDATE ON newsletter_editions_v2
  FOR EACH ROW
  EXECUTE FUNCTION newsletter_touch_updated_at();

-- ============================================
-- 2. RLS — own-row SELECT/ALL via get_current_user_id()
--    Service role bypasses (n8n + Express). Pattern matches every other
--    V2 table in migration 009 (content_ingestion_v2 etc.).
-- ============================================
ALTER TABLE newsletter_editions_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own editions readable" ON newsletter_editions_v2;
DROP POLICY IF EXISTS "Own editions writable" ON newsletter_editions_v2;

CREATE POLICY "Own editions readable" ON newsletter_editions_v2
  FOR SELECT USING (user_id = get_current_user_id());
CREATE POLICY "Own editions writable" ON newsletter_editions_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- ============================================
-- 3. New columns on newsletter_sends_v2
--    edition_id    — FK to the new editions table
--    execution_id  — n8n executionId (string from /execution/:id endpoint;
--                    not a UUID, so plain TEXT)
--    issue_number  — assigned at save time; Phase 2a only stores it,
--                    Phase 2b assigns it
-- ============================================
ALTER TABLE newsletter_sends_v2
  ADD COLUMN IF NOT EXISTS edition_id   TEXT REFERENCES newsletter_editions_v2(id),
  ADD COLUMN IF NOT EXISTS execution_id TEXT,
  ADD COLUMN IF NOT EXISTS issue_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_newsletter_sends_v2_edition_issue
  ON newsletter_sends_v2 (edition_id, issue_number);

-- ============================================
-- 4. New column on newsletter_approvals_v2
--    Lets the in-app approvals inbox filter by edition for users with
--    multiple newsletters in flight.
-- ============================================
ALTER TABLE newsletter_approvals_v2
  ADD COLUMN IF NOT EXISTS edition_id TEXT REFERENCES newsletter_editions_v2(id);

-- ============================================
-- 5. Seed the ai-news edition row
--    First branded edition. Subheader / footer locked by the design
--    handoff: 'Dispatches from the Machine Room' / 'A CourseworxAI Weekly'.
--    user_id = +14105914612 (superuser); future per-user editions add
--    rows under their own user_id.
-- ============================================
INSERT INTO newsletter_editions_v2
  (id, display_name, subheader, genre, newsletter_name, user_id)
VALUES
  ('ai-news', 'The Workbench',
   'Dispatches from the Machine Room', 'ai',
   'A CourseworxAI Weekly', '+14105914612')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 6. Backfill existing rows
--    Any send/approval that predates this migration is implicitly
--    ai-news. Backfill must run AFTER the seed INSERT or the FK fails.
-- ============================================
UPDATE newsletter_sends_v2
   SET edition_id = 'ai-news'
   WHERE edition_id IS NULL;

UPDATE newsletter_approvals_v2
   SET edition_id = 'ai-news'
   WHERE edition_id IS NULL;
