-- ============================================
-- Migration 017 — Newsletter Flow Fixes Sprint
--   1. Per-edition logo / stamp_url
--   2. Per-edition signoff overrides (signature_name, signature_role)
--   3. Per-edition recurring cadence (weekly/daily/none + send time)
--   4. newsletter_subscribers_v2 (recipient list per edition)
--   5. newsletter-logos storage bucket (public-read, owner-write)
--
-- Tier: DEV first (gvbvwcnmjkdpclcisqrr). PROD waits for release-time
-- promotion via scripts/promote-dev-to-prod.py.
--
-- Governance: additive only. Adds five columns to newsletter_editions_v2
-- (a 012 table, not a base table — base-table immutability check still
-- passes), one new table, four RLS policies, two indexes, one storage
-- bucket, three storage policies. No base-table mutations.
--
-- Why this exists: the seeded template references a stamp logo via a
-- hardcoded `/static/logos/courseworx-stamp-black.png` fallback that
-- doesn't exist on disk; sender name + role were baked into the seeded
-- template; recipients lived in a single app_config row. Real users with
-- their own newsletters need each of those at the edition level, with
-- a UI to set them.
-- ============================================

-- ============================================
-- 1. newsletter_editions_v2 — five new columns
--    (every column NULLable so existing rows stay valid; the runtime
--    falls through to template defaults when null)
-- ============================================
ALTER TABLE newsletter_editions_v2
  ADD COLUMN IF NOT EXISTS stamp_url       text,
  ADD COLUMN IF NOT EXISTS signature_name  text,
  ADD COLUMN IF NOT EXISTS signature_role  text,
  ADD COLUMN IF NOT EXISTS cadence         text CHECK (cadence IN ('none','daily','weekly','biweekly','monthly')) DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS cadence_send_time text;  -- 'HH:MM' UTC or 'HH:MM dow' for weekly (e.g. '09:00 fri')

-- ============================================
-- 2. newsletter_subscribers_v2 — recipient list per edition
--    user_id = the edition owner (the sender). Each row is one
--    recipient email + display name + status. RLS scoped to owner.
-- ============================================
CREATE TABLE IF NOT EXISTS newsletter_subscribers_v2 (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  edition_id    text NOT NULL,
  email         text NOT NULL,
  display_name  text,
  status        text NOT NULL CHECK (status IN ('active','unsubscribed','bounced')) DEFAULT 'active',
  source        text,                                  -- 'manual', 'import', 'self-signup', etc.
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One email can only appear once per edition for a given user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscribers_email_per_edition
  ON newsletter_subscribers_v2 (user_id, edition_id, lower(email));

-- "How many subscribers does this edition have?" — UI tile query.
CREATE INDEX IF NOT EXISTS idx_subscribers_owner_edition
  ON newsletter_subscribers_v2 (user_id, edition_id, status);

DROP TRIGGER IF EXISTS trg_newsletter_subscribers_v2_touch ON newsletter_subscribers_v2;
CREATE TRIGGER trg_newsletter_subscribers_v2_touch
  BEFORE UPDATE ON newsletter_subscribers_v2
  FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();

ALTER TABLE newsletter_subscribers_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscribers_select ON newsletter_subscribers_v2;
CREATE POLICY subscribers_select ON newsletter_subscribers_v2
  FOR SELECT USING (user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS subscribers_insert ON newsletter_subscribers_v2;
CREATE POLICY subscribers_insert ON newsletter_subscribers_v2
  FOR INSERT WITH CHECK (user_id = get_current_user_id());

DROP POLICY IF EXISTS subscribers_update ON newsletter_subscribers_v2;
CREATE POLICY subscribers_update ON newsletter_subscribers_v2
  FOR UPDATE USING (user_id = get_current_user_id() OR is_admin_v2())
  WITH CHECK (user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS subscribers_delete ON newsletter_subscribers_v2;
CREATE POLICY subscribers_delete ON newsletter_subscribers_v2
  FOR DELETE USING (user_id = get_current_user_id() OR is_admin_v2());


-- ============================================
-- 3. Storage bucket: newsletter-logos (public-read, owner-write).
--    Same shape as the cover-images / social-images buckets created
--    in migration 005. Stamp logos are inherently public — they get
--    embedded as <img> in outbound email and load from any inbox in
--    the world without auth.
-- ============================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('newsletter-logos', 'newsletter-logos', true)
ON CONFLICT (id) DO NOTHING;

-- Public read so email clients render the <img>.
DROP POLICY IF EXISTS "Public read for newsletter logos" ON storage.objects;
CREATE POLICY "Public read for newsletter logos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'newsletter-logos');

-- Authenticated upload (the route enforces per-user pathing in the
-- application layer; bucket-level just blocks anonymous uploads).
DROP POLICY IF EXISTS "Authenticated upload to newsletter logos" ON storage.objects;
CREATE POLICY "Authenticated upload to newsletter logos"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'newsletter-logos' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated delete from newsletter logos" ON storage.objects;
CREATE POLICY "Authenticated delete from newsletter logos"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'newsletter-logos' AND auth.role() = 'authenticated');
