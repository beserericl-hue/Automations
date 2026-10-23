-- 034 — Real photographs in the project's image archive.
--
-- WHY. Every image this system has stored until now was invented by a model: cover art, chapter
-- art, social images. A book built on documented history also needs the other kind — photographs
-- that were actually taken, of actual people and places, held by an institution that can be named.
-- For The Ossuary that means the Smithsonian's photo lots of Turkey Tayac, the Ferguson excavation
-- records, the 2012 recognition ceremony.
--
-- Those belong in the SAME archive as the rest of the project's images, not in a silo beside it:
-- the author thinks "the pictures for this book", not "the generated pictures and, separately, the
-- real ones". So this adds a type to the existing table rather than a new table.
--
-- The distinction that does matter is kept in the type itself. `reference_photo` is never a thing
-- the system made up, and its `metadata` carries the provenance that makes it usable: the holding
-- institution, the catalogue reference, the photographer, the licence and the record URL. An image
-- without those is not evidence of anything.
--
-- Only openly licensed photographs are stored. `storage_path` is NOT NULL here, so saving a row
-- means holding a copy, and holding a copy of something whose rights are unclear is the author's
-- risk to take knowingly rather than one this system takes for them. Rights-unclear results stay
-- as citations with a link to the catalogue.
--
-- generated_images_v2 is not one of the frozen base tables (see docs/schema-governance.md), so
-- widening its CHECK is in bounds.

ALTER TABLE generated_images_v2
    DROP CONSTRAINT IF EXISTS generated_images_v2_image_type_check;

ALTER TABLE generated_images_v2
    ADD CONSTRAINT generated_images_v2_image_type_check
    CHECK (image_type = ANY (ARRAY[
        'cover_art',
        'chapter_art',
        'social_media',
        'newsletter_section',
        'reference_photo'
    ]));

COMMENT ON COLUMN generated_images_v2.image_type IS
  'cover_art / chapter_art / social_media / newsletter_section are generated. reference_photo is NOT: it is a real photograph retrieved from a named archive, and its metadata carries institution, collection_ref, creator, license and source_page_url.';
