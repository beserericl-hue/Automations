-- 056 — Audiobooks: narrate a book (or one book of a series) chapter by chapter, each chapter its own
-- linked recording.
--
-- WHY. The Publish screen builds the KDP package and printed copies; an audiobook is the third
-- edition of the same manuscript. The narration is synthetic (an expressive text-to-speech voice),
-- one MP3 per chapter, mastered to the audiobook retail spec (192 kbps CBR, 44.1 kHz, loudness and
-- peak windows) so the files can go to a retailer as they are. They are heavy (minutes of audio per
-- chapter), so each recording is built by an engine job and its row says where it stands.
--
-- Two tables, both new:
--   audiobooks_v2          one per (project, volume): the voice, the narration style, the credits.
--   audiobook_chapters_v2  one per recording: opening credits, each chapter, closing credits, the
--                          retail sample. Holds the text that was narrated (so a rebuild is exactly
--                          reproducible and "has the chapter changed since?" is a hash compare), the
--                          state of the build, the stored MP3 and what the mastering measured.
--
-- Governance (docs/schema-governance.md): new meta tables; no base table is altered. One FK to
-- users_v2 and one to writing_projects_v2 on audiobooks_v2 — never a second FK between the same two
-- tables (the DEV PGRST201 incident); the chapter table reaches both through audiobooks_v2.
-- Owner-only RLS like 032/054; the server and the engine write with the service role. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS audiobooks_v2 (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    project_id     UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
    -- Which book of a series (1 for a single book). An audiobook is made per book, like KDP.
    volume_index   INTEGER NOT NULL DEFAULT 1 CHECK (volume_index BETWEEN 1 AND 12),
    -- The narrator: a voice of the speech provider, and the direction it is given.
    provider       TEXT NOT NULL DEFAULT 'openai',
    model          TEXT NOT NULL DEFAULT 'gpt-4o-mini-tts',
    voice          TEXT NOT NULL DEFAULT 'marin',
    -- A preset key ('fiction', 'thriller', 'intimate', 'epic', 'custom'); `custom_style` is used when 'custom'.
    style          TEXT NOT NULL DEFAULT 'fiction',
    custom_style   TEXT NOT NULL DEFAULT '',
    -- Spoken before chapter 1 and after the last chapter. Off means the recordings are chapters only.
    credits        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, volume_index)
);

CREATE INDEX IF NOT EXISTS idx_audiobooks_v2_user ON audiobooks_v2 (user_id);

COMMENT ON TABLE audiobooks_v2 IS
  'One audiobook per (project, volume): the narrator voice, narration style and whether credits are spoken. The recordings are audiobook_chapters_v2.';

CREATE TABLE IF NOT EXISTS audiobook_chapters_v2 (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audiobook_id   UUID NOT NULL REFERENCES audiobooks_v2(id) ON DELETE CASCADE,
    -- opening = spoken title/author/narrator credit; chapter; closing = end credit; sample = retail sample.
    kind           TEXT NOT NULL CHECK (kind IN ('opening', 'chapter', 'closing', 'sample')),
    -- The manuscript's chapter number for kind='chapter'; 0 for the other kinds.
    chapter_number INTEGER NOT NULL DEFAULT 0,
    -- Position in the listening order (opening first), for the file names and the list.
    position       INTEGER NOT NULL DEFAULT 0,
    title          TEXT NOT NULL DEFAULT '',
    -- What is narrated, exactly (chapter text snapshotted at build time) and its hash with the
    -- narrator settings; a differing hash on the next read = "changed since it was recorded".
    source_text    TEXT NOT NULL DEFAULT '',
    text_hash      TEXT NOT NULL DEFAULT '',
    -- The voice settings the recording was made with (a snapshot, so a settings change flags it stale).
    voice          TEXT NOT NULL DEFAULT '',
    style_hash     TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'ready', 'failed')),
    error          TEXT,
    -- The stored MP3 (bucket audiobooks) and what mastering measured on it.
    storage_path   TEXT,
    size_bytes     BIGINT,
    duration_s     NUMERIC(10, 2),
    rms_db         NUMERIC(6, 2),
    peak_db        NUMERIC(6, 2),
    -- True when the measured file is inside the retail loudness/peak windows.
    spec_ok        BOOLEAN,
    chars          INTEGER NOT NULL DEFAULT 0,
    engine_job_id  TEXT,
    started_at     TIMESTAMPTZ,
    built_at       TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (audiobook_id, kind, chapter_number)
);

CREATE INDEX IF NOT EXISTS idx_audiobook_chapters_v2_book ON audiobook_chapters_v2 (audiobook_id, position);

COMMENT ON TABLE audiobook_chapters_v2 IS
  'One recording of an audiobook: opening credits, a chapter, closing credits or the retail sample. Holds the narrated text, build status, the stored MP3 and its measured loudness.';

ALTER TABLE audiobooks_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE audiobook_chapters_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_read_own_audiobooks ON audiobooks_v2;
CREATE POLICY users_read_own_audiobooks
    ON audiobooks_v2
    FOR SELECT
    USING (
        user_id IN (
            SELECT u.user_id FROM users_v2 u WHERE u.supabase_auth_uid = auth.uid()
        )
    );

DROP POLICY IF EXISTS service_role_all_audiobooks ON audiobooks_v2;
CREATE POLICY service_role_all_audiobooks
    ON audiobooks_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS users_read_own_audiobook_chapters ON audiobook_chapters_v2;
CREATE POLICY users_read_own_audiobook_chapters
    ON audiobook_chapters_v2
    FOR SELECT
    USING (
        audiobook_id IN (
            SELECT a.id FROM audiobooks_v2 a
            WHERE a.user_id IN (SELECT u.user_id FROM users_v2 u WHERE u.supabase_auth_uid = auth.uid())
        )
    );

DROP POLICY IF EXISTS service_role_all_audiobook_chapters ON audiobook_chapters_v2;
CREATE POLICY service_role_all_audiobook_chapters
    ON audiobook_chapters_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- The recordings are private: the server hands out short-lived signed links, never a public URL.
INSERT INTO storage.buckets (id, name, public)
VALUES ('audiobooks', 'audiobooks', FALSE)
ON CONFLICT (id) DO NOTHING;

COMMIT;
