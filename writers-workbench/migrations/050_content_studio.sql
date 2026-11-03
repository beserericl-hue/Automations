-- 050 — The Content Studio: review drafts before they are scheduled, choose the newsletter's posts,
-- and publish the per-edition RSS feeds (port of the n8n studio chat agents).
--
-- WHY. Two n8n chat agents ("Content - AI & MVP Content Studio (Workflow B)" fTRYiQOaQgdAmu7w and
-- "Content - AI Dev Roundup (Social Studio)" y0vIznzMeiGoxouX) let the owner pick topics from the week's
-- radar slate, draft them, review and revise, then publish / schedule; a weekly digest email and two
-- RSS feeds (Substack sync) came from the same data. The Workbench port (migration 038) only had
-- "schedule the week", which drafts AND schedules in one step: there was no review stage, nothing
-- recorded which posts belong to which newsletter edition, and the newsletter picked its stories by
-- LLM with no way to say "these six, in this order".
--
-- WHAT.
--   social_schedule_v2 (meta table, migration 038 — not a base table):
--     * two pre-calendar states: `draft` (generated, in review) and `approved` (reviewed, not yet on
--       the calendar). Neither has a day or a slot, so scheduled_date / scheduled_at become nullable
--       for those two states only (a CHECK keeps every other state dated). The publisher only ever
--       claims `pending`, and the calendar reads by date, so neither can be posted or shown by accident.
--     * edition_id: the newsletter edition a post was made for (the RSS feeds and the studio filter on it).
--     * post_at: an exact posting time ("publish now", "Tuesday 11:30"); NULL = the slot's 09:00 / 14:00 ET.
--     * image_url: an image chosen for the post instead of the generated sketchnote.
--     * studio: bookkeeping (revision history, which topic it was drafted from).
--     * source `studio`.
--   newsletter_issue_selections_v2 / newsletter_issue_items_v2: the posts and slate topics chosen for an
--     edition's next issue, in order. While one is `open`, the newsletter saga uses exactly these
--     stories instead of the LLM pick, and locks the selection to that run.
--   newsletter_edition_feeds_v2: the unguessable token behind an edition's public RSS feeds.
--
-- All new tables are meta tables with FKs; no base table is touched (docs/schema-governance.md).
-- Idempotent.

-- ---------------------------------------------------------------------------
-- social_schedule_v2: drafts and approved posts live in the same table as the calendar.
-- ---------------------------------------------------------------------------
ALTER TABLE social_schedule_v2 DROP CONSTRAINT IF EXISTS social_schedule_v2_state_check;
ALTER TABLE social_schedule_v2 ADD CONSTRAINT social_schedule_v2_state_check
    CHECK (state IN ('draft', 'approved', 'pending', 'posting', 'posted', 'partial', 'failed', 'cancelled'));

ALTER TABLE social_schedule_v2 DROP CONSTRAINT IF EXISTS social_schedule_v2_source_check;
ALTER TABLE social_schedule_v2 ADD CONSTRAINT social_schedule_v2_source_check
    CHECK (source IN ('manual', 'trend_batch', 'roundup_batch', 'n8n_import', 'studio'));

ALTER TABLE social_schedule_v2 ALTER COLUMN scheduled_date DROP NOT NULL;
ALTER TABLE social_schedule_v2 ALTER COLUMN scheduled_at DROP NOT NULL;

ALTER TABLE social_schedule_v2 DROP CONSTRAINT IF EXISTS social_schedule_v2_dated_check;
ALTER TABLE social_schedule_v2 ADD CONSTRAINT social_schedule_v2_dated_check
    CHECK (state IN ('draft', 'approved') OR (scheduled_date IS NOT NULL AND scheduled_at IS NOT NULL));

ALTER TABLE social_schedule_v2
    ADD COLUMN IF NOT EXISTS edition_id TEXT REFERENCES newsletter_editions_v2(id) ON DELETE SET NULL;
ALTER TABLE social_schedule_v2 ADD COLUMN IF NOT EXISTS post_at TIMESTAMPTZ;
ALTER TABLE social_schedule_v2 ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE social_schedule_v2 ADD COLUMN IF NOT EXISTS studio JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE social_schedule_v2 DROP CONSTRAINT IF EXISTS social_schedule_v2_image_url_check;
ALTER TABLE social_schedule_v2 ADD CONSTRAINT social_schedule_v2_image_url_check
    CHECK (image_url IS NULL OR (image_url ~ '^https://' AND char_length(image_url) <= 2000));

CREATE INDEX IF NOT EXISTS idx_social_schedule_edition
    ON social_schedule_v2 (user_id, edition_id, state);

-- The posting time: post_at when set (and then the day + slot follow it), otherwise the slot hour on
-- scheduled_date in US Eastern. Undated drafts carry no time. Numbering is unchanged from 038.
CREATE OR REPLACE FUNCTION social_schedule_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE local_ts TIMESTAMP;
BEGIN
    IF NEW.post_at IS NOT NULL THEN
        local_ts := NEW.post_at AT TIME ZONE 'America/New_York';
        NEW.scheduled_date := local_ts::date;
        NEW.slot := CASE WHEN local_ts::time >= time '12:00' THEN 'afternoon' ELSE 'morning' END;
        NEW.scheduled_at := NEW.post_at;
    ELSIF NEW.scheduled_date IS NOT NULL THEN
        NEW.scheduled_at := ((NEW.scheduled_date
            + (CASE WHEN NEW.slot = 'afternoon' THEN time '14:00' ELSE time '09:00' END))
            AT TIME ZONE 'America/New_York');
    ELSE
        NEW.scheduled_at := NULL;
    END IF;
    IF TG_OP = 'INSERT' AND COALESCE(NEW.display_number, 0) <= 0 THEN
        PERFORM pg_advisory_xact_lock(hashtext('social_schedule_v2:' || NEW.user_id));
        SELECT COALESCE(MAX(display_number), 0) + 1 INTO NEW.display_number
          FROM social_schedule_v2 WHERE user_id = NEW.user_id;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- Posts made before this migration: tie them to the edition their radar feeds, so the RSS feeds and
