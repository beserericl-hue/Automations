-- Migration 025: per-chapter generation telemetry (CR-005)
--
-- Persists the QA/observability artifacts every chapter run produces so the
-- project view can show "did it drift / was it researched / how good / how
-- fast", and so a stress test can be diagnosed from the database instead of
-- ephemeral logs. Mirrors content_versions_v2's history model: one row per
-- chapter RUN (no unique on project+chapter), newest by created_at wins in
-- the UI.
--
-- Governance note (see writers-workbench/docs/schema-governance.md):
-- Numbered 025, so it must NOT ALTER / DROP / RENAME any of the 9 base
-- tables. It only CREATEs a new meta table that references writing_projects_v2
-- and users_v2 via additive FKs. craft_qa / drift_report etc. live here, NOT
-- as new columns on the immutable base tables.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS chapter_qa_v2 (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    project_id          UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
    chapter_number      INTEGER NOT NULL,
    chapter_run_id      UUID,

    -- drift (QA cycle 1): the DriftReport, plus its aligned flag hoisted out
    -- for cheap filtering ("show me chapters that drifted").
    aligned             BOOLEAN,
    drift_report        JSONB,

    -- craft QA (the per-dimension scores)
    craft_qa            JSONB,

    -- research + bible USAGE proof (CR-005): what was fed into the prompt
    research_used       JSONB,
    bible_entries_loaded JSONB,

    -- generation stats
    word_count          INTEGER,
    sub_chapter_count   INTEGER,
    craft_passes        INTEGER,
    cache_read_tokens   INTEGER,
    cache_write_tokens  INTEGER,
    model               TEXT,

    -- outcome
    status              TEXT NOT NULL DEFAULT 'ok'
                          CHECK (status IN ('ok', 'error')),
    error               TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project view: "telemetry for this project's chapters, newest first."
CREATE INDEX IF NOT EXISTS idx_chapter_qa_project
    ON chapter_qa_v2 (project_id, chapter_number, created_at DESC);

-- Diagnostic: "which chapters drifted?"
CREATE INDEX IF NOT EXISTS idx_chapter_qa_aligned
    ON chapter_qa_v2 (project_id, aligned);

-- RLS: a user reads telemetry for projects they own; only service role writes.
ALTER TABLE chapter_qa_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_read_own_chapter_qa ON chapter_qa_v2;
CREATE POLICY users_read_own_chapter_qa
    ON chapter_qa_v2
    FOR SELECT
    USING (
        project_id IN (
            SELECT p.id
            FROM writing_projects_v2 p
            JOIN users_v2 u ON u.user_id = p.user_id
            WHERE u.supabase_auth_uid = auth.uid()
        )
    );

DROP POLICY IF EXISTS service_role_all_chapter_qa ON chapter_qa_v2;
CREATE POLICY service_role_all_chapter_qa
    ON chapter_qa_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
