-- ============================================
-- The Author Agent V2 — Multi-User Supabase Setup
-- Run this in the Supabase SQL Editor
-- V1 tables remain untouched. V2 tables add user_id partitioning.
-- ============================================

-- ============================================
-- 0. Shared Content Index (public, not user-scoped)
-- Needed for content_usage_v2 FK and metrics view.
-- Same structure as V1 but without genre_config FK
-- (genres live in genre_config_v2 now).
-- ============================================
CREATE TABLE IF NOT EXISTS content_index (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  genre_slug TEXT NOT NULL,
  source_type TEXT NOT NULL,
  feed_name TEXT,
  source_url TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  content_path TEXT NOT NULL,
  scraped_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}'
);

ALTER TABLE content_index ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon" ON content_index FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- 1. Users (identity & per-user settings)
-- ============================================
CREATE TABLE IF NOT EXISTS users_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,                    -- conversation_id from ElevenLabs (stable identifier)
  phone_number TEXT UNIQUE,                        -- E.164 format, for future phone-based grouping
  display_name TEXT,
  email TEXT,                                      -- per-user recipient_email
  bcc_email TEXT,                                  -- per-user bcc_email
  preferences JSONB DEFAULT '{}',                  -- extensible user preferences
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_v2_user_id ON users_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_users_v2_phone ON users_v2(phone_number);

-- ============================================
-- 2. Genre Configuration (public + private genres)
-- user_id IS NULL = public genre (visible to all)
-- user_id populated = private genre (visible only to owner)
-- ============================================
CREATE TABLE IF NOT EXISTS genre_config_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT REFERENCES users_v2(user_id) ON DELETE CASCADE,
  genre_name TEXT NOT NULL,
  genre_slug TEXT NOT NULL,
  description TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  rss_feed_urls TEXT[] NOT NULL DEFAULT '{}',
  source_urls TEXT[] NOT NULL DEFAULT '{}',
  subreddit_names TEXT[] NOT NULL DEFAULT '{}',
  goodreads_shelves TEXT[] NOT NULL DEFAULT '{}',
  writing_guidelines TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Prevent duplicate public genre slugs (NULL user_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_genre_config_v2_slug_public
  ON genre_config_v2(genre_slug) WHERE user_id IS NULL;
-- Allow same slug for different users (private genres)
CREATE INDEX IF NOT EXISTS idx_genre_config_v2_user ON genre_config_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_genre_config_v2_slug ON genre_config_v2(genre_slug);

-- ============================================
-- 3. Story Arcs (public + private arc frameworks)
-- Same public/private pattern as genres
-- ============================================
CREATE TABLE IF NOT EXISTS story_arcs_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT REFERENCES users_v2(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_story_arcs_v2_name_public
  ON story_arcs_v2(name) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_story_arcs_v2_user ON story_arcs_v2(user_id);

-- ============================================
-- 4. Writing Projects (user-scoped)
-- ============================================
CREATE TABLE IF NOT EXISTS writing_projects_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  project_type TEXT NOT NULL,
  title TEXT NOT NULL,
  genre_slug TEXT,
  status TEXT DEFAULT 'draft',
  outline JSONB,
  chapter_count INTEGER DEFAULT 0,
  draft_path TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_writing_projects_v2_user ON writing_projects_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_writing_projects_v2_user_title ON writing_projects_v2(user_id, title);
CREATE INDEX IF NOT EXISTS idx_writing_projects_v2_user_genre ON writing_projects_v2(user_id, genre_slug);

-- ============================================
-- 5. Story Bible (user-scoped book continuity)
-- ============================================
CREATE TABLE IF NOT EXISTS story_bible_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  chapter_introduced INTEGER,
  last_chapter_seen INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_story_bible_v2_user ON story_bible_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_story_bible_v2_project ON story_bible_v2(project_id);
CREATE INDEX IF NOT EXISTS idx_story_bible_v2_type ON story_bible_v2(project_id, entry_type);

-- ============================================
-- 6. Published Content Library (user-scoped)
-- ============================================
CREATE TABLE IF NOT EXISTS published_content_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('short_story', 'blog_post', 'newsletter', 'chapter')),
  genre_slug TEXT,
  content_text TEXT,
  storage_path TEXT,
  cover_image_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'rejected', 'scheduled')),
  project_id UUID REFERENCES writing_projects_v2(id),
  chapter_number INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_published_content_v2_user ON published_content_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_published_content_v2_user_status ON published_content_v2(user_id, status);