-- the studio see them. (Batch posts carry their source; the radar -> edition map is the subscription.)
UPDATE social_schedule_v2 s
   SET edition_id = sub.settings->>'edition_id'
  FROM radar_subscriptions_v2 sub
 WHERE s.edition_id IS NULL
   AND sub.user_id = s.user_id
   AND sub.radar = CASE s.source WHEN 'trend_batch' THEN 'trend' WHEN 'roundup_batch' THEN 'dev' END
   AND sub.settings->>'edition_id' IS NOT NULL
   AND EXISTS (SELECT 1 FROM newsletter_editions_v2 e WHERE e.id = sub.settings->>'edition_id');

-- ---------------------------------------------------------------------------
-- The next issue's stories, chosen in the studio.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS newsletter_issue_selections_v2 (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    edition_id    TEXT NOT NULL REFERENCES newsletter_editions_v2(id) ON DELETE CASCADE,
    -- open:      being chosen; the next newsletter run for the edition uses it.
    -- locked:    a newsletter run took it (execution_id, send_date); kept as the record of that issue.
    -- abandoned: replaced by a newer selection without being used.
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'abandoned')),
    execution_id  TEXT,
    send_date     DATE,
    locked_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one open selection per edition.
CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_selection_open
    ON newsletter_issue_selections_v2 (edition_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_issue_selection_user
    ON newsletter_issue_selections_v2 (user_id, edition_id, created_at DESC);

CREATE TABLE IF NOT EXISTS newsletter_issue_items_v2 (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    selection_id    UUID NOT NULL REFERENCES newsletter_issue_selections_v2(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL CHECK (position BETWEEN 1 AND 50),
    kind            TEXT NOT NULL CHECK (kind IN ('post', 'topic')),
    schedule_id     UUID REFERENCES social_schedule_v2(id) ON DELETE CASCADE,
    radar_topic_id  UUID REFERENCES radar_topics_v2(id) ON DELETE CASCADE,
    -- The content_ingestion_v2 row the newsletter run wrote for this item (set when it is locked).
    ingestion_key   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind = 'post' AND schedule_id IS NOT NULL AND radar_topic_id IS NULL)
        OR (kind = 'topic' AND radar_topic_id IS NOT NULL AND schedule_id IS NULL)),
    UNIQUE (selection_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_item_post
    ON newsletter_issue_items_v2 (selection_id, schedule_id) WHERE schedule_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_item_topic
    ON newsletter_issue_items_v2 (selection_id, radar_topic_id) WHERE radar_topic_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Public RSS feeds per edition (Substack sync). The token is the only secret in the URL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS newsletter_edition_feeds_v2 (
    edition_id  TEXT PRIMARY KEY REFERENCES newsletter_editions_v2(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{24,64}$'),
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- updated_at + RLS: only the owner reads their rows (no admin read: a studio edition is private to its
-- owner); every write goes through the server or the engine with the service role.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_issue_selections_touch ON newsletter_issue_selections_v2;
CREATE TRIGGER trg_issue_selections_touch BEFORE UPDATE ON newsletter_issue_selections_v2
    FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();
DROP TRIGGER IF EXISTS trg_edition_feeds_touch ON newsletter_edition_feeds_v2;
CREATE TRIGGER trg_edition_feeds_touch BEFORE UPDATE ON newsletter_edition_feeds_v2
    FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['newsletter_issue_selections_v2', 'newsletter_edition_feeds_v2'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS owner_read ON %I', t);
        EXECUTE format('CREATE POLICY owner_read ON %I FOR SELECT USING (user_id = get_current_user_id())', t);
        EXECUTE format('DROP POLICY IF EXISTS service_role_all ON %I', t);
        EXECUTE format('CREATE POLICY service_role_all ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
    END LOOP;
END $$;

ALTER TABLE newsletter_issue_items_v2 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_read ON newsletter_issue_items_v2;
CREATE POLICY owner_read ON newsletter_issue_items_v2 FOR SELECT USING (
    selection_id IN (SELECT s.id FROM newsletter_issue_selections_v2 s
                      WHERE s.user_id = get_current_user_id()));
DROP POLICY IF EXISTS service_role_all ON newsletter_issue_items_v2;
CREATE POLICY service_role_all ON newsletter_issue_items_v2 FOR ALL TO service_role
    USING (true) WITH CHECK (true);

COMMENT ON TABLE newsletter_issue_selections_v2 IS
  'Content Studio: the posts / radar topics chosen for an edition''s next issue. An open selection is '
  'authoritative: the newsletter saga uses exactly its items, in order, instead of the LLM story pick.';
COMMENT ON TABLE newsletter_edition_feeds_v2 IS
  'Content Studio: the token in an edition''s public RSS URLs (/feeds/<token>/items.xml and /digest.xml).';
