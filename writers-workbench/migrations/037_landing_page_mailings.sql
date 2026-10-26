-- 037 — Writing to the people who reserved a copy.
--
-- WHY. A reservation (migration 035) is a person asking to be told when the book is out. The author
-- now writes to them from the Workbench, so each address needs a way to stop the mail, and each
-- mailing needs a record of who it went to.
--
-- Reservations gain an unsubscribe token (the link in every email), when they unsubscribed, and when
-- they were last written to. An unsubscribed address is never sent another mailing.
--
-- landing_page_reservations_v2 is a meta table (035), not a base table, so it may be altered here.

ALTER TABLE landing_page_reservations_v2
    ADD COLUMN IF NOT EXISTS unsubscribe_token UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS unsubscribed_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_emailed_at   TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_landing_page_reservations_unsub
    ON landing_page_reservations_v2 (unsubscribe_token);

CREATE TABLE IF NOT EXISTS landing_page_mailings_v2 (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    subject       TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
    body          TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
    -- The buy link the email carried, if any, as it was when sent.
    buy_url       TEXT,
    recipients    INTEGER NOT NULL DEFAULT 0,
    sent          INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_landing_page_mailings_owner
    ON landing_page_mailings_v2 (user_id, project_id, created_at DESC);

COMMENT ON TABLE landing_page_mailings_v2 IS
  'Emails an author sent to the people who reserved a copy on the book''s landing page. Written only by the server.';

ALTER TABLE landing_page_mailings_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_read_own_mailings ON landing_page_mailings_v2;
CREATE POLICY users_read_own_mailings
    ON landing_page_mailings_v2
    FOR SELECT
    USING (
        user_id IN (
            SELECT u.user_id FROM users_v2 u WHERE u.supabase_auth_uid = auth.uid()
        )
    );

DROP POLICY IF EXISTS service_role_all_mailings ON landing_page_mailings_v2;
CREATE POLICY service_role_all_mailings
    ON landing_page_mailings_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
