-- 024_newsletter_sends_edition_date_unique.sql
-- F2 (engine newsletter saga): give persist-svc a usable ON CONFLICT target.
--
-- The engine's persist step upserts newsletter_sends_v2 with
--   on_conflict = (edition_id, send_date)
-- so that re-running a saga for the same edition + day is idempotent (one row per
-- edition per send date, updated in place). The existing unique indexes are
--   (user_id, send_date) WHERE status != 'cancelled'   -- partial, can't be inferred by upsert
--   (edition_id, issue_number)                          -- issue_number, not send_date
-- neither of which Postgres can match against the (edition_id, send_date) conflict
-- target — the upsert fails with 42P10 "no unique or exclusion constraint matching
-- the ON CONFLICT specification".
--
-- Add a NON-partial unique index on (edition_id, send_date). edition_id is nullable;
-- NULLs are distinct in a unique index, so legacy rows with a NULL edition_id never
-- collide. The engine always sets edition_id, so its writes get clean idempotency.
--
-- newsletter_sends_v2 is NOT one of the frozen base tables (schema-governance.md), so
-- adding an index here is permitted. This change is additive and non-destructive.

CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_sends_v2_edition_date_unique
  ON newsletter_sends_v2 (edition_id, send_date);
