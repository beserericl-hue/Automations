-- ============================================
-- The Author Agent — Supabase Setup Script
-- Run this in the Supabase SQL Editor
-- ============================================

-- 1. Genre Configuration
CREATE TABLE genre_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  genre_name TEXT NOT NULL,
  genre_slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  keywords TEXT[] NOT NULL,
  rss_feed_urls TEXT[] NOT NULL,
  source_urls TEXT[] NOT NULL,
  subreddit_names TEXT[] NOT NULL,
  goodreads_shelves TEXT[] NOT NULL,
  writing_guidelines TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Scraped Content Index
CREATE TABLE content_index (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  genre_slug TEXT NOT NULL REFERENCES genre_config(genre_slug),
  source_type TEXT NOT NULL,
  feed_name TEXT,
  source_url TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  content_path TEXT NOT NULL,
  scraped_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}'
);

-- 3. Writing Projects
CREATE TABLE writing_projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_type TEXT NOT NULL,
  title TEXT NOT NULL,
  genre_slug TEXT REFERENCES genre_config(genre_slug),
  status TEXT DEFAULT 'draft',
  outline JSONB,
  chapter_count INTEGER DEFAULT 0,
  draft_path TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Content Usage (provenance tracking)
CREATE TABLE content_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content_id UUID REFERENCES content_index(id),
  output_type TEXT NOT NULL,
  output_title TEXT NOT NULL,
  output_date DATE DEFAULT CURRENT_DATE,
  project_id UUID REFERENCES writing_projects(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Story Bible (book continuity)
CREATE TABLE story_bible (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES writing_projects(id),
  entry_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  chapter_introduced INTEGER,
  last_chapter_seen INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_story_bible_project ON story_bible(project_id);
CREATE INDEX idx_story_bible_type ON story_bible(project_id, entry_type);

-- 6. Published Content Library (draft/approve/publish workflow)
CREATE TABLE IF NOT EXISTS published_content (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('short_story', 'blog_post', 'newsletter', 'chapter')),
  genre_slug TEXT,
  content_text TEXT,
  storage_path TEXT,
  cover_image_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'rejected')),
  project_id UUID,
  chapter_number INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_published_content_status ON published_content(status);
CREATE INDEX IF NOT EXISTS idx_published_content_type ON published_content(content_type);

ALTER TABLE published_content ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon" ON published_content FOR ALL USING (true) WITH CHECK (true);

-- Add 'scheduled' status for scheduled publishing
ALTER TABLE published_content DROP CONSTRAINT IF EXISTS published_content_status_check;
ALTER TABLE published_content ADD CONSTRAINT published_content_status_check
  CHECK (status IN ('draft', 'approved', 'published', 'rejected', 'scheduled'));

