-- Sprint 3: Auto-populate outline_versions_v2 on outline changes
-- This trigger snapshots the previous outline when writing_projects_v2.outline is updated

CREATE OR REPLACE FUNCTION snapshot_outline_on_change()
RETURNS TRIGGER AS $$
DECLARE
  next_version INTEGER;
BEGIN
  -- Only fire if outline actually changed and old outline was not null
  IF OLD.outline IS NOT NULL AND OLD.outline IS DISTINCT FROM NEW.outline THEN
    SELECT COALESCE(MAX(version_number), 0) + 1
    INTO next_version
    FROM outline_versions_v2
    WHERE project_id = OLD.id;

    INSERT INTO outline_versions_v2 (user_id, project_id, version_number, outline, revision_note)
    VALUES (
      OLD.user_id,
      OLD.id,
      next_version,
      OLD.outline,
      'Auto-snapshot before outline change'
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop if exists to allow re-running
DROP TRIGGER IF EXISTS trg_snapshot_outline ON writing_projects_v2;

CREATE TRIGGER trg_snapshot_outline
  BEFORE UPDATE OF outline ON writing_projects_v2
  FOR EACH ROW
  EXECUTE FUNCTION snapshot_outline_on_change();
