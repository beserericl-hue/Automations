-- ============================================
-- Migration 009 — Sprint: Newsletter Agent Migration — Story S2
-- Schema + storage provisioning for the newsletter pipeline.
--
-- Tier: DEV first (gvbvwcnmjkdpclcisqrr). PROD
-- (faklxfakgzkpkbxfihzh) gets this at release-time promotion via
-- scripts/promote-dev-to-prod.py or the normal release branch flow.
-- Do NOT apply to PROD during the sprint.
--
-- Governance: additive only. No base-table ALTER/DROP/RENAME.
-- FK references to users_v2(user_id) are additive and allowed
-- under schema-governance.md.
-- ============================================

-- ============================================
-- 1. content_ingestion_v2
--    One row per scraped/ingested source item (article, reddit_post,
--    tweet, newsletter snapshot). Body blobs live in Supabase Storage
--    at storage_path_md / storage_path_html; this table is metadata.
-- ============================================
CREATE TABLE IF NOT EXISTS content_ingestion_v2 (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   TEXT UNIQUE NOT NULL,       -- '{YYYY-MM-DD}/{slug}.{source}.{md|html}' prefix (no extension)
  user_id               TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  type                  TEXT NOT NULL,              -- 'article' | 'reddit_post' | 'tweet' | 'newsletter'
  title                 TEXT,
  authors               TEXT,
  source_name           TEXT NOT NULL,              -- feed / subreddit / publisher identifier
  source_url            TEXT,
  external_source_urls  JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_urls            JSONB NOT NULL DEFAULT '[]'::jsonb,
  reddit_metadata       JSONB,                      -- score / num_comments / author / subreddit / reddit_id / flair
  published_timestamp   TIMESTAMPTZ,
  feed_url              TEXT,
  storage_path_md       TEXT NOT NULL,              -- object key inside newsletter-ingestion bucket
  storage_path_html     TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);