-- 6b. Content Version History
CREATE TABLE IF NOT EXISTS content_versions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content_id UUID NOT NULL REFERENCES published_content(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content_text TEXT NOT NULL,
  changed_by TEXT DEFAULT 'system',
  change_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_versions_content_id ON content_versions(content_id);
CREATE INDEX IF NOT EXISTS idx_content_versions_lookup ON content_versions(content_id, version_number);

ALTER TABLE content_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon" ON content_versions FOR ALL USING (true) WITH CHECK (true);

-- 7. Content Metrics View
CREATE VIEW content_metrics AS
SELECT
  ci.genre_slug,
  ci.source_type,
  ci.feed_name,
  DATE(ci.scraped_at) AS scrape_date,
  COUNT(*) AS items_collected,
  COUNT(cu.id) AS items_used,
  ROUND(COUNT(cu.id)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS usage_rate_pct
FROM content_index ci
LEFT JOIN content_usage cu ON ci.id = cu.content_id
GROUP BY ci.genre_slug, ci.source_type, ci.feed_name, DATE(ci.scraped_at)
ORDER BY scrape_date DESC, genre_slug, source_type;

-- 7. Enable Row Level Security (allow access via anon key)
ALTER TABLE genre_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE writing_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_bible ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for anon" ON genre_config FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON content_index FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON writing_projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON content_usage FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON story_bible FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- 8. Seed Genre Data
-- ============================================

INSERT INTO genre_config (genre_name, genre_slug, description, keywords, rss_feed_urls, source_urls, subreddit_names, goodreads_shelves, writing_guidelines)
VALUES
(
  'Post-Apocalyptic Science Fiction',
  'post-apocalyptic',
  'Stories set after civilization-ending events — nuclear war, pandemics, environmental collapse, AI uprising. Focus on survival, rebuilding, and what it means to be human when everything is stripped away.',
  ARRAY['post-apocalyptic', 'dystopian', 'survival', 'wasteland', 'collapse', 'rebuilding', 'extinction', 'fallout', 'plague', 'aftermath'],
  ARRAY['https://medium.com/feed/tag/post-apocalyptic', 'https://medium.com/feed/tag/dystopian', 'https://medium.com/feed/tag/apocalypse', 'https://clarkesworldmagazine.com/feed/', 'https://escapepod.org/feed/', 'https://www.strangehorizons.com/feed/', 'https://www.risingshadow.net/rss/?genre=post-apocalyptic', 'https://dystopic.co.uk/feed/'],
  ARRAY['https://www.reddit.com/r/PostApocalypticFiction/', 'https://www.reddit.com/r/printSF/', 'https://www.goodreads.com/shelf/show/post-apocalyptic'],
  ARRAY['PostApocalypticFiction', 'postapocalyptic', 'printSF', 'apocalypse'],
  ARRAY['post-apocalyptic', 'dystopian', 'survival-fiction'],
  'Tone: gritty, visceral, intimate. World-building through scarcity and decay. Characters defined by what they''ve lost. Technology either absent or repurposed. Nature reclaiming. Hope is earned, never given. Reference works: The Road (McCarthy), Station Eleven (Mandel), The Book of the New Sun (Wolfe), A Canticle for Leibowitz (Miller).'
),
(
  'Political Science Fiction',
  'political-scifi',
  'Fiction exploring governance, power structures, propaganda, revolution, and ideological conflict through speculative settings. The technology is backdrop; the politics are the story.',
  ARRAY['political', 'governance', 'revolution', 'propaganda', 'empire', 'republic', 'ideology', 'totalitarian', 'democracy', 'insurgency', 'diplomacy'],
  ARRAY['https://medium.com/feed/tag/political-fiction', 'https://medium.com/feed/tag/dystopian', 'https://clarkesworldmagazine.com/feed/', 'https://escapepod.org/feed/', 'https://www.strangehorizons.com/feed/', 'https://dystopic.co.uk/feed/', 'https://locusmag.com/feed/', 'https://reactormag.com/feed/'],
  ARRAY['https://www.reddit.com/r/printSF/', 'https://www.reddit.com/r/scifi/', 'https://www.goodreads.com/shelf/show/political-science-fiction'],
  ARRAY['printSF', 'scifi'],
  ARRAY['political-science-fiction', 'political-thriller-sci-fi'],
  'Tone: cerebral, tense, morally ambiguous. Multiple factions with legitimate grievances. No clear villains — only competing interests. Power corrupts subtly. Dialogue-heavy with subtext. Bureaucracy as weapon. Reference works: Dune (Herbert), The Left Hand of Darkness (Le Guin), The Expanse (Corey), Foundation (Asimov), 1984 (Orwell).'
),
(
  'Historical Time Travel',
  'historical-time-travel',
  'Stories involving travel to real historical periods with consequences for altering the timeline. Blends historical fiction research rigor with speculative mechanics.',
  ARRAY['time travel', 'historical', 'timeline', 'paradox', 'alternate history', 'temporal', 'anachronism', 'causality', 'butterfly effect'],
  ARRAY['https://medium.com/feed/tag/time-travel', 'https://medium.com/feed/tag/alternate-history', 'https://medium.com/feed/tag/historical-fiction', 'https://clarkesworldmagazine.com/feed/', 'https://escapepod.org/feed/', 'https://www.strangehorizons.com/feed/', 'https://locusmag.com/feed/', 'https://reactormag.com/feed/'],
  ARRAY['https://www.reddit.com/r/timetravel/', 'https://www.reddit.com/r/AlternateHistory/', 'https://www.goodreads.com/shelf/show/time-travel-fiction'],
  ARRAY['timetravel', 'AlternateHistory', 'timetravelbooks', 'printSF'],
  ARRAY['time-travel', 'time-travel-fiction', 'alternate-history'],
  'Tone: meticulous, wonder-infused, stakes-aware. Historical accuracy is non-negotiable — research every detail. Fish-out-of-water tension. Paradox as narrative engine. The past resists change. Language adapts to period without being unreadable. Reference works: 11/22/63 (King), The Doomsday Book (Willis), Kindred (Butler), Timeline (Crichton), The Time Traveler''s Wife (Niffenegger).'
);
