-- 051 — One saved newsletter per EDITION per day, not one per USER per day.
--
-- WHY. Migration 009 (one newsletter per user, before editions) added
--   idx_newsletter_sends_v2_user_date_unique ON (user_id, send_date) WHERE status != 'cancelled'.
-- Editions came later, and 024 added the rule the engine actually relies on: one row per
-- (edition_id, send_date), the persist step's ON CONFLICT target. The old per-user index stayed, so a
-- user with two editions can save only ONE of them on any day: the second save fails with 23505.
-- Found on DEV 2026-11-03: the owner's wasteland-wire issue had gone out that morning, so a Content
-- Studio issue for another of his editions (e2e-studio-lv3, run 332ae413) could not be saved — and,
-- because the saga did not check the save (fixed with this migration), it was delivered anyway with no
-- archive row. The two studio editions (ai-mvp, ai-dev-roundup) are weekly and would collide whenever
-- they run on the same day as each other or as any other edition of the same owner.
--
-- WHAT.
--   * drop the per-user index;
--   * keep its guarantee for the rows it was written for — the n8n-era POST /api/newsletter-sends/save
--     path, which writes no edition_id and finds "today's row" by (user_id, send_date) — as a partial
--     index on rows WITHOUT an edition. Edition rows are covered by 024's (edition_id, send_date).
--
-- newsletter_sends_v2 is not a base table (docs/schema-governance.md); indexes only, no data change.
-- Idempotent. Safe to apply: no two non-cancelled edition-less rows can share (user_id, send_date)
-- today, because the index being replaced forbade it.

CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_sends_v2_user_date_no_edition_unique
    ON newsletter_sends_v2 (user_id, send_date)
    WHERE status != 'cancelled' AND edition_id IS NULL;

DROP INDEX IF EXISTS idx_newsletter_sends_v2_user_date_unique;
