-- Migration 028: the engine run ledger (B6 — idempotency)
--
-- THE PROBLEM. An async write job can run more than once for a single user
-- request. arq re-queues a job on CancelledError, which is what a worker
-- restart, a Railway deploy or a SIGTERM mid-chapter produces; the Workbench
-- also retries a failed POST. Of the engine's persist paths, only some survive
-- that:
--
--   persist_chapter    upserts on (project_id, chapter_number)   -> idempotent
--   persist_canon      select-then-update on (project, name)     -> idempotent
--   persist_bible      select-then-update on (project,type,name) -> idempotent
--   persist_outline    updates the project row                   -> idempotent
--                      (+ one extra outline_versions_v2 snapshot per run)
--   persist_content    plain INSERT                              -> DUPLICATES
--   persist_research   plain INSERT                              -> DUPLICATES
--   persist_token_usage plain INSERT per LLM call                -> DUPLICATES
--                       (this one is BILLING data, so a duplicate
--                        over-reports what the user owes)
--   persist_chapter_qa  plain INSERT per run                     -> DUPLICATES
--
-- Patching each of those separately needs a per-table dedupe key, and two of
-- the tables involved are immutable base tables that cannot gain one. So the
-- key lives here instead: one ledger row per run, claimed before the work
-- starts. A job whose run_id is already recorded `complete` does not run
-- again at all — which also stops the duplicated LLM spend, not just the
-- duplicated rows.
--
-- WHAT run_id IS. The arq job_id by default, so a retry of the same job shares
-- it; a caller may pass its own `run_id` in the request body to make a
-- user-level submission idempotent too. Two separate clicks produce two job
-- ids and therefore two runs, deliberately: re-running a blog post on purpose
-- must stay possible.
--
-- status transitions:
--   (none)      -> in_progress     a fresh claim; this worker owns the run
--   in_progress -> complete        the step returned; result ref recorded
--   in_progress -> error           the step raised; a retry may claim again
--   in_progress -> in_progress     a crash retry: the previous owner died
--                                  mid-run, so re-running is correct (the
--                                  idempotent persist paths absorb it)
--   complete    -> (short circuit) the job returns the recorded result
--
-- Governance note (writers-workbench/docs/schema-governance.md):
-- Numbered 028, so it must NOT ALTER / DROP / RENAME any of the 9 base tables.
-- It only CREATEs a new meta table. user_id and project_id are deliberately
-- plain TEXT with NO foreign keys: claiming a run must never fail because a
-- users_v2 row is missing or because the project is created later in the same
-- run (brainstorm.create-project does exactly that). The ledger is a control
-- record, not a content record.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS engine_job_runs (
    run_id           TEXT PRIMARY KEY,

    tool             TEXT NOT NULL,
    op               TEXT NOT NULL DEFAULT '',
    queue            TEXT NOT NULL DEFAULT '',

    -- Attribution only; see the governance note above for why these are FK-free.
    user_id          TEXT,
    project_id       TEXT,
    chapter_number   INTEGER,

    status           TEXT NOT NULL DEFAULT 'in_progress'
                       CHECK (status IN ('in_progress', 'complete', 'error')),

    -- The step's own output, replayed verbatim when a completed run is claimed
    -- again. NULL with result_truncated = true when the output was too large to
    -- keep here (a chapter write's prose lives in published_content_v2 anyway).
    result           JSONB,
    result_truncated BOOLEAN NOT NULL DEFAULT false,

    error            TEXT,
    attempts         INTEGER NOT NULL DEFAULT 1,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "what has this user run lately" (support, and the load test's accounting).
CREATE INDEX IF NOT EXISTS idx_engine_job_runs_user
    ON engine_job_runs (user_id, created_at DESC);

-- "what is still in flight / what failed" — the operational view.
CREATE INDEX IF NOT EXISTS idx_engine_job_runs_status
    ON engine_job_runs (status, created_at DESC);

ALTER TABLE engine_job_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_read_own_engine_job_runs ON engine_job_runs;
CREATE POLICY users_read_own_engine_job_runs
    ON engine_job_runs
    FOR SELECT
    USING (
        user_id IN (
            SELECT u.user_id FROM users_v2 u WHERE u.supabase_auth_uid = auth.uid()
        )
    );

DROP POLICY IF EXISTS service_role_all_engine_job_runs ON engine_job_runs;
CREATE POLICY service_role_all_engine_job_runs
    ON engine_job_runs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
