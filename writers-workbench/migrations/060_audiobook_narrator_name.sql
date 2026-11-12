-- 060 — The narrator's name for the spoken credits.
--
-- WHY. The opening credit said "Narrated by an A.I. voice" for every book. When the author narrates in
-- their OWN ElevenLabs voice (a clone of themselves) that is untrue and unwanted: it is their voice, and
-- the credit should name them. The server looks the voice up in the author's own ElevenLabs account when
-- they save the narrator and keeps the voice's name here, only for a voice the author made (cloned or
-- professional). NULL/empty means "say it is an A.I. voice" (the built-in voices, and ElevenLabs library
-- voices that are not the author's own).
--
-- audiobooks_v2 is the audiobook feature's own table (056), not a base table. Idempotent.

BEGIN;

ALTER TABLE audiobooks_v2
    ADD COLUMN IF NOT EXISTS narrator_name TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN audiobooks_v2.narrator_name IS
  'Name of the author''s own ElevenLabs voice, spoken as "Narrated by <name>". Empty = an A.I. voice.';

COMMIT;
