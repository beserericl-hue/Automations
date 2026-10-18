-- ============================================
-- Migration 030 — user_login_tokens_v2 (passwordless email login)
--
-- Tier: DEV first (gvbvwcnmjkdpclcisqrr). PROD waits for the cutover.
--
-- Governance: additive. ONE new feature table. No base-table mutation — the
-- nine protected base tables are untouched, so
-- scripts/check-base-table-immutability.py still passes.
--
-- Why this exists
-- ---------------
-- Passwords are removed from the product. A user identifies with their EMAIL
-- and receives a 6-digit code by email; entering the code is the whole login.
-- `users_v2.user_id` stays the phone number, so the ~13,250 rows keyed by it
-- (ingestion, embeddings, bible, content, research, projects, app_config) and
-- Eve's caller-ID → user lookup are untouched. Email is the login handle.
--
-- This also makes two recorded defects moot rather than fixed:
--   * I9 — Supabase Auth redirect URLs are still factory `localhost:3000`, so
--     password reset was broken on both tiers. There is no password to reset,
--     and a code typed into the app needs no redirect URL at all.
--   * the "forgot password" surface disappears with it.
--
-- Why a table rather than Supabase's own OTP
-- ------------------------------------------
-- Supabase can email a one-time code, but the code only reaches the user if
-- the project's auth email TEMPLATE carries `{{ .Token }}` and the project's
-- SMTP points somewhere real — both of which are dashboard/Management-API
-- settings that are not available from here. Delivery also has to come from
-- Postal, which this product already uses and has verified. So the code lives
-- here, the email goes out through Postal, and the SESSION is still minted by
-- Supabase (admin.generateLink → verifyOtp) so every existing JWT check,
-- including server/src/middleware/auth.ts, keeps working unchanged.
--
-- Shape notes
-- -----------
-- * `code_hash` — the code is stored as a SHA-256 hash, never in clear. A
--   table of live login codes is a table of live credentials; a leaked backup
--   should not be a set of working logins.
-- * `email` is stored lower-cased by the application and is NOT a foreign key:
--   a first-time user has no `users_v2` row yet (the profile is created during
--   onboarding, after the first successful login), so an FK would make signup
--   impossible.
-- * `attempts` is on the row, not in Redis, because the lockout must survive a
--   Redis restart — the 2026-05 outage ran for nine days.
-- * `consumed_at` makes a code strictly single-use: verification sets it in the
--   same statement that checks it, so two parallel submissions cannot both win.

CREATE TABLE IF NOT EXISTS user_login_tokens_v2 (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL,
  code_hash     TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  request_ip    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The verify path's only query: newest live code for this email.
CREATE INDEX IF NOT EXISTS idx_login_tokens_email_created
  ON user_login_tokens_v2 (email, created_at DESC);

-- The request path's rate-limit query: how many codes has this email been sent
-- recently, and from this IP.
CREATE INDEX IF NOT EXISTS idx_login_tokens_created
  ON user_login_tokens_v2 (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_tokens_ip_created
  ON user_login_tokens_v2 (request_ip, created_at DESC)
  WHERE request_ip IS NOT NULL;

COMMENT ON TABLE user_login_tokens_v2 IS
  'Passwordless login codes. SHA-256 hashed, single-use, short-lived. Delivered by Postal; the session itself is still minted by Supabase Auth.';

-- Service-role only. The anon key must never be able to read this table: a
-- client that can SELECT here can read another account''s login code hash and
-- its expiry, which is the whole secret. No policies are created, and RLS being
-- enabled with zero policies denies everything to anon/authenticated while the
-- service-role key continues to bypass RLS.
ALTER TABLE user_login_tokens_v2 ENABLE ROW LEVEL SECURITY;

-- Housekeeping: consumed and expired rows are rubbish after an hour. Called by
-- the login route itself (cheap, indexed) rather than a cron, so it cannot rot
-- if a scheduler stops.
CREATE OR REPLACE FUNCTION prune_login_tokens(older_than INTERVAL DEFAULT INTERVAL '1 hour')
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM user_login_tokens_v2
   WHERE created_at < NOW() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
