-- 039 — Sprint 9: Stripe payments (subscriptions, credit packs, reader print orders).
--
-- WHY. Sprint 8 built tiers, subscriptions and credits with no way to take money: a paid tier
-- could be "subscribed to" for free (POST /api/account/subscribe activated it with no payment), and
-- credit purchases were switched off. Stripe becomes the source of truth for billing; Supabase stays
-- the source of truth for access. Entitlements change only in the Stripe webhook handler.
--
-- Divergence from the sprint document (S9-1), on purpose: it adds `users_v2.stripe_customer_id`.
-- users_v2 is a base table and may not be altered by migrations 008+ (docs/schema-governance.md),
-- so the customer link is its own table, stripe_customers_v2. Everything else here is a new table
-- or a column on a non-base table (subscription_tiers, user_subscriptions, credit_transactions,
-- print_orders_v2).

-- One Stripe Customer per user.
CREATE TABLE IF NOT EXISTS stripe_customers_v2 (
    user_id             TEXT PRIMARY KEY REFERENCES users_v2(user_id) ON DELETE CASCADE,
    stripe_customer_id  TEXT NOT NULL UNIQUE,
    -- 'test' or 'live': a test-mode customer id means nothing to a live key, and the reverse.
    mode                TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each tier's Stripe Product and its two Prices (filled by scripts/seed-stripe-products.ts).
ALTER TABLE subscription_tiers
    ADD COLUMN IF NOT EXISTS stripe_product_id        TEXT,
    ADD COLUMN IF NOT EXISTS stripe_price_monthly_id  TEXT,
    ADD COLUMN IF NOT EXISTS stripe_price_annual_id   TEXT;

-- The subscription as Stripe has it.
ALTER TABLE user_subscriptions
    ADD COLUMN IF NOT EXISTS stripe_subscription_id      TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS stripe_price_id             TEXT,
    ADD COLUMN IF NOT EXISTS stripe_status               TEXT,
    ADD COLUMN IF NOT EXISTS stripe_current_period_end   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancel_at_period_end        BOOLEAN NOT NULL DEFAULT false,
    -- A downgrade waits for the period end; these say what it will become and when.
    ADD COLUMN IF NOT EXISTS pending_tier_id             UUID REFERENCES subscription_tiers(id),
    ADD COLUMN IF NOT EXISTS pending_billing_cycle       TEXT,
    ADD COLUMN IF NOT EXISTS pending_change_at           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_failures            INTEGER NOT NULL DEFAULT 0;

-- A credit pack bought through Stripe, and the refund of one, point at the PaymentIntent.
ALTER TABLE credit_transactions
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_stripe_purchase
    ON credit_transactions (stripe_payment_intent_id) WHERE transaction_type = 'purchase' AND stripe_payment_intent_id IS NOT NULL;

-- Every webhook event, once. A retry of an event already processed is answered 200 and skipped.
CREATE TABLE IF NOT EXISTS stripe_events_v2 (
    id            TEXT PRIMARY KEY,                -- evt_…
    event_type    TEXT NOT NULL,
    livemode      BOOLEAN NOT NULL DEFAULT false,
    status        TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'processed', 'failed', 'ignored')),
    error         TEXT,
    object_id     TEXT,
    user_id       TEXT,
    payload       JSONB,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_stripe_events_recent ON stripe_events_v2 (received_at DESC);

-- Reader print orders: a reader buys a printed copy from the public book page and pays through
-- Stripe; the order goes to RPI only once the payment has cleared. An author order has no buyer.
ALTER TABLE print_orders_v2
    ADD COLUMN IF NOT EXISTS order_kind                  TEXT NOT NULL DEFAULT 'author' CHECK (order_kind IN ('author', 'reader')),
    ADD COLUMN IF NOT EXISTS buyer_name                  TEXT,
    ADD COLUMN IF NOT EXISTS buyer_email                 TEXT,
    ADD COLUMN IF NOT EXISTS stripe_checkout_session_id  TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id    TEXT,
    ADD COLUMN IF NOT EXISTS amount_total_cents          INTEGER,
    ADD COLUMN IF NOT EXISTS currency                    TEXT,
    ADD COLUMN IF NOT EXISTS paid_at                     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS offer_id                    UUID;

-- What a book sells for in print: one row per project, volume and edition the author switches on.
-- The files are a prepared author order's (source_order_id), so readers get exactly the proof the
-- author approved.
CREATE TABLE IF NOT EXISTS print_offers_v2 (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    project_id       UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
    volume_index     INTEGER NOT NULL DEFAULT 1,
    edition          TEXT NOT NULL CHECK (edition IN ('softcover_matte', 'softcover_gloss', 'hardcover_wrap', 'hardcover_jacket')),
    source_order_id  UUID NOT NULL REFERENCES print_orders_v2(id) ON DELETE RESTRICT,
    price_cents      INTEGER NOT NULL CHECK (price_cents BETWEEN 100 AND 100000),
    currency         TEXT NOT NULL DEFAULT 'usd',
    enabled          BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, volume_index, edition)
);

ALTER TABLE print_orders_v2 DROP CONSTRAINT IF EXISTS print_orders_v2_offer_fk;
ALTER TABLE print_orders_v2
    ADD CONSTRAINT print_orders_v2_offer_fk FOREIGN KEY (offer_id) REFERENCES print_offers_v2(id) ON DELETE SET NULL;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['stripe_customers_v2', 'print_offers_v2'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS owner_read ON %I', t);
        EXECUTE format('CREATE POLICY owner_read ON %I FOR SELECT USING (user_id = get_current_user_id() OR is_admin_v2())', t);
        EXECUTE format('DROP POLICY IF EXISTS service_role_all ON %I', t);
        EXECUTE format('CREATE POLICY service_role_all ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
    END LOOP;
END $$;

ALTER TABLE stripe_events_v2 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_read ON stripe_events_v2;
CREATE POLICY admin_read ON stripe_events_v2 FOR SELECT USING (is_admin_v2());
DROP POLICY IF EXISTS service_role_all ON stripe_events_v2;
CREATE POLICY service_role_all ON stripe_events_v2 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_stripe_customers_touch ON stripe_customers_v2;
CREATE TRIGGER trg_stripe_customers_touch BEFORE UPDATE ON stripe_customers_v2
    FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();
DROP TRIGGER IF EXISTS trg_print_offers_touch ON print_offers_v2;
CREATE TRIGGER trg_print_offers_touch BEFORE UPDATE ON print_offers_v2
    FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();

-- Atomic credit change. Every caller used to read the balance and write back a new one, so a credit
-- purchase landing while a chapter deducted credits overwrote one of the two (S9-9 race test).
-- Returns the new balance, or NULL when a deduction would take the balance below zero.
CREATE OR REPLACE FUNCTION credits_add_v2(p_user_id TEXT, p_delta INTEGER, p_count_usage BOOLEAN DEFAULT false)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE user_subscriptions
       SET credits_remaining = credits_remaining + p_delta,
           credits_used_this_period = credits_used_this_period + CASE WHEN p_count_usage THEN -p_delta ELSE 0 END,
           updated_at = now()
     WHERE user_id = p_user_id
       AND credits_remaining + p_delta >= 0
    RETURNING credits_remaining;
$$;
REVOKE ALL ON FUNCTION credits_add_v2(TEXT, INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION credits_add_v2(TEXT, INTEGER, BOOLEAN) TO service_role;
