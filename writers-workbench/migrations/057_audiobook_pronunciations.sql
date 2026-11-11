-- 057 — Audiobook pronunciation guides.
--
-- WHY. A speech voice guesses at names ("Siobhan", "Harrow Vale", an invented place) and gets some
-- wrong. The author's fix is a list per book: the word as written -> how it sounds, spelled out in
-- plain letters ("Siobhan" -> "Shivawn"). The engine swaps the respelling in for the narration only;
-- the manuscript is never touched.
--
-- audiobooks_v2 is the audiobook feature's own table (migration 056), not a base table, so adding a
-- column here is within docs/schema-governance.md. Stored as JSON: a list of {word, say}, small and
-- always read and written whole with the rest of the narrator settings. Idempotent.

BEGIN;

ALTER TABLE audiobooks_v2
    ADD COLUMN IF NOT EXISTS pronunciations JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN audiobooks_v2.pronunciations IS
  'The author''s pronunciation guide for this book: [{"word": "Siobhan", "say": "Shivawn"}]. Applied to the narration text only.';

COMMIT;
