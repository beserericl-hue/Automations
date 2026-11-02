-- 042 — Record the humanizer's outcome on radar-drafted calendar posts.
--
-- WHY. The Trend / Dev radars draft blog + LinkedIn posts straight onto the post calendar
-- (social_schedule_v2), and those drafts now go through the StealthGPT humanize pass like every
-- other non-fiction surface (writer_engine.radar.drafts.humanize_drafts). Whether it was applied —
-- or ran and kept the original because every rewrite was rejected — has to be visible somewhere;
-- the calendar row had no column for it.
--
-- WHAT. One nullable JSONB column: NULL = the pass did not run (manual post, humanizer off, no key);
-- otherwise {"applied": bool, "body_md": {...report}, "linkedin_content": {...report}}.
--
-- social_schedule_v2 is not a base table (migration 038; docs/schema-governance.md). Additive and
-- idempotent.

ALTER TABLE social_schedule_v2
  ADD COLUMN IF NOT EXISTS humanize JSONB;
