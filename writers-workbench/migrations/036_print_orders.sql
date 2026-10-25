-- 036 — Printed copies ordered from RPI Print.
--
-- WHY. An author can now order printed copies of a book (a proof, copies for reviewers or events)
-- from the project's Publish tab. RPI prints and ships them, and reports each step by webhook, over
-- hours or days. Every order needs a row that outlives the request that placed it: what was
-- ordered, the files RPI was sent, where it is going, and what RPI last said about it.
--
-- One row per order. A row starts as DRAFT when the files are built and priced, and takes RPI's
-- status once it is submitted. `customer_order_id` is the identifier RPI knows the order by; it is
-- unique per RPI customer across sandbox and production, so it is unique here too.
--
-- A new meta table with FKs into the base tables, so in bounds under docs/schema-governance.md.

CREATE TABLE IF NOT EXISTS print_orders_v2 (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    project_id              UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
    volume_index            INTEGER NOT NULL DEFAULT 1 CHECK (volume_index BETWEEN 1 AND 12),
    edition                 TEXT NOT NULL CHECK (edition IN ('softcover_matte', 'softcover_gloss', 'hardcover_wrap', 'hardcover_jacket')),
    sku                     TEXT NOT NULL,
    -- Sandbox orders are never printed or charged. Which one an order is was decided by the API key.
    mode                    TEXT NOT NULL DEFAULT 'sandbox' CHECK (mode IN ('sandbox', 'production')),
    quantity                INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 9999),
    -- The interior's real page count (before RPI pads it to an even number), and the spine it gives.
    page_count              INTEGER NOT NULL CHECK (page_count > 0),
    spine_in                NUMERIC(6,3),
    -- Storage paths in the private print-files bucket. RPI is sent signed URLs to them.
    interior_path           TEXT NOT NULL,
    outside_path            TEXT NOT NULL,
    preview_path            TEXT,
    -- DRAFT until submitted; then RPI's own status (RECEIVED, PRINTING, SHIPPED, FAILED ...).
    status                  TEXT NOT NULL DEFAULT 'DRAFT',
    customer_order_id       TEXT UNIQUE CHECK (char_length(customer_order_id) <= 40),
    shipping_classification TEXT,
    destination             JSONB,
    -- What RPI quoted before the order was placed, and the order as RPI last reported it.
    quote                   JSONB,
    rpi                     JSONB,
    last_event              TEXT,
    events                  JSONB NOT NULL DEFAULT '[]'::jsonb,
    submitted_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_print_orders_owner
    ON print_orders_v2 (user_id, project_id, created_at DESC);

COMMENT ON TABLE print_orders_v2 IS
  'Printed copies ordered through RPI Print. Written only by the server; status updated by RPI webhooks.';

ALTER TABLE print_orders_v2 ENABLE ROW LEVEL SECURITY;

-- The author may read their own orders.
DROP POLICY IF EXISTS users_read_own_print_orders ON print_orders_v2;
CREATE POLICY users_read_own_print_orders
    ON print_orders_v2
    FOR SELECT
    USING (
        user_id IN (
            SELECT u.user_id FROM users_v2 u WHERE u.supabase_auth_uid = auth.uid()
        )
    );

-- Every write goes through the server, which talks to RPI; nobody writes with the anon key.
DROP POLICY IF EXISTS service_role_all_print_orders ON print_orders_v2;
CREATE POLICY service_role_all_print_orders
    ON print_orders_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
