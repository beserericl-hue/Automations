-- 059 — The audiobook as ONE file: an .m4b with a chapter for every recording, the cover and the title
-- built in, for a player that imports a single audiobook file from a link (BookPlayer).
--
-- WHY. The per-chapter MP3s are the retail deliverable, but a listening app treats each separate MP3 as
-- its own book. One .m4b holds the whole book with a chapter list. It is built by an engine job from the
-- finished recordings and stored next to them, so it survives a page reload and is the same file every
-- time the author asks for a link.
--
-- audiobooks_v2 is the audiobook feature's own table (056), not a base table, so adding columns here is
-- within docs/schema-governance.md. `export_hash` is the fingerprint of the recordings the file was made
-- from: when any recording is re-narrated the fingerprint no longer matches and the screen says the file
-- is out of date. Idempotent.

BEGIN;

ALTER TABLE audiobooks_v2
    ADD COLUMN IF NOT EXISTS export_status      TEXT CHECK (export_status IN ('queued', 'building', 'ready', 'failed')),
    ADD COLUMN IF NOT EXISTS export_error       TEXT,
    ADD COLUMN IF NOT EXISTS export_path        TEXT,
    ADD COLUMN IF NOT EXISTS export_bytes       BIGINT,
    ADD COLUMN IF NOT EXISTS export_duration_s  NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS export_chapters    INTEGER,
    ADD COLUMN IF NOT EXISTS export_quality     TEXT,
    ADD COLUMN IF NOT EXISTS export_hash        TEXT,
    ADD COLUMN IF NOT EXISTS export_updated_at  TIMESTAMPTZ;

COMMENT ON COLUMN audiobooks_v2.export_path IS
  'Storage path (bucket audiobooks) of the single .m4b built from the finished recordings, or NULL.';

COMMIT;