-- Prefix search ('2026-04-21/%') — the newsletter agent drives everything off date prefixes.
CREATE INDEX IF NOT EXISTS idx_content_ingestion_v2_key_prefix
  ON content_ingestion_v2 (key text_pattern_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_content_ingestion_v2_user_id
  ON content_ingestion_v2 (user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_content_ingestion_v2_created_at
  ON content_ingestion_v2 (created_at DESC)
  WHERE deleted_at IS NULL;

-- ============================================
-- 2. newsletter_approvals_v2
--    One row per open approval gate (stories, subject_line). Tokens
--    are public-URL credentials — row lives until resolved_at or
--    expires_at.
-- ============================================
CREATE TABLE IF NOT EXISTS newsletter_approvals_v2 (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token         TEXT UNIQUE NOT NULL,               -- crypto.randomBytes(24).toString('base64url')
  user_id       TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  execution_id  TEXT NOT NULL,                      -- n8n execution id (for debugging)
  resume_url    TEXT NOT NULL,                      -- n8n Wait node resume URL — never leaves the server
  stage         TEXT NOT NULL CHECK (stage IN ('stories', 'subject_line')),
  payload       JSONB NOT NULL,                     -- stories list or subject line draft
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '48 hours'),
  decision      TEXT CHECK (decision IS NULL OR decision IN ('approve', 'revise')),
  feedback      TEXT
);

CREATE INDEX IF NOT EXISTS idx_newsletter_approvals_v2_token
  ON newsletter_approvals_v2 (token);

CREATE INDEX IF NOT EXISTS idx_newsletter_approvals_v2_user_id
  ON newsletter_approvals_v2 (user_id);

-- Open approvals lookup (what's waiting on the reviewer?)
CREATE INDEX IF NOT EXISTS idx_newsletter_approvals_v2_open
  ON newsletter_approvals_v2 (user_id, expires_at)
  WHERE resolved_at IS NULL;

-- ============================================
-- 3. newsletter_sends_v2
--    Finished newsletters parked for the future calendar cron to
--    release. status starts 'scheduled'; this sprint never flips it
--    to 'sent' — that's deferred to the calendar sprint.
-- ============================================
CREATE TABLE IF NOT EXISTS newsletter_sends_v2 (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  send_date             DATE NOT NULL,
  subject               TEXT NOT NULL,
  preheader             TEXT,
  html_body             TEXT NOT NULL,
  markdown_body         TEXT,
  -- scheduling
  scheduled_send_at     TIMESTAMPTZ,                -- set on save (default +24h); calendar cron picks this up
  status                TEXT NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('draft','scheduled','sending','sent','failed','cancelled')),
  sent_at               TIMESTAMPTZ,
  -- delivery tracking (populated by the future calendar sprint)
  recipient_count       INTEGER,
  delivery_provider     TEXT,                       -- 'postal' initially; 'ghl' reserved for a future CRM sprint
  provider_message_id   TEXT,
  error                 TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_sends_v2_user_date
  ON newsletter_sends_v2 (user_id, send_date DESC);

-- Calendar cron lookup: "what's due in the next N hours?"
CREATE INDEX IF NOT EXISTS idx_newsletter_sends_v2_scheduled
  ON newsletter_sends_v2 (status, scheduled_send_at)
  WHERE status = 'scheduled';

-- One active (non-cancelled) newsletter per (user, date). Cancelled rows are allowed to pile up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_sends_v2_user_date_unique
  ON newsletter_sends_v2 (user_id, send_date)
  WHERE status != 'cancelled';

-- ============================================
-- 4. updated_at auto-touch trigger
--    content_ingestion_v2 and newsletter_sends_v2 need updated_at
--    maintained. newsletter_approvals_v2 tracks its state via
--    resolved_at / decision, so no updated_at there.
-- ============================================
CREATE OR REPLACE FUNCTION newsletter_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_ingestion_v2_updated_at ON content_ingestion_v2;
CREATE TRIGGER trg_content_ingestion_v2_updated_at
  BEFORE UPDATE ON content_ingestion_v2
  FOR EACH ROW
  EXECUTE FUNCTION newsletter_touch_updated_at();

DROP TRIGGER IF EXISTS trg_newsletter_sends_v2_updated_at ON newsletter_sends_v2;
CREATE TRIGGER trg_newsletter_sends_v2_updated_at
  BEFORE UPDATE ON newsletter_sends_v2
  FOR EACH ROW
  EXECUTE FUNCTION newsletter_touch_updated_at();

-- ============================================
-- 5. Row-Level Security
--    Pattern mirrors writing_projects_v2: service_role bypasses RLS
--    (n8n + Express server use service_role), authenticated users
--    see only their own rows. The newsletter-ingestion storage
--    bucket is service_role-only in this sprint — Phase 2 web UI
--    will open up read access.
-- ============================================
ALTER TABLE content_ingestion_v2     ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_approvals_v2  ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_sends_v2      ENABLE ROW LEVEL SECURITY;

-- content_ingestion_v2: own rows, soft-deleted hidden from user view
DROP POLICY IF EXISTS "Own ingestion rows readable"   ON content_ingestion_v2;
DROP POLICY IF EXISTS "Own ingestion rows writable"   ON content_ingestion_v2;

CREATE POLICY "Own ingestion rows readable" ON content_ingestion_v2
  FOR SELECT USING (user_id = get_current_user_id() AND deleted_at IS NULL);
CREATE POLICY "Own ingestion rows writable" ON content_ingestion_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- newsletter_approvals_v2: own rows only — the token-based approval URL
-- is served by the Express server, not by the client; client never
-- needs to query this table directly. Policy exists for defence in depth.
DROP POLICY IF EXISTS "Own approvals readable" ON newsletter_approvals_v2;
DROP POLICY IF EXISTS "Own approvals writable" ON newsletter_approvals_v2;

CREATE POLICY "Own approvals readable" ON newsletter_approvals_v2
  FOR SELECT USING (user_id = get_current_user_id());
CREATE POLICY "Own approvals writable" ON newsletter_approvals_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- newsletter_sends_v2: own rows only
DROP POLICY IF EXISTS "Own sends readable" ON newsletter_sends_v2;
DROP POLICY IF EXISTS "Own sends writable" ON newsletter_sends_v2;

CREATE POLICY "Own sends readable" ON newsletter_sends_v2
  FOR SELECT USING (user_id = get_current_user_id());
CREATE POLICY "Own sends writable" ON newsletter_sends_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- ============================================
-- 6. Storage bucket: newsletter-ingestion
--    Private (public=false). 10 MB per object. Only md/html/plain.
--    Service role handles all reads/writes this sprint.
-- ============================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'newsletter-ingestion',
  'newsletter-ingestion',
  false,
  10485760,                                         -- 10 MB
  ARRAY['text/markdown', 'text/html', 'text/plain']
)
ON CONFLICT (id) DO NOTHING;

-- No public SELECT / INSERT policies on storage.objects for this bucket.
-- Service role bypasses RLS, so n8n and the Express server can still
-- read/write. Anonymous + authenticated end users have no access until
-- Phase 2 opens it up.