CREATE INDEX IF NOT EXISTS idx_published_content_v2_user_type ON published_content_v2(user_id, content_type);
CREATE INDEX IF NOT EXISTS idx_published_content_v2_project ON published_content_v2(project_id);

-- ============================================
-- 6b. Content Version History (user-scoped)
-- ============================================
CREATE TABLE IF NOT EXISTS content_versions_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  content_id UUID NOT NULL REFERENCES published_content_v2(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content_text TEXT NOT NULL,
  changed_by TEXT DEFAULT 'system',
  change_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_versions_v2_user ON content_versions_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_content_versions_v2_content ON content_versions_v2(content_id);
CREATE INDEX IF NOT EXISTS idx_content_versions_v2_lookup ON content_versions_v2(content_id, version_number);

-- ============================================
-- 7. Outline Versions (user-scoped)
-- ============================================
CREATE TABLE IF NOT EXISTS outline_versions_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES writing_projects_v2(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL DEFAULT 1,
  outline JSONB NOT NULL,
  revision_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outline_versions_v2_user ON outline_versions_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_outline_versions_v2_project ON outline_versions_v2(project_id, version_number DESC);

-- ============================================
-- 8. Content Usage / Provenance (user-scoped)
-- References shared content_index (V1, public)
-- ============================================
CREATE TABLE IF NOT EXISTS content_usage_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  content_id UUID REFERENCES content_index(id),
  output_type TEXT NOT NULL,
  output_title TEXT NOT NULL,
  output_date DATE DEFAULT CURRENT_DATE,
  project_id UUID REFERENCES writing_projects_v2(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_usage_v2_user ON content_usage_v2(user_id);

-- ============================================
-- 9. Research Reports (user-scoped, new table)
-- Missing from V1 SQL but used in workflows
-- ============================================
CREATE TABLE IF NOT EXISTS research_reports_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  genre_slug TEXT,
  content TEXT,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_research_reports_v2_user ON research_reports_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_research_reports_v2_user_topic ON research_reports_v2(user_id, topic);

-- ============================================
-- 10. App Config (user-scoped settings)
-- Per-user key/value pairs (email, bcc, preferences)
-- ============================================
CREATE TABLE IF NOT EXISTS app_config_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_app_config_v2_user ON app_config_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_app_config_v2_user_key ON app_config_v2(user_id, key);

-- ============================================
-- 11. Content Metrics View (V2)
-- ============================================
CREATE OR REPLACE VIEW content_metrics_v2 AS
SELECT
  ci.genre_slug,
  ci.source_type,
  ci.feed_name,
  DATE(ci.scraped_at) AS scrape_date,
  COUNT(*) AS items_collected,
  COUNT(cu.id) AS items_used,
  ROUND(COUNT(cu.id)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS usage_rate_pct
FROM content_index ci
LEFT JOIN content_usage_v2 cu ON ci.id = cu.content_id
GROUP BY ci.genre_slug, ci.source_type, ci.feed_name, DATE(ci.scraped_at)
ORDER BY scrape_date DESC, genre_slug, source_type;

-- ============================================
-- 12. Row Level Security
-- Service role (used by n8n) bypasses RLS.
-- These policies are defense-in-depth for anon key.
-- ============================================

-- Users
ALTER TABLE users_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service" ON users_v2 FOR ALL USING (true) WITH CHECK (true);

-- Genre Config (public + private)
ALTER TABLE genre_config_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public and own genres readable" ON genre_config_v2
  FOR SELECT USING (user_id IS NULL OR user_id = current_setting('app.current_user_id', true));
CREATE POLICY "Own genres writable" ON genre_config_v2
  FOR ALL USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));
CREATE POLICY "Service full access genres" ON genre_config_v2 FOR ALL USING (true) WITH CHECK (true);

-- Story Arcs (public + private)
ALTER TABLE story_arcs_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public and own arcs readable" ON story_arcs_v2
  FOR SELECT USING (user_id IS NULL OR user_id = current_setting('app.current_user_id', true));
CREATE POLICY "Own arcs writable" ON story_arcs_v2
  FOR ALL USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));
