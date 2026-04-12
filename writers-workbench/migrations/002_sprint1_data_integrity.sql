-- ============================================
-- Migration 002: Sprint 1 — Data Integrity & Soft Deletes
-- Fixes FK cascades, adds deleted_at columns, adds discovery_question
-- Run this in V2 Supabase SQL Editor
-- ============================================

-- ===========================================
-- 1. Fix FK cascades: published_content_v2.project_id → ON DELETE SET NULL
-- ===========================================
ALTER TABLE published_content_v2
  DROP CONSTRAINT IF EXISTS published_content_v2_project_id_fkey;

ALTER TABLE published_content_v2
  ADD CONSTRAINT published_content_v2_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES writing_projects_v2(id)
  ON DELETE SET NULL;

-- ===========================================
-- 2. Fix FK cascades: content_usage_v2.project_id → ON DELETE SET NULL
-- ===========================================
ALTER TABLE content_usage_v2
  DROP CONSTRAINT IF EXISTS content_usage_v2_project_id_fkey;

ALTER TABLE content_usage_v2
  ADD CONSTRAINT content_usage_v2_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES writing_projects_v2(id)
  ON DELETE SET NULL;

-- ===========================================
-- 3. Add deleted_at columns for soft delete
-- ===========================================
ALTER TABLE writing_projects_v2
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE published_content_v2
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE research_reports_v2
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE story_bible_v2
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- ===========================================
-- 4. Add discovery_question to story_arcs_v2
-- ===========================================
ALTER TABLE story_arcs_v2
  ADD COLUMN IF NOT EXISTS discovery_question TEXT;

-- Populate discovery questions for all 8 arcs
UPDATE story_arcs_v2 SET discovery_question = 'What is the fatal flaw that drives your protagonist toward their downfall?' WHERE name ILIKE '%freytag%';
UPDATE story_arcs_v2 SET discovery_question = 'What does your protagonist want, and what stands in their way?' WHERE name ILIKE '%three-act%' OR name ILIKE '%three act%';
UPDATE story_arcs_v2 SET discovery_question = 'What call to adventure pulls your hero from their ordinary world?' WHERE name ILIKE '%hero%journey%';
UPDATE story_arcs_v2 SET discovery_question = 'Where does your character feel most comfortable, and what disrupts that comfort?' WHERE name ILIKE '%dan harmon%' OR name ILIKE '%story circle%';
UPDATE story_arcs_v2 SET discovery_question = 'What is the most dramatic moment in your story that we should open with?' WHERE name ILIKE '%in medias res%';
UPDATE story_arcs_v2 SET discovery_question = 'What is the single turning point that changes everything for your protagonist?' WHERE name ILIKE '%seven-point%' OR name ILIKE '%seven point%';
UPDATE story_arcs_v2 SET discovery_question = 'What surprising twist emerges naturally from the situation you have set up?' WHERE name ILIKE '%kisho%';
UPDATE story_arcs_v2 SET discovery_question = 'What is the first crisis that hooks the reader immediately?' WHERE name ILIKE '%fichtean%';

-- ===========================================
-- 5. Formalize token_usage_v2 table
-- Table already exists — add missing columns and RLS
-- ===========================================
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS workflow_name TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS total_tokens INTEGER DEFAULT 0;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 6) DEFAULT 0;
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE token_usage_v2 ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- RLS for token_usage_v2 (only if user_id column exists)
ALTER TABLE token_usage_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own token usage" ON token_usage_v2;
CREATE POLICY "Users see own token usage" ON token_usage_v2
  FOR SELECT USING (
    user_id = (SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid() LIMIT 1)
  );

DROP POLICY IF EXISTS "Admins see all token usage" ON token_usage_v2;
CREATE POLICY "Admins see all token usage" ON token_usage_v2
  FOR SELECT USING (is_admin());

-- ===========================================
-- 6. Indexes for soft delete filtering
-- ===========================================
CREATE INDEX IF NOT EXISTS idx_writing_projects_v2_deleted_at ON writing_projects_v2(deleted_at);
CREATE INDEX IF NOT EXISTS idx_published_content_v2_deleted_at ON published_content_v2(deleted_at);
CREATE INDEX IF NOT EXISTS idx_research_reports_v2_deleted_at ON research_reports_v2(deleted_at);
CREATE INDEX IF NOT EXISTS idx_story_bible_v2_deleted_at ON story_bible_v2(deleted_at);
