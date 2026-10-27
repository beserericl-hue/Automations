-- 038 — The post calendar, the radars, and the two editions they feed (port of the n8n blog system).
--
-- WHY. Two n8n systems write blog and LinkedIn posts and post them on a calendar: the TechAhir
-- "AI & MVP" blog (Trend Radar -> Content Studio / Batch Week) and the "AI Dev Roundup" LinkedIn
-- link posts (Dev Radar -> Social Studio). Both queue into an n8n data table (`scheduled_blogs`)
-- that a twice-daily n8n cron drains to the TechAhir website and to LinkedIn through Blotato.
-- None of it lived in the Workbench, so turning n8n off would have stopped every post.
--
-- What the n8n queue could not do, and these tables can:
--   * a status per channel (n8n stored one free-text string, and called a row `posted` if ANY
--     channel worked);
--   * a retry of only the channel that failed, without re-posting the ones that worked
--     (one delivery row per post per channel, unique);
--   * no double post when two publisher ticks overlap (a row is claimed by moving it to
--     `posting`, and only the tick whose UPDATE matched `pending` posts it);
--   * a race-free "#N" post number (n8n used max+1 with no lock).
--
-- New meta tables with FKs into users_v2, plus a widened CHECK on newsletter_feed_sources_v2
-- (not a base table). In bounds under docs/schema-governance.md.

-- ---------------------------------------------------------------------------
-- Channels a user can post to. Endpoints and page ids live here; API keys never do (they are
-- Railway variables on the engine).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_channels_v2 (
    user_id     TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    channel     TEXT NOT NULL CHECK (channel ~ '^[a-z0-9_]{2,40}$'),
    kind        TEXT NOT NULL CHECK (kind IN ('website', 'linkedin')),
    label       TEXT NOT NULL,
    -- website:  {"endpoint": "https://www.techahir.com/api/blog", "public_base": "https://www.techahir.com/blog/", "author": "Tech Ahir"}
    -- linkedin: {"account_id": "9115", "page_id": "104364682"}   (no page_id = the personal profile)
    config      JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel)
);

-- ---------------------------------------------------------------------------
-- The queue: one row per post.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_schedule_v2 (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    -- "#N" in the UI and in chat ("edit 12"). Assigned by trg_social_schedule_number, per user.
    display_number    INTEGER NOT NULL DEFAULT 0,
    -- Stable id of the post. The website API de-duplicates on it, so it must not change once a
    -- post has gone out. Kept from n8n for imported rows (sched-*, batch-*, roundup-*).
    external_id       TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
    title             TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
    body_md           TEXT NOT NULL DEFAULT '',
    linkedin_content  TEXT NOT NULL DEFAULT '',
    seo_title         TEXT NOT NULL DEFAULT '',
    meta_description  TEXT NOT NULL DEFAULT '',
    category          TEXT NOT NULL DEFAULT 'INSIGHTS',
    include_image     BOOLEAN NOT NULL DEFAULT false,
    post_status       TEXT NOT NULL DEFAULT 'published' CHECK (post_status IN ('published', 'draft')),
    channels          TEXT[] NOT NULL CHECK (cardinality(channels) >= 1),
    -- The Eastern calendar day and slot, as people schedule them; scheduled_at is derived.
    scheduled_date    DATE NOT NULL,
    slot              TEXT NOT NULL DEFAULT 'morning' CHECK (slot IN ('morning', 'afternoon')),
    scheduled_at      TIMESTAMPTZ NOT NULL,
    state             TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'posting', 'posted', 'partial', 'failed', 'cancelled')),
    attempts          INTEGER NOT NULL DEFAULT 0,
    claimed_at        TIMESTAMPTZ,
    posted_at         TIMESTAMPTZ,
    last_error        TEXT,
    source            TEXT NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual', 'trend_batch', 'roundup_batch', 'n8n_import')),
    item_type         TEXT NOT NULL DEFAULT 'article' CHECK (item_type IN ('article', 'video', 'blog')),
    source_url        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_social_schedule_number
    ON social_schedule_v2 (user_id, display_number);
