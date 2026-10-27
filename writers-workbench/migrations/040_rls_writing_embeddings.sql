-- 040 — Row-Level Security on writing_embeddings_v2 (Supabase security advisor: rls_disabled_in_public).
--
-- WHY. The table had RLS off, so anyone holding the project's public (anon) key could read, change
-- or delete every project's canon embeddings — the text of chapters, outlines and bible entries.
-- Supabase flagged it on 2026-10-25.
--
-- Nothing legitimate reads it with the anon key: the engine (writer_engine.embeddings) and the n8n
-- "Sub - Embed Project Data" workflow use the service role, which bypasses RLS, and the browser app
-- never touches the table. So: RLS on, the owner may read their own rows, the service role may do
-- anything, and the anon / authenticated roles lose their write grants outright.
--
-- Not a base table (docs/schema-governance.md), so in bounds.

ALTER TABLE writing_embeddings_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_read ON writing_embeddings_v2;
CREATE POLICY owner_read ON writing_embeddings_v2
    FOR SELECT USING (user_id = get_current_user_id() OR is_admin_v2());

DROP POLICY IF EXISTS service_role_all ON writing_embeddings_v2;
CREATE POLICY service_role_all ON writing_embeddings_v2
    FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON writing_embeddings_v2 FROM anon, authenticated;
