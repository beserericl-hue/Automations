-- 052 — The newsletter's final "Send to subscribers" gate, and a record of every email sent to the
-- owner (test copies of an issue, and the Content Studio's "Email me the week's slate").
--
-- WHY (Eric, 2026-11-03).
--   * Approving the newsletter saga's image gate rendered the issue AND mailed every active subscriber
--     in one step, so nobody saw the finished email before the readers did. The saga now saves the
--     rendered issue and opens a fourth gate, stage 'send'; nothing is delivered until it is approved.
--     Declining it is a new decision, 'reject' (the issue is kept, status 'cancelled', never sent).
--   * At that gate the owner can mail themself a test copy ("[TEST]" subject, their own users_v2.email
--     only). Each one is recorded: who, when, the Postal message id.
--   * "Email me the week's slate" (Content Studio) left no record at all. Draft emails keep theirs on
--     the post (social_schedule_v2.studio.emails, PR #265); a slate has no row of its own, so both
--     kinds of owner email go into one meta table.
--
-- WHAT.
--   newsletter_approvals_v2 (feature table, not a base table — migration 023 widened it the same way):
--     * stage CHECK gains 'send';
--     * decision CHECK gains 'reject'.
--   newsletter_owner_emails_v2 (new meta table, FKs only; no base table is altered):
--     kind 'test_copy' | 'slate', to_email, subject, postal_message_id, sent_at, edition_id, plus
--     week_of (slate) or execution_id / send_id / stage (test copy).
--
-- Idempotent. Safe on a live database: the CHECKs only widen, and the table is new.

-- ---------------------------------------------------------------------------
-- 1. The final gate's stage and the decline decision.
-- ---------------------------------------------------------------------------
ALTER TABLE newsletter_approvals_v2
  DROP CONSTRAINT IF EXISTS newsletter_approvals_v2_stage_check;
ALTER TABLE newsletter_approvals_v2
  ADD CONSTRAINT newsletter_approvals_v2_stage_check
  CHECK (stage IN ('stories', 'subject_line', 'image', 'send'));

ALTER TABLE newsletter_approvals_v2
  DROP CONSTRAINT IF EXISTS newsletter_approvals_v2_decision_check;
ALTER TABLE newsletter_approvals_v2
  ADD CONSTRAINT newsletter_approvals_v2_decision_check
  CHECK (decision IS NULL OR decision IN ('approve', 'revise', 'reject'));

-- ---------------------------------------------------------------------------
-- 2. Emails sent to the owner: test copies and slate digests.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS newsletter_owner_emails_v2 (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    edition_id         TEXT REFERENCES newsletter_editions_v2(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL CHECK (kind IN ('test_copy', 'slate')),
    to_email           TEXT NOT NULL CHECK (char_length(to_email) BETWEEN 3 AND 320),
    subject            TEXT NOT NULL,
    postal_message_id  TEXT,
    sent_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- slate: the radar week that was emailed
    week_of            DATE,
    -- test copy: the run, the saved issue and the gate it was sent from
    execution_id       TEXT,
    send_id            UUID REFERENCES newsletter_sends_v2(id) ON DELETE SET NULL,
    stage              TEXT,
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_emails_user_edition
    ON newsletter_owner_emails_v2 (user_id, edition_id, kind, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_emails_execution
    ON newsletter_owner_emails_v2 (execution_id) WHERE execution_id IS NOT NULL;

-- RLS: the owner reads their own rows; every write is the engine's, with the service role.
ALTER TABLE newsletter_owner_emails_v2 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_read ON newsletter_owner_emails_v2;
CREATE POLICY owner_read ON newsletter_owner_emails_v2 FOR SELECT USING (user_id = get_current_user_id());
DROP POLICY IF EXISTS service_role_all ON newsletter_owner_emails_v2;
CREATE POLICY service_role_all ON newsletter_owner_emails_v2 FOR ALL TO service_role
    USING (true) WITH CHECK (true);

COMMENT ON TABLE newsletter_owner_emails_v2 IS
  'Emails sent to an edition owner only: test copies of an issue at the final send gate (kind test_copy) '
  'and the Content Studio slate digest (kind slate). Who, when, which Postal message.';
