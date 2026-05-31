---
name: RLS policies
description: Row-Level Security policy template, public-read tables, service-role bypass, and the `get_current_user_id()` translation function.
type: concept
tags: [database, rls, security]
last_reviewed: 2026-05-09
---

# RLS policies

Every `*_v2` user-data table has RLS enabled. Three patterns:

## 1. Own-row table (most common)

```sql
ALTER TABLE writing_projects_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY writing_projects_select_own ON writing_projects_v2
  FOR SELECT USING (user_id = get_current_user_id());

CREATE POLICY writing_projects_all_own ON writing_projects_v2
  FOR ALL USING (user_id = get_current_user_id());
```

`get_current_user_id()` (defined in `supabase_auth_migration.sql`):

```sql
CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid()
$$;
```

`auth.uid()` is the Supabase Auth UUID. The function looks up the corresponding `users_v2.user_id` (phone). `STABLE` allows planner caching.

## 2. Public-read table

```sql
CREATE POLICY genre_config_select_public ON genre_config_v2
  FOR SELECT USING (is_public = true OR user_id = get_current_user_id());

CREATE POLICY genre_config_modify_own ON genre_config_v2
  FOR INSERT WITH CHECK (user_id = get_current_user_id());

CREATE POLICY genre_config_update_own ON genre_config_v2
  FOR UPDATE USING (user_id = get_current_user_id());
```

Tables with this pattern:
- `genre_config_v2`
- `story_arcs_v2`
- `subscription_tiers` (selectable by anyone for the signup pricing page; only superuser can write)

## 3. Indirect ownership (via FK)

```sql
CREATE POLICY story_bible_select_via_project ON story_bible_v2
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM writing_projects_v2 WHERE user_id = get_current_user_id()
    )
  );
```

Used for tables whose ownership is determined by a parent. `story_bible_v2`, `outline_versions_v2`, `content_versions_v2` follow this pattern.

## 4. Service-role bypass

Service role (used by Express server) bypasses ALL RLS automatically. `auth.uid()` returns NULL, so policies that reference `get_current_user_id()` simply don't apply.

**Implication:** server routes using service-role client MUST add ACL checks in code:

```ts
// routes/admin.ts (NOT impersonating, normal admin scope)
const userRow = await supabaseAdmin.from('users_v2')
  .select('*')
  .eq('user_id', req.params.userId)   // explicit user filter
  .maybeSingle();
```

Forgetting `.eq('user_id', req.userId)` on a service-role query is a privilege escalation. Auth middleware sets `req.userId` so it's the impersonation-aware id when impersonating.

## Special policies

### `user_role_meta_v2`

Trigger `prevent_role_meta_escalation` (BEFORE INSERT/UPDATE/DELETE):
- If `auth.uid() IS NULL` (service role): allow.
- Else: check that the calling user has effective role = superuser. Else RAISE EXCEPTION.

This means even a leaked admin JWT can't grant superuser; only the service role or another superuser can write to this table.

### `impersonation_log`

UNIQUE active session per superuser via partial index:

```sql
CREATE UNIQUE INDEX impersonation_active_unique
  ON impersonation_log (superuser_id)
  WHERE ended_at IS NULL;
```

This is the gate that `requireAuth` checks before honoring `X-Impersonate-User` header.

## Per-table RLS status (current)

| Table | RLS | Public read? | Notes |
|-------|-----|--------------|-------|
| users_v2 | yes | no | Self-row only |
| writing_projects_v2 | yes | no | |
| published_content_v2 | yes | no | |
| story_bible_v2 | yes | no | Indirect via project |
| research_reports_v2 | yes | no | |
| genre_config_v2 | yes | yes (`is_public=true`) | |
| story_arcs_v2 | yes | yes (`is_public=true`) | |
| outline_versions_v2 | yes | no | Indirect |
| content_versions_v2 | yes | no | Indirect |
| token_usage_v2 | yes | no | |
| generated_images_v2 | yes | no | |
| social_posts_v2 | yes | no | |
| job_queue_v2 | yes | no | |
| subscription_tiers | yes | yes (`publicly_selectable=true`) | Read-only for non-superuser |
| user_subscriptions | yes | no | |
| user_role_meta_v2 | yes (+ trigger) | no | |
| user_account_meta_v2 | yes | no | |
| credit_transactions | yes | no | |
| impersonation_log | yes | no | Superuser-only |
| email_bounces_v2 | yes | no | |
| content_ingestion_v2 | yes | no | |
| newsletter_approvals_v2 | yes | no | |
| newsletter_sends_v2 | yes | no | |
| newsletter_editions_v2 | yes | no | DEV only |
| newsletter_feed_sources_v2 | yes | no | DEV only |
| newsletter_ingestion_runs_v2 | yes | no | DEV only |
| newsletter_subscribers_v2 | yes | no | DEV only |
| newsletter_templates_v2 | yes | yes (default templates) | DEV only |

## Storage buckets RLS

Supabase Storage uses separate policies. See [[supabase-storage]]. Pattern:

```sql
CREATE POLICY "Users upload to own folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'cover-images'
    AND (storage.foldername(name))[1] = get_current_user_id()
  );
```

`(storage.foldername(name))[1]` extracts the first path segment, expected to be the `user_id`. So a path like `+14105914612/2026-04-25-cover.png` is owned by `+14105914612`.

## Common gotchas

- **`auth.uid()` returns NULL outside an authenticated session.** Don't write policies that depend on a non-NULL value being meaningful.
- **`USING` vs `WITH CHECK`**: `USING` filters which rows the user can see/modify; `WITH CHECK` validates new/modified row values (mostly for `INSERT` and `UPDATE`). Both must pass for a write.
- **Indirect-FK policies are slow** for large tables; use only when there's a meaningful index on the FK.
- **Service role + missing ACL = privilege escalation.** Code review every service-role query for `.eq('user_id', req.userId)` (or equivalent scoping).
- **Trigger functions must be `SECURITY DEFINER`** if they need to query `users_v2` from a non-owner context. `get_current_user_id()` is `SECURITY DEFINER`.
