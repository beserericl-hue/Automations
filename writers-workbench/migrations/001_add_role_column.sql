-- ============================================
-- Migration 001: Add dedicated role column to users_v2
-- Fixes admin role escalation vulnerability (S0-4)
-- Run this in V2 Supabase SQL Editor
-- ============================================

-- 1. Add role column with constraint
ALTER TABLE users_v2 ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'
  CHECK (role IN ('user', 'admin', 'editor', 'viewer'));

-- 2. Set existing admin user
UPDATE users_v2 SET role = 'admin' WHERE user_id = '+14105914612';

-- 3. Trigger to prevent non-admin self-escalation
CREATE OR REPLACE FUNCTION prevent_role_escalation()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow if role isn't changing
  IF OLD.role = NEW.role THEN
    RETURN NEW;
  END IF;

  -- Allow if the current user is an admin (service role bypasses RLS/triggers via SECURITY DEFINER)
  IF EXISTS (
    SELECT 1 FROM users_v2
    WHERE supabase_auth_uid = auth.uid()
      AND role = 'admin'
  ) THEN
    RETURN NEW;
  END IF;

  -- Block the role change
  RAISE EXCEPTION 'Only admins can change user roles';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_role_escalation ON users_v2;
CREATE TRIGGER trg_prevent_role_escalation
  BEFORE UPDATE OF role ON users_v2
  FOR EACH ROW
  EXECUTE FUNCTION prevent_role_escalation();

-- 4. Update is_admin() to read from role column instead of preferences JSONB
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT role = 'admin' FROM users_v2
     WHERE supabase_auth_uid = auth.uid()
     LIMIT 1),
    false
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
