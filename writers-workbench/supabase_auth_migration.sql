-- ============================================
-- The Writers Workbench — Auth Migration
-- Run this in the V2 Supabase SQL Editor
-- Adds supabase_auth_uid column and updates RLS
-- ============================================

-- 1. Add supabase_auth_uid column to users_v2
ALTER TABLE users_v2 ADD COLUMN IF NOT EXISTS supabase_auth_uid UUID;
CREATE INDEX IF NOT EXISTS idx_users_v2_auth_uid ON users_v2(supabase_auth_uid);

-- 2. Function to resolve phone-based user_id from JWT
-- Used by RLS policies so the frontend can query with auth.uid()
CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS TEXT AS $$
  SELECT user_id FROM users_v2
  WHERE supabase_auth_uid = auth.uid()
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 3. Helper to check if current user is admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT preferences->>'role' = 'admin' FROM users_v2
     WHERE supabase_auth_uid = auth.uid()
     LIMIT 1),
    false
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================
-- 4. Update RLS policies on all user-scoped tables
-- Pattern: service role bypasses RLS (n8n unchanged)
-- Authenticated users see only their own data via JWT
-- ============================================

-- users_v2: users can read/update their own row, admins can read all
DROP POLICY IF EXISTS "Allow all for service" ON users_v2;
DROP POLICY IF EXISTS "Users read own profile" ON users_v2;
DROP POLICY IF EXISTS "Users update own profile" ON users_v2;
DROP POLICY IF EXISTS "Users insert own profile" ON users_v2;
DROP POLICY IF EXISTS "Admins read all users" ON users_v2;

CREATE POLICY "Users read own profile" ON users_v2
  FOR SELECT USING (supabase_auth_uid = auth.uid() OR is_admin());
CREATE POLICY "Users update own profile" ON users_v2
  FOR UPDATE USING (supabase_auth_uid = auth.uid());
CREATE POLICY "Users insert own profile" ON users_v2
  FOR INSERT WITH CHECK (supabase_auth_uid = auth.uid());
-- Service role still bypasses RLS for n8n operations

-- genre_config_v2: public readable, own genres writable
DROP POLICY IF EXISTS "Public and own genres readable" ON genre_config_v2;
DROP POLICY IF EXISTS "Own genres writable" ON genre_config_v2;
DROP POLICY IF EXISTS "Service full access genres" ON genre_config_v2;

CREATE POLICY "Read public and own genres" ON genre_config_v2
  FOR SELECT USING (user_id IS NULL OR user_id = get_current_user_id());
CREATE POLICY "Manage own genres" ON genre_config_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());
CREATE POLICY "Admins manage public genres" ON genre_config_v2
  FOR ALL USING (user_id IS NULL AND is_admin())
  WITH CHECK (user_id IS NULL AND is_admin());

-- story_arcs_v2: public readable, own arcs writable
DROP POLICY IF EXISTS "Public and own arcs readable" ON story_arcs_v2;
DROP POLICY IF EXISTS "Own arcs writable" ON story_arcs_v2;
DROP POLICY IF EXISTS "Service full access arcs" ON story_arcs_v2;

CREATE POLICY "Read public and own arcs" ON story_arcs_v2
  FOR SELECT USING (user_id IS NULL OR user_id = get_current_user_id());
CREATE POLICY "Manage own arcs" ON story_arcs_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());
CREATE POLICY "Admins manage public arcs" ON story_arcs_v2
  FOR ALL USING (user_id IS NULL AND is_admin())
  WITH CHECK (user_id IS NULL AND is_admin());

-- writing_projects_v2
DROP POLICY IF EXISTS "Own data only" ON writing_projects_v2;
CREATE POLICY "Own data only" ON writing_projects_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- story_bible_v2
DROP POLICY IF EXISTS "Own data only" ON story_bible_v2;
CREATE POLICY "Own data only" ON story_bible_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- published_content_v2
DROP POLICY IF EXISTS "Own data only" ON published_content_v2;
CREATE POLICY "Own data only" ON published_content_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- content_versions_v2
DROP POLICY IF EXISTS "Own data only" ON content_versions_v2;
CREATE POLICY "Own data only" ON content_versions_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- outline_versions_v2
DROP POLICY IF EXISTS "Own data only" ON outline_versions_v2;
CREATE POLICY "Own data only" ON outline_versions_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- content_usage_v2
DROP POLICY IF EXISTS "Own data only" ON content_usage_v2;
CREATE POLICY "Own data only" ON content_usage_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- research_reports_v2
DROP POLICY IF EXISTS "Own data only" ON research_reports_v2;
CREATE POLICY "Own data only" ON research_reports_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- app_config_v2
DROP POLICY IF EXISTS "Own data only" ON app_config_v2;
CREATE POLICY "Own data only" ON app_config_v2
  FOR ALL USING (user_id = get_current_user_id())
  WITH CHECK (user_id = get_current_user_id());

-- content_index remains public (unchanged)
-- content_metrics_v2 is a view (no RLS needed)