CREATE INDEX IF NOT EXISTS idx_social_schedule_due
    ON social_schedule_v2 (scheduled_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_social_schedule_calendar
    ON social_schedule_v2 (user_id, scheduled_date);

-- scheduled_at = the slot hour on scheduled_date in US Eastern (09:00 morning, 14:00 afternoon),
-- and display_number = the user's next number. A trigger because AT TIME ZONE is not immutable,
-- so it cannot be a generated column; the advisory lock makes concurrent inserts take turns.
CREATE OR REPLACE FUNCTION social_schedule_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.scheduled_at := ((NEW.scheduled_date
        + (CASE WHEN NEW.slot = 'afternoon' THEN time '14:00' ELSE time '09:00' END))
        AT TIME ZONE 'America/New_York');
    IF TG_OP = 'INSERT' AND COALESCE(NEW.display_number, 0) <= 0 THEN
        PERFORM pg_advisory_xact_lock(hashtext('social_schedule_v2:' || NEW.user_id));
        SELECT COALESCE(MAX(display_number), 0) + 1 INTO NEW.display_number
          FROM social_schedule_v2 WHERE user_id = NEW.user_id;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_social_schedule_number ON social_schedule_v2;
CREATE TRIGGER trg_social_schedule_number
    BEFORE INSERT OR UPDATE ON social_schedule_v2
    FOR EACH ROW EXECUTE FUNCTION social_schedule_before_write();

-- ---------------------------------------------------------------------------
-- One row per post per channel: what was sent and what came back.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_schedule_deliveries_v2 (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id   UUID NOT NULL REFERENCES social_schedule_v2(id) ON DELETE CASCADE,
    channel       TEXT NOT NULL,
    -- submitted: Blotato accepted it, the result is not known yet (checked on a later tick).
    -- dry_run:   SOCIAL_POSTING_MODE was not 'live', so nothing was sent; `request` is what would have been.
    status        TEXT NOT NULL CHECK (status IN ('submitted', 'published', 'failed', 'dry_run')),
    attempts      INTEGER NOT NULL DEFAULT 1,
    provider_ref  TEXT,
    public_url    TEXT,
    detail        TEXT,
    request       JSONB,
    response      JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_social_deliveries_submitted
    ON social_schedule_deliveries_v2 (updated_at) WHERE status = 'submitted';

-- ---------------------------------------------------------------------------
-- Radars: which users run which radar, each week's run, the ranked slate, and Dev Radar's
-- video archive (the fallback when YouTube's quota runs out).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radar_subscriptions_v2 (
    user_id     TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    radar       TEXT NOT NULL CHECK (radar IN ('trend', 'dev')),
    enabled     BOOLEAN NOT NULL DEFAULT true,
    -- {"channels": ["website","li_techahir"], "edition_id": "ai-mvp", "feeds": [...optional override]}
    settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, radar)
);

CREATE TABLE IF NOT EXISTS radar_runs_v2 (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    radar        TEXT NOT NULL CHECK (radar IN ('trend', 'dev')),
    -- The Monday (US Eastern) of the week the slate is for. One run per user, radar and week.
    week_of      DATE NOT NULL,
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed', 'kept_previous')),
    stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
    error        TEXT,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    UNIQUE (user_id, radar, week_of)
);

CREATE TABLE IF NOT EXISTS radar_topics_v2 (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    radar             TEXT NOT NULL CHECK (radar IN ('trend', 'dev')),
    week_of           DATE NOT NULL,
    rank              INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 50),
    title             TEXT NOT NULL,
    url               TEXT NOT NULL,
    source            TEXT NOT NULL DEFAULT '',
    item_type         TEXT NOT NULL DEFAULT 'article' CHECK (item_type IN ('article', 'video')),
    angle             TEXT NOT NULL DEFAULT '',
    category          TEXT NOT NULL DEFAULT '',
    driver_type       TEXT,
    client_relevance  TEXT,
    score             INTEGER,
    summary           TEXT NOT NULL DEFAULT '',
    also_covered_by   TEXT[] NOT NULL DEFAULT '{}',
    published_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, radar, week_of, rank)
);

