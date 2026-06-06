-- Migration 026: link research reports to projects (CR-006)
--
-- Standing bug: research_reports_v2 has no project_id, so the UI research tab
-- shows EVERY project's research mixed together. research_reports_v2 is a base
-- table (immutable — CLAUDE.md / schema-governance), so we cannot add a column
-- to it. Instead a meta table maps report -> project (the governance pattern for
-- new per-feature attributes). The UI research tab joins this and filters by the
-- current project_id; the engine writes the link when it persists write-time
-- research; a one-time backfill links existing reports via their topic prefix.
--
-- Governance note: numbered 026 — does NOT ALTER/DROP/RENAME any base table; it
-- only CREATEs a meta table with additive FKs to research_reports_v2,
-- writing_projects_v2, and users_v2.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS research_report_projects_v2 (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id   UUID NOT NULL REFERENCES research_reports_v2(id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- one project per report (a report belongs to a single project); re-linking updates the row.
    UNIQUE (report_id)
);

-- UI research tab: "research for this project."
CREATE INDEX IF NOT EXISTS idx_rrp_project ON research_report_projects_v2 (project_id);

-- RLS: a user reads links for projects they own; only service role writes.
ALTER TABLE research_report_projects_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_read_own_research_links ON research_report_projects_v2;
CREATE POLICY users_read_own_research_links
    ON research_report_projects_v2
    FOR SELECT
    USING (
        project_id IN (
            SELECT p.id
            FROM writing_projects_v2 p
            JOIN users_v2 u ON u.user_id = p.user_id
            WHERE u.supabase_auth_uid = auth.uid()
        )
    );

DROP POLICY IF EXISTS service_role_all_research_links ON research_report_projects_v2;
CREATE POLICY service_role_all_research_links
    ON research_report_projects_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
