-- Sprint 8 (S8-1): RBAC, account lifecycle, subscription tiers, credits, impersonation.
--
-- Governance note (see writers-workbench/docs/schema-governance.md):
-- This migration is numbered 011 and is fully additive. It does NOT ALTER / DROP /
-- RENAME any of the 9 base tables. The role hierarchy (superuser/admin/user) and
-- account-lifecycle fields (account_status, locked_at, locked_by, locked_reason)
-- live in two new meta tables (`user_role_meta_v2`, `user_account_meta_v2`) keyed
-- on users_v2.user_id (FK CASCADE). The legacy users_v2.role column from migration
-- 001 is left untouched and continues to work for any code path still reading it.
--
-- The effective role for a user is:
--   COALESCE(user_role_meta_v2.role, users_v2.role, 'user')
-- with the meta-table value winning when present. New is_admin_v2() / is_superuser_v2()
-- functions read from the meta table; the original is_admin() function from
-- supabase_auth_migration.sql is left in place to preserve existing RLS contracts.

-- =====================================================================
-- 1. Account lifecycle meta table
-- =====================================================================
-- One-to-one with users_v2. Absence of a row implies account_status = 'active'.
CREATE TABLE IF NOT EXISTS user_account_meta_v2 (
    user_id        TEXT PRIMARY KEY REFERENCES users_v2(user_id) ON DELETE CASCADE,
    account_status TEXT NOT NULL DEFAULT 'active'
                     CHECK (account_status IN ('active', 'locked', 'suspended', 'pending')),
    locked_at      TIMESTAMPTZ,
    locked_by      TEXT,                       -- admin/superuser user_id who locked
    locked_reason  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_account_meta_status
    ON user_account_meta_v2 (account_status)
    WHERE account_status <> 'active';

-- =====================================================================
-- 2. Role meta table (elevated roles only)
-- =====================================================================
-- Holds 'superuser' or 'admin' for elevated users. Standard users have no row;
-- the legacy users_v2.role column ('user' default) covers them. Keeping this
-- table sparse means "promote to admin" = INSERT, "demote" = DELETE.
CREATE TABLE IF NOT EXISTS user_role_meta_v2 (
    user_id     TEXT PRIMARY KEY REFERENCES users_v2(user_id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('superuser', 'admin')),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by  TEXT,                          -- superuser user_id who granted (NULL for seed superuser)
    notes       TEXT
);

-- =====================================================================
-- 3. Helper functions (NEW — do not replace existing ones)
-- =====================================================================
-- Effective role lookup. SECURITY DEFINER + STABLE so it is cheap inside RLS.
CREATE OR REPLACE FUNCTION get_user_effective_role_v2(p_user_id TEXT)
RETURNS TEXT AS $$
  SELECT COALESCE(
    (SELECT role FROM user_role_meta_v2 WHERE user_id = p_user_id LIMIT 1),
    (SELECT role FROM users_v2          WHERE user_id = p_user_id LIMIT 1),
    'user'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_superuser_v2()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_role_meta_v2 urm
    JOIN users_v2 u ON u.user_id = urm.user_id
    WHERE u.supabase_auth_uid = auth.uid()
      AND urm.role = 'superuser'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_admin_v2()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_role_meta_v2 urm
    JOIN users_v2 u ON u.user_id = urm.user_id
    WHERE u.supabase_auth_uid = auth.uid()
      AND urm.role IN ('admin', 'superuser')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_account_active_v2()
RETURNS BOOLEAN AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM user_account_meta_v2 m
    JOIN users_v2 u ON u.user_id = m.user_id
    WHERE u.supabase_auth_uid = auth.uid()
      AND m.account_status <> 'active'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- =====================================================================
-- 4. Role-escalation guard for the meta table
-- =====================================================================
-- Only superusers can INSERT/UPDATE/DELETE rows in user_role_meta_v2 from a
-- non-service-role session. Service role (n8n, server admin operations) bypasses
-- RLS and triggers; that's intentional — server middleware does its own checks.
CREATE OR REPLACE FUNCTION prevent_role_meta_escalation()
RETURNS TRIGGER AS $$
DECLARE
  acting_user_id TEXT;
  acting_role    TEXT;
BEGIN
  -- Service role bypasses (auth.uid() is NULL in service-role contexts).
  IF auth.uid() IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT user_id INTO acting_user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1;
  acting_role := get_user_effective_role_v2(acting_user_id);

  IF acting_role <> 'superuser' THEN
    RAISE EXCEPTION 'Only superusers can modify elevated roles';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_role_meta_escalation_ins ON user_role_meta_v2;
CREATE TRIGGER trg_prevent_role_meta_escalation_ins
  BEFORE INSERT ON user_role_meta_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_role_meta_escalation();

DROP TRIGGER IF EXISTS trg_prevent_role_meta_escalation_upd ON user_role_meta_v2;
CREATE TRIGGER trg_prevent_role_meta_escalation_upd
  BEFORE UPDATE ON user_role_meta_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_role_meta_escalation();

DROP TRIGGER IF EXISTS trg_prevent_role_meta_escalation_del ON user_role_meta_v2;
CREATE TRIGGER trg_prevent_role_meta_escalation_del
  BEFORE DELETE ON user_role_meta_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_role_meta_escalation();

-- =====================================================================
-- 5. Subscription tiers (configurable by superuser)
-- =====================================================================
CREATE TABLE IF NOT EXISTS subscription_tiers (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                        TEXT UNIQUE NOT NULL,
    display_name                TEXT NOT NULL,
    description                 TEXT,
    monthly_credits             INTEGER NOT NULL DEFAULT 0,
    monthly_price_cents         INTEGER NOT NULL DEFAULT 0,
    annual_price_cents          INTEGER NOT NULL DEFAULT 0,
    credit_purchase_price_cents INTEGER NOT NULL DEFAULT 100,  -- price per credit when purchasing additional
    features                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_default                  BOOLEAN NOT NULL DEFAULT false, -- new signups get this tier
    publicly_selectable         BOOLEAN NOT NULL DEFAULT true,  -- shown on signup page
    trial_days                  INTEGER NOT NULL DEFAULT 0,
    sort_order                  INTEGER NOT NULL DEFAULT 0,
    active                      BOOLEAN NOT NULL DEFAULT true,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_tiers_active
    ON subscription_tiers (active, sort_order);

-- =====================================================================
-- 6. user_subscriptions (one active subscription per user)
-- =====================================================================
CREATE TABLE IF NOT EXISTS user_subscriptions (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  TEXT NOT NULL UNIQUE REFERENCES users_v2(user_id) ON DELETE CASCADE,
    tier_id                  UUID NOT NULL REFERENCES subscription_tiers(id),
    status                   TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'expired', 'cancelled', 'past_due')),
    billing_cycle            TEXT NOT NULL DEFAULT 'none'
                               CHECK (billing_cycle IN ('monthly', 'annual', 'none')),
    current_period_start     TIMESTAMPTZ NOT NULL DEFAULT now(),
    current_period_end       TIMESTAMPTZ,                  -- NULL = never expires (free_full, none)
    trial_start              TIMESTAMPTZ,
    trial_end                TIMESTAMPTZ,
    credits_remaining        INTEGER NOT NULL DEFAULT 0,
    credits_used_this_period INTEGER NOT NULL DEFAULT 0,
    auto_renew               BOOLEAN NOT NULL DEFAULT true,
    trial_warnings_sent      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['7d','3d','1d']
    created_by               TEXT,                                -- admin/superuser user_id, NULL for self-signup
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_subs_status
    ON user_subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_user_subs_period_end
    ON user_subscriptions (current_period_end)
    WHERE current_period_end IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_subs_trial_end
    ON user_subscriptions (trial_end)
    WHERE trial_end IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_subs_tier
    ON user_subscriptions (tier_id);

-- =====================================================================
-- 7. credit_transactions (audit trail)
-- =====================================================================
CREATE TABLE IF NOT EXISTS credit_transactions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    amount           INTEGER NOT NULL,            -- positive = credit, negative = debit
    balance_after    INTEGER NOT NULL,
    transaction_type TEXT NOT NULL
                       CHECK (transaction_type IN ('monthly_reset','usage','admin_adjustment','purchase','refund')),
    description      TEXT,
    reference_id     TEXT,                        -- content id / job id / workflow execution id / Stripe id
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user
    ON credit_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_type
    ON credit_transactions (transaction_type, created_at DESC);

-- =====================================================================
-- 8. impersonation_log (superuser audit)
-- =====================================================================
CREATE TABLE IF NOT EXISTS impersonation_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    superuser_id    TEXT NOT NULL REFERENCES users_v2(user_id),
    target_user_id  TEXT NOT NULL REFERENCES users_v2(user_id),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    reason          TEXT,
    actions_taken   JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- A superuser may have at most one ACTIVE (ended_at IS NULL) impersonation at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_impersonation_active_per_superuser
    ON impersonation_log (superuser_id)
    WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_impersonation_target
    ON impersonation_log (target_user_id, started_at DESC);

-- =====================================================================
-- 9. updated_at touch trigger (shared)
-- =====================================================================
CREATE OR REPLACE FUNCTION rbac_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_account_meta_touch ON user_account_meta_v2;
CREATE TRIGGER trg_user_account_meta_touch
  BEFORE UPDATE ON user_account_meta_v2
  FOR EACH ROW EXECUTE FUNCTION rbac_touch_updated_at();

DROP TRIGGER IF EXISTS trg_subscription_tiers_touch ON subscription_tiers;
CREATE TRIGGER trg_subscription_tiers_touch
  BEFORE UPDATE ON subscription_tiers
  FOR EACH ROW EXECUTE FUNCTION rbac_touch_updated_at();

DROP TRIGGER IF EXISTS trg_user_subscriptions_touch ON user_subscriptions;
CREATE TRIGGER trg_user_subscriptions_touch
  BEFORE UPDATE ON user_subscriptions
  FOR EACH ROW EXECUTE FUNCTION rbac_touch_updated_at();

-- =====================================================================
-- 10. RLS policies
-- =====================================================================
ALTER TABLE user_account_meta_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role_meta_v2    ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_tiers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_log    ENABLE ROW LEVEL SECURITY;

-- user_account_meta_v2: users see their own row; admins/superusers see all.
DROP POLICY IF EXISTS user_account_meta_self ON user_account_meta_v2;
CREATE POLICY user_account_meta_self ON user_account_meta_v2
  FOR SELECT
  USING (user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS user_account_meta_service ON user_account_meta_v2;
CREATE POLICY user_account_meta_service ON user_account_meta_v2
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- user_role_meta_v2: admins/superusers see all rows; users do NOT see role table.
DROP POLICY IF EXISTS user_role_meta_admin_read ON user_role_meta_v2;
CREATE POLICY user_role_meta_admin_read ON user_role_meta_v2
  FOR SELECT USING (is_admin_v2() OR user_id = get_current_user_id());

DROP POLICY IF EXISTS user_role_meta_service ON user_role_meta_v2;
CREATE POLICY user_role_meta_service ON user_role_meta_v2
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- subscription_tiers: readable by all authenticated; mutable only by superuser/admin (via service role on server).
DROP POLICY IF EXISTS subscription_tiers_read ON subscription_tiers;
CREATE POLICY subscription_tiers_read ON subscription_tiers
  FOR SELECT USING (true);

DROP POLICY IF EXISTS subscription_tiers_service ON subscription_tiers;
CREATE POLICY subscription_tiers_service ON subscription_tiers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- user_subscriptions: users see own; admins/superusers see all.
DROP POLICY IF EXISTS user_subscriptions_self ON user_subscriptions;
CREATE POLICY user_subscriptions_self ON user_subscriptions
  FOR SELECT USING (user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS user_subscriptions_service ON user_subscriptions;
CREATE POLICY user_subscriptions_service ON user_subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- credit_transactions: users see own; admins/superusers see all.
DROP POLICY IF EXISTS credit_transactions_self ON credit_transactions;
CREATE POLICY credit_transactions_self ON credit_transactions
  FOR SELECT USING (user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS credit_transactions_service ON credit_transactions;
CREATE POLICY credit_transactions_service ON credit_transactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- impersonation_log: only superusers; service role for server-side writes.
DROP POLICY IF EXISTS impersonation_log_superuser ON impersonation_log;
CREATE POLICY impersonation_log_superuser ON impersonation_log
  FOR SELECT USING (is_superuser_v2());

DROP POLICY IF EXISTS impersonation_log_service ON impersonation_log;
CREATE POLICY impersonation_log_service ON impersonation_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================================
-- 11. Seed: 5 subscription tiers
-- =====================================================================
-- All credit and price values are superuser-configurable defaults; the seed
-- sets a sensible starting point that matches the sprint-plan feature matrix.
INSERT INTO subscription_tiers
  (name, display_name, description, monthly_credits, monthly_price_cents, annual_price_cents,
   credit_purchase_price_cents, features, is_default, publicly_selectable, trial_days, sort_order)
VALUES
  ('standard',  'Standard',
                'Core writing features with monthly credit allowance.',
                100,  1999,  19900,  100,
                jsonb_build_object('kdp_export', false, 'cover_art', false, 'social_media', false,
                                   'max_projects', 5),
                true,  true, 0,  10),
  ('pro',       'Professional',
                'All features unlocked with higher monthly credit allowance.',
                500,  4999,  49900,  100,
                jsonb_build_object('kdp_export', true, 'cover_art', true, 'social_media', true,
                                   'max_projects', 50),
                false, true, 0,  20),
  ('trial',     'Free 30-Day Trial',
                'All features for 30 days. Converts to paid or expires.',
                200,  0,     0,      100,
                jsonb_build_object('kdp_export', true, 'cover_art', true, 'social_media', true,
                                   'max_projects', 10),
                false, true, 30, 5),
  ('paid_full', 'Full Access (Paid)',
                'All features plus the highest monthly credit allowance.',
                1000, 4999,  49900,  100,
                jsonb_build_object('kdp_export', true, 'cover_art', true, 'social_media', true,
                                   'max_projects', 200),
                false, true, 0,  30),
  ('free_full', 'Full Access (Comp)',
                'Admin-provisioned full-access account. Not publicly selectable.',
                1000, 0,     0,      100,
                jsonb_build_object('kdp_export', true, 'cover_art', true, 'social_media', true,
                                   'max_projects', 200),
                false, false, 0, 40)
ON CONFLICT (name) DO NOTHING;

-- =====================================================================
-- 12. Seed: superuser bootstrap for Eric (+14105914612)
-- =====================================================================
-- The seed superuser is created via INSERT directly. The role-escalation trigger
-- bypasses for service role (auth.uid() IS NULL), and migrations run as service
-- role / postgres, so this insert succeeds. After this, only existing superusers
-- can promote others.
INSERT INTO user_role_meta_v2 (user_id, role, granted_by, notes)
SELECT '+14105914612', 'superuser', NULL, 'Initial superuser seeded by migration 011'
WHERE EXISTS (SELECT 1 FROM users_v2 WHERE user_id = '+14105914612')
ON CONFLICT (user_id) DO UPDATE SET role = 'superuser';

-- Free-full subscription for the superuser (no charge, never expires).
INSERT INTO user_subscriptions
  (user_id, tier_id, status, billing_cycle, current_period_end, credits_remaining, auto_renew, created_by)
SELECT
  '+14105914612',
  t.id,
  'active',
  'none',
  NULL,
  t.monthly_credits,
  false,
  NULL
FROM subscription_tiers t
WHERE t.name = 'free_full'
  AND EXISTS (SELECT 1 FROM users_v2 WHERE user_id = '+14105914612')
ON CONFLICT (user_id) DO NOTHING;

-- Active-account row so locked-account logic has a row to read for the superuser.
INSERT INTO user_account_meta_v2 (user_id, account_status)
SELECT '+14105914612', 'active'
WHERE EXISTS (SELECT 1 FROM users_v2 WHERE user_id = '+14105914612')
ON CONFLICT (user_id) DO NOTHING;
