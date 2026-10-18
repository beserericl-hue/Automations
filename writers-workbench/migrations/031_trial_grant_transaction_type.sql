-- ============================================
-- Migration 031 — credit_transactions.transaction_type gains 'trial_grant'
--
-- Tier: DEV first (gvbvwcnmjkdpclcisqrr). PROD waits for the cutover.
--
-- Governance: additive. Widens one CHECK constraint on a FEATURE table.
-- `credit_transactions` is NOT one of the nine protected base tables
-- (users_v2, writing_projects_v2, published_content_v2, story_bible_v2,
-- research_reports_v2, genre_config_v2, story_arcs_v2, content_versions_v2,
-- outline_versions_v2), so scripts/check-base-table-immutability.py still
-- passes. Nothing is dropped and no existing row changes meaning.
--
-- Why
-- ---
-- I8: a user who closed the tab on the "choose your plan" step ended up with no
-- `user_subscriptions` row, which `requireCredits` read as zero credits, which
-- made EVERY chat, export and chapter request answer 402 — for an account that
-- had done nothing wrong. The tier step was the only thing that created the row,
-- and it was skippable.
--
-- `ensureTrialSubscription` now provisions the trial tier on the first
-- authenticated request that finds no subscription, and records the grant in the
-- ledger. The existing five types had no honest label for it: it is not a
-- `monthly_reset` (there was no prior month), not an `admin_adjustment` (no
-- admin did it) and certainly not a `purchase`. Recording it as any of those
-- would make the ledger lie about where a balance came from — which matters
-- precisely because the balance appears without the user asking for it.

ALTER TABLE credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_transaction_type_check;

ALTER TABLE credit_transactions
  ADD CONSTRAINT credit_transactions_transaction_type_check
  CHECK (transaction_type = ANY (ARRAY[
    'monthly_reset'::text,
    'usage'::text,
    'admin_adjustment'::text,
    'purchase'::text,
    'refund'::text,
    'trial_grant'::text
  ]));

COMMENT ON COLUMN credit_transactions.transaction_type IS
  'monthly_reset | usage | admin_adjustment | purchase | refund | trial_grant. trial_grant is the automatic trial provisioned on a first authenticated request with no subscription (see services/credits.ts ensureTrialSubscription).';
