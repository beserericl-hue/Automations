-- 041 — Newsletter issue numbers: assigned at save time, per edition, race-safe.
--
-- WHY. newsletter_sends_v2.issue_number was added in migration 012 ("Phase 2b assigns it") but no
-- writer ever filled it in: every send on DEV had an empty issue number, the Workbench showed "—",
-- and every email printed "Issue #1" because the renderer fell back to the template's sample_data.
--
-- WHAT.
--   1. A BEFORE INSERT/UPDATE trigger assigns the next per-edition number whenever a row is saved
--      without one. It is the single authority, so every writer (engine persist step, the legacy
--      /api/newsletter-sends/save route, manual inserts) gets a number without code of its own.
--        * Race-safe: a transaction-scoped advisory lock per edition serialises assignment, and the
--          max() read inside the (VOLATILE) function takes a fresh snapshot after the lock is held,
--          so it sees the previous holder's committed number. The partial UNIQUE index below is the
--          hard backstop.
--        * One logical send per (edition_id, send_date) — the engine upserts on that key — so a row
--          for the same edition + date keeps the number already held by that date; an upsert never
--          burns a fresh number.
--        * A caller may propose a number (the engine renders "Issue #N" into the HTML before it
--          saves). The proposal is kept unless another send of the edition already holds it, in
--          which case the next free number is assigned instead and the caller re-renders.
--        * cancelled / failed rows that never had a number do not consume one; a failed send that is
--          retried gets its number when it moves back to sending/sent.
--        * Rows without an edition_id (legacy n8n sends) are left alone.
--   2. Backfill: existing rows get numbers in send order per edition (sent rows by sent_at, then any
--      unsent rows by send_date). The stored html_body of a backfilled row is corrected from the
--      sample "Issue #1" to its real number, so the archive / "view in browser" page matches.
--   3. newsletter_peek_issue_number(edition, send_date): the number a save for that date would get,
--      for the engine to render before it persists. Service role only.
--
-- Not a base table (docs/schema-governance.md): newsletter_sends_v2 came in migration 009.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------- 2. backfill (before the index)
WITH base AS (
  SELECT edition_id, COALESCE(MAX(issue_number), 0) AS top
    FROM newsletter_sends_v2
   WHERE edition_id IS NOT NULL
   GROUP BY edition_id
), todo AS (
  SELECT s.id,
         b.top + ROW_NUMBER() OVER (
           PARTITION BY s.edition_id
           ORDER BY (s.sent_at IS NULL), s.sent_at, s.send_date, s.created_at, s.id
         ) AS n
    FROM newsletter_sends_v2 s
    JOIN base b ON b.edition_id = s.edition_id
   WHERE s.issue_number IS NULL
     AND s.status NOT IN ('cancelled', 'failed')
)
UPDATE newsletter_sends_v2 s
   SET issue_number = t.n,
       -- Only the masthead line the renderer filled from sample_data ("Issue #1 &nbsp;·&nbsp; <date>").
       html_body = regexp_replace(s.html_body, 'Issue #1(\s*&nbsp;)', 'Issue #' || t.n || '\1')
  FROM todo t
 WHERE s.id = t.id;

-- ---------------------------------------------------------------- 1a. uniqueness backstop
CREATE UNIQUE INDEX IF NOT EXISTS uq_newsletter_sends_v2_edition_issue
  ON newsletter_sends_v2 (edition_id, issue_number)
  WHERE edition_id IS NOT NULL AND issue_number IS NOT NULL;

-- ---------------------------------------------------------------- 1b. assignment trigger
CREATE OR REPLACE FUNCTION newsletter_assign_issue_number()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  same_date_number integer;
BEGIN
  IF NEW.edition_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Unchanged number on an ordinary update (status flips, delivery stamps): nothing to do.
  IF TG_OP = 'UPDATE'
     AND NEW.issue_number IS NOT NULL
     AND NEW.issue_number IS NOT DISTINCT FROM OLD.issue_number
     AND NEW.edition_id IS NOT DISTINCT FROM OLD.edition_id THEN
    RETURN NEW;
  END IF;

  -- No number yet and not a live send: don't consume one.
  IF NEW.issue_number IS NULL AND NEW.status IN ('cancelled', 'failed') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('newsletter_issue:' || NEW.edition_id, 0));

  -- The same edition + date is the same logical send (the engine upserts on it): reuse its number.
  SELECT issue_number INTO same_date_number
    FROM newsletter_sends_v2
   WHERE edition_id = NEW.edition_id
     AND send_date = NEW.send_date
     AND id <> NEW.id
     AND issue_number IS NOT NULL
   LIMIT 1;
  IF same_date_number IS NOT NULL THEN
    NEW.issue_number := same_date_number;
    RETURN NEW;
  END IF;

  -- A proposed number is kept when no other send of the edition holds it.
  IF NEW.issue_number IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM newsletter_sends_v2
        WHERE edition_id = NEW.edition_id
          AND issue_number = NEW.issue_number
          AND id <> NEW.id) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(issue_number), 0) + 1 INTO NEW.issue_number
    FROM newsletter_sends_v2
   WHERE edition_id = NEW.edition_id
     AND id <> NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_sends_v2_issue_number ON newsletter_sends_v2;
CREATE TRIGGER trg_newsletter_sends_v2_issue_number
  BEFORE INSERT OR UPDATE OF issue_number, status, edition_id, send_date ON newsletter_sends_v2
  FOR EACH ROW
  EXECUTE FUNCTION newsletter_assign_issue_number();

-- ---------------------------------------------------------------- 3. peek for render-before-save
CREATE OR REPLACE FUNCTION newsletter_peek_issue_number(p_edition_id text, p_send_date date)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT issue_number FROM newsletter_sends_v2
      WHERE edition_id = p_edition_id AND send_date = p_send_date AND issue_number IS NOT NULL
      LIMIT 1),
    (SELECT COALESCE(MAX(issue_number), 0) + 1 FROM newsletter_sends_v2
      WHERE edition_id = p_edition_id)
  );
$$;

REVOKE ALL ON FUNCTION newsletter_peek_issue_number(text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION newsletter_peek_issue_number(text, date) TO service_role;
