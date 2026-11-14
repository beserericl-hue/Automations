-- 061 — The author's own wording for the spoken narrator credit.
--
-- WHY. The opening credit is built by the server: "Narrated by <the author's voice name>" for their own
-- ElevenLabs clone (060), otherwise "Narrated by an A.I. voice". Some authors do not want that sentence at
-- all, or want their own words ("Read in the author's own voice"). The author chooses, per book:
--   auto    — the automatic wording above (the default, and what every existing book keeps)
--   custom  — their own sentence, spoken exactly as written
--   none    — no narrator sentence; only the title and author are spoken
-- Only the opening recording is affected: chapter recordings are identified by their own words, voice and
-- delivery, so changing the credit re-records nothing else.
--
-- audiobooks_v2 is the audiobook feature's own table (056), not a base table. Idempotent.

BEGIN;

ALTER TABLE audiobooks_v2
    ADD COLUMN IF NOT EXISTS narrator_credit_mode TEXT NOT NULL DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS narrator_credit TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audiobooks_v2_narrator_credit_mode_chk') THEN
        ALTER TABLE audiobooks_v2
            ADD CONSTRAINT audiobooks_v2_narrator_credit_mode_chk CHECK (narrator_credit_mode IN ('auto', 'custom', 'none'));
    END IF;
END $$;

COMMENT ON COLUMN audiobooks_v2.narrator_credit_mode IS
  'How the opening credit names the narrator: auto (voice name or an A.I. voice), custom (narrator_credit, spoken as written), none (not spoken).';
COMMENT ON COLUMN audiobooks_v2.narrator_credit IS
  'The author''s own narrator credit sentence, spoken when narrator_credit_mode = custom.';

COMMIT;
