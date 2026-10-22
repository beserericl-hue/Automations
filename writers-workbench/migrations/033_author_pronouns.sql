-- 033 — Pronouns for the author bio.
--
-- WHY. A bio is written in the third person, so it needs a pronoun for its subject in almost every
-- sentence — and nothing in the profile said which one. Given the facts of a real person's life and
-- no pronoun, the writer picked one. It happened on the first real bio this system produced: it
-- chose "he" from a profile that never said so.
--
-- That is the same failure as an invented credential, and worse in one respect: a fabricated degree
-- is wrong about what someone did, and the wrong pronoun is wrong about who they are. It would have
-- been printed on a book cover.
--
-- So the author says, once, and nothing guesses. Left empty, the writer is told to use the surname
-- rather than a pronoun — which reads perfectly well across the two to four sentences a bio runs to,
-- and is the correct answer rather than a coin toss.
--
-- author_profiles_v2 is a meta table added in 032, not one of the frozen base tables, so adding a
-- nullable column to it is in bounds. See writers-workbench/docs/schema-governance.md.

ALTER TABLE author_profiles_v2
    ADD COLUMN IF NOT EXISTS pronouns TEXT;

COMMENT ON COLUMN author_profiles_v2.pronouns IS
  'How the bio refers to this author, e.g. "she/her", "he/him", "they/them". Empty means the bio uses the surname instead of a pronoun — never a guess.';
