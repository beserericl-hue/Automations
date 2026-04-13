-- Fix: When a project is deleted, cascade delete its content (no orphans)
-- Changes published_content_v2.project_id from ON DELETE SET NULL to ON DELETE CASCADE
-- Also changes content_usage_v2.project_id to ON DELETE CASCADE

-- published_content_v2.project_id
ALTER TABLE published_content_v2
  DROP CONSTRAINT IF EXISTS published_content_v2_project_id_fkey;

ALTER TABLE published_content_v2
  ADD CONSTRAINT published_content_v2_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES writing_projects_v2(id)
  ON DELETE CASCADE;

-- content_usage_v2.project_id
ALTER TABLE content_usage_v2
  DROP CONSTRAINT IF EXISTS content_usage_v2_project_id_fkey;

ALTER TABLE content_usage_v2
  ADD CONSTRAINT content_usage_v2_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES writing_projects_v2(id)
  ON DELETE CASCADE;
