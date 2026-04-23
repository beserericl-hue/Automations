-- Sprint 11 S11-5: email bounces and complaints from Postal.
--
-- Captures every bounce / complaint / failure event Postal reports via
-- its webhook so we can surface them to the admin UI and disable
-- recipients that are permanently undeliverable.
--
-- Governance note (see writers-workbench/docs/schema-governance.md):
-- migration 010 — additive only. Does not ALTER / DROP / RENAME any
-- of the 9 base tables. Standalone audit table, no FK to users_v2 (an
-- incoming bounce may reference a recipient address we don't control).

CREATE TABLE IF NOT EXISTS email_bounces_v2 (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Postal-side identifiers so we can correlate bounces back to the
    -- original /api/email/send call
    postal_message_id TEXT,                            -- Postal's message token
    postal_event_id   TEXT,                            -- Postal's event uuid (dedup key)
    event_type        TEXT NOT NULL                    -- MessageBounced | MessageHeld | MessageLoaded | SpamComplaint | ...
                        CHECK (event_type IN (
                          'MessageBounced', 'MessageHeld', 'SpamComplaint',
                          'MessageDeliveryFailed', 'MessageDSNReceived',
                          'MessageLinkClicked', 'MessageLoaded'  -- loaded = opened; mostly for analytics
                        )),
    to_address        TEXT NOT NULL,
    from_address      TEXT,
    subject           TEXT,
    bounce_type       TEXT,                            -- HardBounce | SoftBounce | AutoReply | ...
    bounce_reason     TEXT,
    raw_payload       JSONB NOT NULL,                  -- full Postal event body for audit
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup: Postal re-sends the same event if we return non-2xx. Unique
-- index on event_id prevents double-counting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_bounces_event
    ON email_bounces_v2 (postal_event_id)
    WHERE postal_event_id IS NOT NULL;

-- Recipient history: "show me every bounce for <address>"
CREATE INDEX IF NOT EXISTS idx_email_bounces_to
    ON email_bounces_v2 (to_address, received_at DESC);

-- Admin dashboard: "recent bounces across the whole system"
CREATE INDEX IF NOT EXISTS idx_email_bounces_received
    ON email_bounces_v2 (received_at DESC);

-- Event-type filter: "hard bounces only in the last 7 days"
CREATE INDEX IF NOT EXISTS idx_email_bounces_type
    ON email_bounces_v2 (event_type, received_at DESC);

-- RLS: admins only (read). Service role inserts via the webhook.
ALTER TABLE email_bounces_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admins_read_bounces ON email_bounces_v2;
CREATE POLICY admins_read_bounces
    ON email_bounces_v2
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM users_v2 u
            WHERE u.supabase_auth_uid = auth.uid()
              AND u.role = 'admin'
        )
    );

DROP POLICY IF EXISTS service_role_all_bounces ON email_bounces_v2;
CREATE POLICY service_role_all_bounces
    ON email_bounces_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
