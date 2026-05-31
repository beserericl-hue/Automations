-- Migration 023: engine approval-mirror compatibility (F2-7)
--
-- The Python Writer Engine's HITL gates live in Redis, but
-- writer_engine.state_machine.hitl mirrors each gate into
-- newsletter_approvals_v2 so the existing Workbench UI approval routes
-- (GET /api/newsletter/approvals/open, POST .../resolve) can read and
-- resolve engine-backed sagas with no new UI surface.
--
-- Two things block that mirror today:
--   1. The `stage` CHECK only allows ('stories','subject_line'). The
--      engine adds a THIRD gate — image approval — that the n8n path
--      never had. Add 'image'.
--   2. `resume_url` is NOT NULL — it stored the n8n Wait-node resume URL.
--      Engine rows have no n8n resume URL (the Workbench resolve route
--      POSTs to the engine's own /internal/newsletter/approvals/{token}/
--      resolve instead), so the column must be nullable for engine rows.
--      n8n rows still always supply it (routes/approvals.ts requires it).
--
-- NOT a base table (see CLAUDE.md base-table immutability) —
-- newsletter_approvals_v2 is a newsletter feature table, free to evolve
-- via numbered migrations.
--
-- Idempotent: safe to re-run.

-- 1. Expand the stage vocabulary to include the engine's image gate.
ALTER TABLE newsletter_approvals_v2
  DROP CONSTRAINT IF EXISTS newsletter_approvals_v2_stage_check;

ALTER TABLE newsletter_approvals_v2
  ADD CONSTRAINT newsletter_approvals_v2_stage_check
  CHECK (stage IN ('stories', 'subject_line', 'image'));

-- 2. resume_url is n8n-only — engine rows omit it.
ALTER TABLE newsletter_approvals_v2
  ALTER COLUMN resume_url DROP NOT NULL;
