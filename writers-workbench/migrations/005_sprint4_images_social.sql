-- Sprint 4: Image & Social Media Persistence Layer
-- Creates generated_images_v2 and social_posts_v2 tables
-- Adds RLS policies for user data isolation

-- ============================================================
-- 1. generated_images_v2
-- ============================================================
CREATE TABLE IF NOT EXISTS generated_images_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  content_id UUID REFERENCES published_content_v2(id) ON DELETE SET NULL,
  project_id UUID REFERENCES writing_projects_v2(id) ON DELETE SET NULL,
  image_type TEXT NOT NULL CHECK (image_type IN ('cover_art', 'chapter_art', 'social_media', 'newsletter_section')),
  platform TEXT CHECK (platform IS NULL OR platform IN ('twitter', 'linkedin', 'instagram', 'facebook')),
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  original_prompt TEXT,
  genre_slug TEXT,
  image_format TEXT DEFAULT 'png',
  width INTEGER,
  height INTEGER,
  file_size_bytes INTEGER,
  generation_model TEXT DEFAULT 'nano-banana-pro',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_images_v2_user ON generated_images_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_generated_images_v2_content ON generated_images_v2(content_id);
CREATE INDEX IF NOT EXISTS idx_generated_images_v2_project ON generated_images_v2(project_id);
CREATE INDEX IF NOT EXISTS idx_generated_images_v2_type ON generated_images_v2(user_id, image_type);

-- RLS for generated_images_v2
ALTER TABLE generated_images_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own images"
  ON generated_images_v2 FOR SELECT
  USING (user_id = (SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1));

CREATE POLICY "Users can insert their own images"
  ON generated_images_v2 FOR INSERT
  WITH CHECK (user_id = (SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1));

CREATE POLICY "Users can update their own images"
  ON generated_images_v2 FOR UPDATE
  USING (user_id = (SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1));

CREATE POLICY "Users can delete their own images"
  ON generated_images_v2 FOR DELETE
  USING (user_id = (SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1));

-- ============================================================
-- 2. social_posts_v2
-- ============================================================
CREATE TABLE IF NOT EXISTS social_posts_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  source_content_id UUID REFERENCES published_content_v2(id) ON DELETE SET NULL,
  project_id UUID REFERENCES writing_projects_v2(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('twitter', 'linkedin', 'instagram', 'facebook')),
  post_text TEXT NOT NULL,
  hashtags TEXT[] DEFAULT '{}',
  image_id UUID REFERENCES generated_images_v2(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'scheduled')),
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_posts_v2_user ON social_posts_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_v2_project ON social_posts_v2(project_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_v2_platform ON social_posts_v2(user_id, platform);

-- RLS for social_posts_v2
ALTER TABLE social_posts_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own social posts"
  ON social_posts_v2 FOR SELECT
  USING (user_id = (SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1));

CREATE POLICY "Users can insert their own social posts"
  ON social_posts_v2 FOR INSERT
  WITH CHECK (user_id = (SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1));

CREATE POLICY "Users can update their own social posts"
  ON social_posts_v2 FOR UPDATE
  USING (user_id = (SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1));

CREATE POLICY "Users can delete their own social posts"
  ON social_posts_v2 FOR DELETE
  USING (user_id = (SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1));

-- ============================================================
-- 3. Storage buckets (run via Supabase dashboard or SQL)
-- ============================================================
-- These need to be created in Supabase Storage settings:
--   - cover-images   (public read, authenticated write)
--   - social-images  (public read, authenticated write)
--   - writing-samples (authenticated read/write)
--
-- Storage bucket creation via SQL (if supported):
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('cover-images', 'cover-images', true),
  ('social-images', 'social-images', true),
  ('writing-samples', 'writing-samples', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for cover-images
CREATE POLICY "Public read for cover images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'cover-images');

CREATE POLICY "Authenticated upload to cover images"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'cover-images' AND auth.role() = 'authenticated');

CREATE POLICY "Users can delete own cover images"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'cover-images' AND auth.role() = 'authenticated');

-- Storage policies for social-images
CREATE POLICY "Public read for social images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'social-images');

CREATE POLICY "Authenticated upload to social images"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'social-images' AND auth.role() = 'authenticated');

CREATE POLICY "Users can delete own social images"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'social-images' AND auth.role() = 'authenticated');

-- Storage policies for writing-samples
CREATE POLICY "Authenticated read for writing samples"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'writing-samples' AND auth.role() = 'authenticated');

CREATE POLICY "Authenticated upload to writing samples"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'writing-samples' AND auth.role() = 'authenticated');

CREATE POLICY "Users can delete own writing samples"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'writing-samples' AND auth.role() = 'authenticated');