CREATE POLICY "Service full access arcs" ON story_arcs_v2 FOR ALL USING (true) WITH CHECK (true);

-- All user-scoped tables: owner-only access
ALTER TABLE writing_projects_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own data only" ON writing_projects_v2 FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE story_bible_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own data only" ON story_bible_v2 FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE published_content_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own data only" ON published_content_v2 FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE content_versions_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own data only" ON content_versions_v2 FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE outline_versions_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own data only" ON outline_versions_v2 FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE content_usage_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own data only" ON content_usage_v2 FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE research_reports_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own data only" ON research_reports_v2 FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE app_config_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own data only" ON app_config_v2 FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- 13. Seed Public Genres (7 genres, user_id = NULL = public)
-- ============================================
INSERT INTO genre_config_v2 (genre_name, genre_slug, description, keywords, rss_feed_urls, source_urls, subreddit_names, goodreads_shelves, writing_guidelines, active)
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
  'Tone: gritty, visceral, intimate. World-building through scarcity and decay. Characters defined by what they''ve lost. Technology either absent or repurposed. Nature reclaiming. Hope is earned, never given. Reference works: The Road (McCarthy), Station Eleven (Mandel), The Book of the New Sun (Wolfe), A Canticle for Leibowitz (Miller).',
  true
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
  'Tone: cerebral, tense, morally ambiguous. Multiple factions with legitimate grievances. No clear villains — only competing interests. Power corrupts subtly. Dialogue-heavy with subtext. Bureaucracy as weapon. Reference works: Dune (Herbert), The Left Hand of Darkness (Le Guin), The Expanse (Corey), Foundation (Asimov), 1984 (Orwell).',
  true
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
  'Tone: meticulous, wonder-infused, stakes-aware. Historical accuracy is non-negotiable — research every detail. Fish-out-of-water tension. Paradox as narrative engine. The past resists change. Language adapts to period without being unreadable. Reference works: 11/22/63 (King), The Doomsday Book (Willis), Kindred (Butler), Timeline (Crichton), The Time Traveler''s Wife (Niffenegger).',
  true
),
(
  'AI & Marketing Technology',
  'ai-marketing',
  'Non-fiction and analysis covering artificial intelligence, marketing automation, LLMs, generative AI, martech platforms, and content marketing strategy.',
  ARRAY['artificial intelligence', 'AI tools', 'marketing automation', 'LLM', 'martech', 'generative AI', 'content marketing', 'machine learning', 'chatbot', 'prompt engineering'],
  ARRAY['https://medium.com/feed/tag/artificial-intelligence', 'https://medium.com/feed/tag/marketing-technology', 'https://medium.com/feed/tag/generative-ai'],
  ARRAY['https://www.reddit.com/r/artificial/', 'https://www.reddit.com/r/marketing/'],
  ARRAY['artificial', 'marketing', 'ChatGPT', 'LocalLLaMA'],
  ARRAY['artificial-intelligence', 'marketing-technology'],
  'Tone: authoritative, practical, forward-looking. Ground claims in real examples and data. Explain complex AI concepts accessibly without dumbing down. Focus on actionable insights for marketers and technologists.',
  true
),
(
  'Political & Historical Events',
  'political-history',
  'Analysis of geopolitics, political history, revolutions, democracy, elections, and historical turning points that shaped the modern world.',
  ARRAY['geopolitics', 'political history', 'revolution', 'democracy', 'elections', 'cold war', 'historical analysis', 'diplomacy', 'foreign policy'],
  ARRAY['https://medium.com/feed/tag/political-history', 'https://medium.com/feed/tag/geopolitics', 'https://medium.com/feed/tag/history'],
  ARRAY['https://www.reddit.com/r/history/', 'https://www.reddit.com/r/geopolitics/'],
  ARRAY['history', 'geopolitics', 'PoliticalHistory'],
  ARRAY['political-history', 'world-history'],
  'Tone: scholarly yet accessible, balanced, evidence-based. Present multiple perspectives on contested events. Use primary sources when possible. Connect historical patterns to contemporary relevance.',
  true
),
(
  'Ancient History & Historical Novels',
  'ancient-history',
  'Fiction and non-fiction set in or about ancient civilizations — Rome, Greece, Egypt, Mesopotamia, medieval Europe, and classical antiquity.',
  ARRAY['ancient Rome', 'Greece', 'Egypt', 'Mesopotamia', 'medieval', 'archaeology', 'classical antiquity', 'historical fiction', 'ancient world'],
  ARRAY['https://medium.com/feed/tag/ancient-history', 'https://medium.com/feed/tag/archaeology', 'https://medium.com/feed/tag/historical-fiction'],
  ARRAY['https://www.reddit.com/r/ancienthistory/', 'https://www.reddit.com/r/HistoricalFiction/'],
  ARRAY['ancienthistory', 'HistoricalFiction', 'archaeology'],
  ARRAY['ancient-history', 'historical-fiction', 'classical-antiquity'],
  'Tone: immersive, richly detailed, historically grounded. Bring ancient worlds to life through sensory detail. Balance historical accuracy with narrative drive. Characters should feel authentic to their era while remaining relatable.',
  true
),
(
  'Metaphysical Romance',
  'metaphysical-romance',
  'Stories exploring soulmates, past lives, reincarnation, grief, caregiving, dementia, cancer, terminal illness, familiar souls, love across lifetimes, death and dying, and second love.',
  ARRAY['soulmates', 'past lives', 'reincarnation', 'grief', 'caregiving', 'dementia', 'cancer', 'terminal illness', 'familiar souls', 'love across lifetimes', 'death and dying', 'second love'],
  ARRAY['https://medium.com/feed/tag/reincarnation', 'https://medium.com/feed/tag/grief', 'https://medium.com/feed/tag/love-story', 'https://medium.com/feed/tag/metaphysical'],
  ARRAY['https://www.reddit.com/r/romancebooks/', 'https://www.reddit.com/r/booksuggestions/'],
  ARRAY['romancebooks', 'booksuggestions', 'paranormalromance'],
  ARRAY['reincarnation-romance', 'metaphysical-fiction', 'grief-literature'],
  'Tone: lyrical, emotionally rich, intimate. Explore the boundary between the physical and spiritual. Grief is not a problem to solve but a landscape to inhabit. Past lives should feel vivid and specific, not generic. Love persists across death — show how. Reference works: The Time Traveler''s Wife, Cloud Atlas, The Lovely Bones, Before I Go To Sleep.',
  true
)
ON CONFLICT DO NOTHING;

