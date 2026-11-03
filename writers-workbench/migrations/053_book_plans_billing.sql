-- 053 — Book plans, credit top-ups, a saved card and evergreen auto-recharge (the Billing page).
--
-- WHY. Owner decisions 2026-11-03:
--   * sell credits in book-sized bundles — "Half Book" = 1,000 credits for $99 and "Full Book" =
--     2,000 credits for $199 — in any quantity ("3 books"), alongside the monthly plans (which stay
--     as they are; "Full Access (Paid)" is NOT retired);
--   * smaller top-up packs to recharge credits;
--   * one saved card, used for the subscription and for one-click purchases;
--   * "evergreen" auto-recharge: when the balance falls below X, buy pack Y with the saved card.
-- Until now a credit purchase was only "N credits at the plan's per-credit price" (price_data built
-- on the fly): nothing to name, price, mirror into Stripe, or put in a purchase history.
--
-- WHAT (new meta tables; no base table is touched — docs/schema-governance.md). Stripe is the
-- source of truth for cards and payments (owner rule 2026-11-03): a card is a Stripe PaymentMethod on
-- the Stripe Customer (customer.invoice_settings.default_payment_method), plan renewals are Stripe
-- Subscriptions, and the purchase history is read from Stripe. Nothing here stores card data.
--   credit_packs_v2      the price list: kind 'book' | 'topup', credits, price, and the Stripe Product /
--                        one-time Price it is sold through (written back by
--                        server/scripts/seed-stripe-products.ts, lookup key `ww_pack_<name>`).
--                        Readable by everyone; written by the service role.
--   billing_settings_v2  per user, the evergreen auto-recharge settings only: threshold, pack, optional
--                        monthly cap, paused + why. `auto_recharge_claimed_at` / `_claim_pi` are the
--                        once-per-crossing lock: a conditional UPDATE takes it before the off-session
--                        PaymentIntent is created, and the webhook that grants (or fails) that payment
--                        releases it. Owner-only RLS (read); written by the service role.
--
-- Pack prices: books per the decision. Top-ups (proposed, priced a little above the book rate of
-- ~$0.099/credit because they are smaller, and far below the $1.00/credit ad-hoc price):
--   Top-up 250 = 250 credits for $29 ($0.116/credit); Top-up 500 = 500 credits for $55 ($0.11/credit).
--
-- Idempotent.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- credit_packs_v2
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_packs_v2 (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]{1,40}$'),
    kind              TEXT NOT NULL DEFAULT 'topup' CHECK (kind IN ('book', 'topup')),
    display_name      TEXT NOT NULL,
    description       TEXT,
    credits           INTEGER NOT NULL CHECK (credits > 0),
    price_cents       INTEGER NOT NULL CHECK (price_cents > 0),
    stripe_product_id TEXT,
    stripe_price_id   TEXT,
    active            BOOLEAN NOT NULL DEFAULT true,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_packs_v2_active ON credit_packs_v2 (active, kind, sort_order);

ALTER TABLE credit_packs_v2 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_packs_v2_read ON credit_packs_v2;
CREATE POLICY credit_packs_v2_read ON credit_packs_v2 FOR SELECT USING (true);
DROP POLICY IF EXISTS credit_packs_v2_service ON credit_packs_v2;
CREATE POLICY credit_packs_v2_service ON credit_packs_v2 TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_credit_packs_v2_touch ON credit_packs_v2;
CREATE TRIGGER trg_credit_packs_v2_touch BEFORE UPDATE ON credit_packs_v2
    FOR EACH ROW EXECUTE FUNCTION rbac_touch_updated_at();

-- A re-run keeps any Stripe ids already written back; it resets price and credits to these values
-- (the seed script then replaces the Stripe Price if the amount changed).
INSERT INTO credit_packs_v2 (name, kind, display_name, description, credits, price_cents, sort_order)
VALUES
    ('half_book',  'book',  'Half Book',   '1,000 credits: about half a novel, written, checked and repaired.', 1000,  9900, 10),
    ('full_book',  'book',  'Full Book',   '2,000 credits: a whole novel, written, checked and repaired.',      2000, 19900, 20),
    ('topup_250',  'topup', 'Top-up 250',  '250 credits.',                                                        250,  2900, 30),
    ('topup_500',  'topup', 'Top-up 500',  '500 credits.',                                                        500,  5500, 40)
ON CONFLICT (name) DO UPDATE
    SET kind         = EXCLUDED.kind,
        display_name = EXCLUDED.display_name,
        description  = EXCLUDED.description,
        credits      = EXCLUDED.credits,
        price_cents  = EXCLUDED.price_cents,
        sort_order   = EXCLUDED.sort_order;

-- ---------------------------------------------------------------------------------------------------
-- billing_settings_v2
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_settings_v2 (
    user_id                          TEXT PRIMARY KEY REFERENCES users_v2(user_id) ON DELETE CASCADE,
    auto_recharge_enabled            BOOLEAN NOT NULL DEFAULT false,
    auto_recharge_threshold          INTEGER NOT NULL DEFAULT 100 CHECK (auto_recharge_threshold >= 0),
    auto_recharge_pack               TEXT REFERENCES credit_packs_v2(name) ON UPDATE CASCADE,
    auto_recharge_monthly_cap_cents  INTEGER CHECK (auto_recharge_monthly_cap_cents IS NULL OR auto_recharge_monthly_cap_cents > 0),
    auto_recharge_paused             BOOLEAN NOT NULL DEFAULT false,
    auto_recharge_paused_reason      TEXT,
    auto_recharge_paused_at          TIMESTAMPTZ,
    auto_recharge_claimed_at         TIMESTAMPTZ,
    auto_recharge_claim_pi           TEXT,
    auto_recharge_last_event         TEXT,
    auto_recharge_last_event_at      TIMESTAMPTZ,
    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE billing_settings_v2 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_settings_v2_owner ON billing_settings_v2;
CREATE POLICY billing_settings_v2_owner ON billing_settings_v2 FOR SELECT
    USING (user_id = (SELECT u.user_id FROM users_v2 u WHERE u.supabase_auth_uid = auth.uid() LIMIT 1));
DROP POLICY IF EXISTS billing_settings_v2_service ON billing_settings_v2;
CREATE POLICY billing_settings_v2_service ON billing_settings_v2 TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_billing_settings_v2_touch ON billing_settings_v2;
CREATE TRIGGER trg_billing_settings_v2_touch BEFORE UPDATE ON billing_settings_v2
    FOR EACH ROW EXECUTE FUNCTION rbac_touch_updated_at();

COMMIT;
