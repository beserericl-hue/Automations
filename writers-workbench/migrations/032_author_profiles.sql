-- 032 — Author profiles: the facts a bio is built from.
--
-- WHY THIS TABLE EXISTS. A bio cannot be written from a manuscript. Where someone lives, what they
-- did before, what connects them to the material — every line of a bio is a fact about a person,
-- and a model asked for one without those facts either invents a career or writes "This is his
-- debut novel". The first is a false claim printed in a book.
--
-- The bio generator already refuses to invent. What was missing was anywhere for the author to put
-- the truth, so the facts were being passed in by hand and lost the moment the process ended. This
-- is that place.
--
-- One row per user, not per project: an author's background does not change between books. The
-- per-book part (why THIS book) lives on the project, because it does.

CREATE TABLE IF NOT EXISTS author_profiles_v2 (
    user_id         TEXT PRIMARY KEY REFERENCES users_v2(user_id) ON DELETE CASCADE,

    -- The byline. Deliberately separate from users_v2.name: a pen name is not the name on the
    -- account, and the copyright page needs whichever the author chose.
    pen_name        TEXT,
    -- "Baltimore, Maryland". Conventional in a bio, and optional.
    lives           TEXT,
    -- Career and expertise, especially where it touches the books.
    background      TEXT,
    -- Degrees, awards, memberships. An array so the writer can be told to use all or none; it must
    -- never be free to pick a plausible-sounding one.
    credentials     TEXT[] NOT NULL DEFAULT '{}',
    -- Earlier books, articles, films.
    prior_work      TEXT[] NOT NULL DEFAULT '{}',
    -- What connects this author to the material. The sentence a reader at the back cover wants, and
    -- the one the bio leads with. Per-user default; a project overrides it on its own screen,
    -- because an author's second book is about something else.
    why_this_book   TEXT,
    -- The human detail that stops a bio reading as a CV.
    personal        TEXT,
    -- Site, socials. Author Central wants them; the bio does not use them.
    links           TEXT[] NOT NULL DEFAULT '{}',

    -- The APPROVED bio: what the generator produced and the author accepted or rewrote. Kept apart
    -- from the facts because it is a different kind of thing — the facts are input, this is the
    -- reviewed output the back cover and Author Central actually print. `bio_source` records whether
    -- a human touched it, which is the difference between copy to re-check and copy that is signed off.
    bio             TEXT,
    bio_source      TEXT CHECK (bio_source IN ('generated', 'edited')),
    bio_updated_at  TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE author_profiles_v2 IS
  'Facts a bio is written from. The bio generator is forbidden to invent anything not here, so an empty row means a short honest bio rather than a fabricated career.';
COMMENT ON COLUMN author_profiles_v2.pen_name IS
  'The byline. A pen name is not the name on the account, and the copyright page needs whichever the author chose.';
COMMENT ON COLUMN author_profiles_v2.credentials IS
  'Degrees, awards, memberships — verbatim. A model must never be free to supply a plausible-sounding one.';

ALTER TABLE author_profiles_v2 ENABLE ROW LEVEL SECURITY;

-- The client reads its own profile directly with the anon key, as it does elsewhere.
DROP POLICY IF EXISTS users_read_own_author_profile ON author_profiles_v2;
CREATE POLICY users_read_own_author_profile
    ON author_profiles_v2
    FOR SELECT
    USING (
        user_id IN (
            SELECT u.user_id FROM users_v2 u WHERE u.supabase_auth_uid = auth.uid()
        )
    );

-- Writes go through the server so they are validated once, in one place.
DROP POLICY IF EXISTS service_role_all_author_profiles ON author_profiles_v2;
CREATE POLICY service_role_all_author_profiles
    ON author_profiles_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