-- ============================================
-- 14. Seed Public Story Arcs
-- ============================================
INSERT INTO story_arcs_v2 (name, description, prompt_text)
VALUES
(
  'Freytags Pyramid',
  'Five-act tragic arc: Introduction, Rising Action, Climax, Falling Action, Catastrophe. Best for tragedies and dark fiction.',
  'Structure the outline using Freytag''s Pyramid (five-act structure): Act 1 — Introduction (exposition, world-building, inciting incident), Act 2 — Rising Action (complications, escalating stakes, character development), Act 3 — Climax (the turning point, maximum tension, irreversible choice), Act 4 — Falling Action (consequences unfold, reversals, tragic recognition), Act 5 — Catastrophe/Denouement (final resolution, tragic or bittersweet ending). Include a Prologue (Section 0) to set the stage and an Epilogue (final section) for closure if the story warrants it.'
),
(
  'Three-Act Structure',
  'Universal Setup/Confrontation/Resolution framework for all genres.',
  'Structure the outline using the Three-Act Structure: Act 1 — Setup (introduce characters, establish the world, present the inciting incident that disrupts the status quo, end with the first plot point that commits the protagonist to action), Act 2 — Confrontation (rising stakes, midpoint reversal, escalating obstacles, character growth through conflict, the ''all is lost'' moment near the end), Act 3 — Resolution (climax where the central conflict peaks, falling action, denouement that shows the new normal). Include a Prologue (Section 0) if the story benefits from a hook scene before the main timeline.'
)
ON CONFLICT DO NOTHING;
