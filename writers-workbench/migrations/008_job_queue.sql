-- Sprint 10.b S10b-2: BullMQ job queue tracking table
--
-- Persists the lifecycle of every BullMQ job submitted by the server.
-- BullMQ owns the live queue state in Redis; this table is the
-- durable audit trail + source for the admin queue dashboard.
--
-- Governance note (see writers-workbench/docs/schema-governance.md):
-- This migration is numbered 008, so it must NOT ALTER / DROP / RENAME
-- any of the 9 base tables. It only creates a new meta table that
-- references users_v2 via FK on user_id. The FK is additive.

CREATE TABLE IF NOT EXISTS job_queue_v2 (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL REFERENCES users_v2(user_id),
    job_id          TEXT NOT NULL,              -- BullMQ job id (opaque)
    queue_name      TEXT NOT NULL,              -- sync-ops | medium-ops | heavy-ops | background-ops
    job_type        TEXT NOT NULL,              -- write_chapter, brainstorm_story, list_outlines, etc.
    status          TEXT NOT NULL DEFAULT 'waiting'
                      CHECK (status IN ('waiting', 'active', 'completed', 'failed', 'stalled', 'delayed')),
    priority        INTEGER NOT NULL DEFAULT 3, -- 1 (highest) .. 10 (lowest); matches BullMQ priority
    payload         JSONB,
    result          JSONB,
    error_message   TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    duration_ms     INTEGER
);

-- Per-user lookup: "what jobs does this user have running?"
CREATE INDEX IF NOT EXISTS idx_job_queue_user
    ON job_queue_v2 (user_id, status);

-- Admin dashboard: "what's currently in each queue, ordered by age?"
CREATE INDEX IF NOT EXISTS idx_job_queue_status
    ON job_queue_v2 (status, created_at);

-- Diagnostic: "which queue is congested?"
CREATE INDEX IF NOT EXISTS idx_job_queue_queue_name
    ON job_queue_v2 (queue_name, status);

-- BullMQ job_id is globally unique across all queues; dedupe inserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_job_id
    ON job_queue_v2 (job_id);

-- RLS: users can SELECT their own jobs; only service role inserts/updates
ALTER TABLE job_queue_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_read_own_jobs ON job_queue_v2;
CREATE POLICY users_read_own_jobs
    ON job_queue_v2
    FOR SELECT
    USING (
        user_id = (
            SELECT u.user_id
            FROM users_v2 u
            WHERE u.supabase_auth_uid = auth.uid()
        )
    );

DROP POLICY IF EXISTS service_role_all ON job_queue_v2;
CREATE POLICY service_role_all
    ON job_queue_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
