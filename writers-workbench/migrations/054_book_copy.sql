-- 054 — Book copy the author writes that had nowhere to live: a subtitle, the inside-flap copy and
-- the "Also by" list.
--
-- WHY. The promotion area gained an AI assistant on every field the author writes by hand (draft,
-- revise, undo; the author saves the final text). Three fields an author reasonably expects did not
-- exist at all: the book's SUBTITLE (a KDP field, and the title page), the INSIDE-FLAP copy (the
-- hardcover jacket's front flap, longer than the back cover) and the "ALSO BY" list (the back-matter
-- page; until now it only ever listed a series' own siblings). They are per book of a series, so
-- they are keyed by volume_index as well as the project ("also_by" is stored on volume 1 and printed
-- in every book).
--
-- Governance (docs/schema-governance.md): a NEW meta table with one FK to each parent; no base table
-- is altered. One FK to users_v2 and one to writing_projects_v2 — never a second FK between the same
-- two tables (the DEV PGRST201 incident). Owner-only RLS like 032; the server writes with the
-- service role. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS book_copy_v2 (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    project_id    UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
    -- Which book of a series (1 for a single book). KDP lists each book separately.
    volume_index  INTEGER NOT NULL DEFAULT 1 CHECK (volume_index BETWEEN 1 AND 12),
    field         TEXT NOT NULL CHECK (field IN ('subtitle', 'inside_flap', 'also_by')),
    -- The author's saved text. A list field ("also_by") is one entry per line.
    value         TEXT NOT NULL DEFAULT '',
    -- 'generated' when the author saved an AI draft untouched, 'edited' when they changed it.
    source        TEXT NOT NULL DEFAULT 'edited' CHECK (source IN ('generated', 'edited')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, volume_index, field)
);

CREATE INDEX IF NOT EXISTS idx_book_copy_v2_user ON book_copy_v2 (user_id);

COMMENT ON TABLE book_copy_v2 IS
  'Per-book copy the author writes that has no home on the project: subtitle, inside-flap copy, the Also-by list. Saved only by the author; AI drafts are never written here on their own.';

ALTER TABLE book_copy_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_read_own_book_copy ON book_copy_v2;
CREATE POLICY users_read_own_book_copy
    ON book_copy_v2
    FOR SELECT
    USING (
        user_id IN (
            SELECT u.user_id FROM users_v2 u WHERE u.supabase_auth_uid = auth.uid()
        )
    );

DROP POLICY IF EXISTS service_role_all_book_copy ON book_copy_v2;
CREATE POLICY service_role_all_book_copy
    ON book_copy_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMIT;