CREATE TABLE IF NOT EXISTS radar_video_archive_v2 (
    user_id       TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    video_id      TEXT NOT NULL,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT '',
    channel       TEXT NOT NULL DEFAULT '',
    published_at  TIMESTAMPTZ,
    pulled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, video_id)
);

-- The schedule row a radar topic became, so the slate can show what is already queued.
ALTER TABLE social_schedule_v2
    ADD COLUMN IF NOT EXISTS radar_topic_id UUID REFERENCES radar_topics_v2(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Editions fed by a radar or by the posts themselves. These sources are filled by the engine
-- (radar run, publisher), never fetched by the ingestion cron.
-- ---------------------------------------------------------------------------
ALTER TABLE newsletter_feed_sources_v2
    DROP CONSTRAINT IF EXISTS newsletter_feed_sources_v2_url_type_check;
ALTER TABLE newsletter_feed_sources_v2
    ADD CONSTRAINT newsletter_feed_sources_v2_url_type_check
    CHECK (url_type IN ('rss', 'reddit', 'source', 'firecrawl_scrape', 'radar', 'social_queue'));

COMMENT ON COLUMN newsletter_feed_sources_v2.url_type IS
  'rss/reddit/source/firecrawl_scrape are fetched by the ingestion cron. radar (url radar://trend or '
  'radar://dev) and social_queue (url social://<channel> or social://all) are written by the engine '
  'when a radar slate is built or a scheduled post goes out.';

-- ---------------------------------------------------------------------------
-- updated_at + RLS: owners read their own rows; every write goes through the server or engine.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_social_channels_touch ON social_channels_v2;
CREATE TRIGGER trg_social_channels_touch BEFORE UPDATE ON social_channels_v2
    FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();
DROP TRIGGER IF EXISTS trg_social_deliveries_touch ON social_schedule_deliveries_v2;
CREATE TRIGGER trg_social_deliveries_touch BEFORE UPDATE ON social_schedule_deliveries_v2
    FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();
DROP TRIGGER IF EXISTS trg_radar_subscriptions_touch ON radar_subscriptions_v2;
CREATE TRIGGER trg_radar_subscriptions_touch BEFORE UPDATE ON radar_subscriptions_v2
    FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['social_channels_v2', 'social_schedule_v2', 'radar_subscriptions_v2',
                             'radar_runs_v2', 'radar_topics_v2', 'radar_video_archive_v2'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS owner_read ON %I', t);
        EXECUTE format('CREATE POLICY owner_read ON %I FOR SELECT USING (user_id = get_current_user_id() OR is_admin_v2())', t);
        EXECUTE format('DROP POLICY IF EXISTS service_role_all ON %I', t);
        EXECUTE format('CREATE POLICY service_role_all ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
    END LOOP;
END $$;

ALTER TABLE social_schedule_deliveries_v2 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_read ON social_schedule_deliveries_v2;
CREATE POLICY owner_read ON social_schedule_deliveries_v2 FOR SELECT USING (
    schedule_id IN (SELECT s.id FROM social_schedule_v2 s
                     WHERE s.user_id = get_current_user_id() OR is_admin_v2()));
DROP POLICY IF EXISTS service_role_all ON social_schedule_deliveries_v2;
CREATE POLICY service_role_all ON social_schedule_deliveries_v2 FOR ALL TO service_role
    USING (true) WITH CHECK (true);

COMMENT ON TABLE social_schedule_v2 IS
  'The post calendar: blog and LinkedIn posts queued for a day and slot (09:00 / 14:00 US Eastern). '
  'Drained by the engine publisher (SOCIAL_POSTING_MODE=live posts; anything else records dry_run deliveries).';
