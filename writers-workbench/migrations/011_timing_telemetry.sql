-- Sprint 12 S12-5: timing telemetry for performance dashboard.
--
-- Adds end-to-end, queue-wait, and LLM-time columns to token_usage_v2 so
-- the admin Performance dashboard can surface chapter generation latency,
-- queue backpressure, and LLM time share.
--
-- Governance note (see writers-workbench/docs/schema-governance.md):
-- migration 011 — additive only. token_usage_v2 is a meta table (not one
-- of the 9 frozen base tables), so ADD COLUMN IF NOT EXISTS is permitted.
-- No ALTER/DROP/RENAME of base tables.

ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS execution_time_ms INTEGER;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS queue_wait_ms     INTEGER;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS llm_time_ms       INTEGER;

-- Performance dashboard "recent runs" view — filter by workflow & time window.
CREATE INDEX IF NOT EXISTS idx_token_usage_v2_workflow_date
    ON token_usage_v2 (workflow_name, created_at DESC);

-- Filter rows with timing recorded (most rows predate S12-5 and will be NULL).
CREATE INDEX IF NOT EXISTS idx_token_usage_v2_timing
    ON token_usage_v2 (created_at DESC)
    WHERE execution_time_ms IS NOT NULL;
