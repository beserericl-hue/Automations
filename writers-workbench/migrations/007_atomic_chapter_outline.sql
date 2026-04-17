-- Atomic chapter outline save function
-- Prevents race conditions when multiple executions try to save chapter outlines concurrently.
-- Instead of replacing the entire outline JSONB, this merges just the chapter_outline
-- into the specific chapter by index.

CREATE OR REPLACE FUNCTION save_chapter_outline(
  p_project_id UUID,
  p_user_id TEXT,
  p_chapter_index INT,
  p_chapter_outline JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  UPDATE writing_projects_v2
  SET
    outline = jsonb_set(
      outline,
      ARRAY['chapters', p_chapter_index::text, 'chapter_outline'],
      p_chapter_outline
    ),
    updated_at = now()
  WHERE id = p_project_id
    AND user_id = p_user_id
  RETURNING outline->'chapters'->p_chapter_index INTO v_result;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Project not found or chapter index out of range';
  END IF;

  RETURN v_result;
END;
$$;

-- Grant execute to authenticated and service role
GRANT EXECUTE ON FUNCTION save_chapter_outline(UUID, TEXT, INT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION save_chapter_outline(UUID, TEXT, INT, JSONB) TO service_role;
