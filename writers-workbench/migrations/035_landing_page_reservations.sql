-- 035 — Reservations from a book's public landing page.
--
-- WHY. A project's landing page can now be published at /books/<slug> on the Workbench itself, with
-- a pre-order form that a stranger fills in without an account. Each submission is a person asking
-- to be told when the book is out, and the author needs that list kept, not mailed somewhere and
-- lost.
--
-- Not on the project outline, where the rest of the landing page lives: that column is written
-- whole by the engine and the author, and a public form appending to it would race both. These are
-- rows, written by strangers, so they get a table.
--
-- One row per person per book. The same address submitted twice is one reservation, not two: the
-- unique key is on the lower-cased, trimmed address.
--
-- A new meta table with FKs into the base tables, so in bounds under docs/schema-governance.md.

CREATE TABLE IF NOT EXISTS landing_page_reservations_v2 (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
    -- The author: who may read these. Denormalised from the project so RLS is one lookup.
    user_id          TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    first_name       TEXT NOT NULL DEFAULT '' CHECK (char_length(first_name) <= 100),
    email            TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
    email_normalized TEXT GENERATED ALWAYS AS (lower(btrim(email))) STORED,
    -- The page address it came through, in case a book is ever published under a second one.
    slug             TEXT NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, email_normalized)
);

CREATE INDEX IF NOT EXISTS idx_landing_page_reservations_owner
    ON landing_page_reservations_v2 (user_id, project_id, created_at DESC);

COMMENT ON TABLE landing_page_reservations_v2 IS
  'Pre-order reservations from a project''s public landing page (/books/<slug>). Written only by the server.';

ALTER TABLE landing_page_reservations_v2 ENABLE ROW LEVEL SECURITY;

-- The author may read their own book's reservations.
DROP POLICY IF EXISTS users_read_own_reservations ON landing_page_reservations_v2;
CREATE POLICY users_read_own_reservations
    ON landing_page_reservations_v2
    FOR SELECT
    USING (
        user_id IN (
            SELECT u.user_id FROM users_v2 u WHERE u.supabase_auth_uid = auth.uid()
        )
    );

-- Inserts come from the public form through the server, which validates them; nobody writes with
-- the anon key.
DROP POLICY IF EXISTS service_role_all_reservations ON landing_page_reservations_v2;
CREATE POLICY service_role_all_reservations
    ON landing_page_reservations_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
