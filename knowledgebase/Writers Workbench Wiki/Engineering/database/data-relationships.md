---
name: Data relationships
description: FK graph, cascade rules, and known orphan risks across the schema.
type: concept
tags: [database, schema, fk]
last_reviewed: 2026-05-09
---

# Data relationships

## Entity hierarchy

```
users_v2 (ROOT)
├── user_account_meta_v2          PK=user_id, CASCADE
├── user_role_meta_v2             PK=user_id, CASCADE
├── user_subscriptions            PK=user_id, CASCADE  (UNIQUE so 1:1)
├── credit_transactions           FK=user_id, CASCADE
├── impersonation_log             FK=superuser_id + target_user_id
├── genre_config_v2               FK=user_id, CASCADE  (or NULL=public)
├── story_arcs_v2                 FK=user_id, CASCADE  (or NULL=public)
├── writing_projects_v2           FK=user_id, CASCADE
│   ├── story_bible_v2            FK=project_id, CASCADE
│   ├── outline_versions_v2       FK=project_id, CASCADE  (auto-snapshot trigger)
│   └── published_content_v2      FK=project_id, SET NULL  (Sprint 1 fix)
│       └── content_versions_v2   FK=content_id, CASCADE
├── research_reports_v2           FK=user_id, CASCADE  AND  FK=project_id, SET NULL
├── generated_images_v2           FK=user_id, CASCADE
├── social_posts_v2               FK=user_id, CASCADE
├── token_usage_v2                FK=user_id, CASCADE
├── job_queue_v2                  FK=user_id, CASCADE
├── email_bounces_v2              FK=user_id, CASCADE
│
├── content_ingestion_v2          FK=user_id, CASCADE
├── newsletter_editions_v2 (DEV)  FK=user_id, CASCADE
├── newsletter_feed_sources_v2 (DEV) FK=user_id, CASCADE
├── newsletter_ingestion_runs_v2 (DEV) FK=user_id, CASCADE
├── newsletter_subscribers_v2 (DEV) FK=edition_id (which FKs to edition→user)
├── newsletter_templates_v2 (DEV) FK=user_id, CASCADE  (or NULL=public default)
├── newsletter_approvals_v2       FK=user_id, CASCADE  AND  FK=send_id (newsletter_sends_v2)
└── newsletter_sends_v2           FK=user_id, CASCADE  AND  FK=edition_id (DEV)
```

## Cascade-on-user-delete

Deleting a `users_v2` row triggers cascades down everything. The `DELETE /api/account` endpoint (Sprint 3-7) uses this:

```ts
// server/src/routes/account.ts
const { error } = await supabaseAdmin
  .from('users_v2')
  .delete()
  .eq('user_id', req.userId);
// then supabase.auth.admin.deleteUser(authUid)
```

Both happen in sequence; the `auth.users` row is deleted second so a partial failure doesn't orphan an auth principal with no profile.

## Cascade-on-project-delete

```
DELETE FROM writing_projects_v2 WHERE id = 'xxx'
  → CASCADE story_bible_v2 (entries gone)
  → CASCADE outline_versions_v2 (history gone)
  → SET NULL on published_content_v2.project_id (chapters survive but disconnect)
  → SET NULL on research_reports_v2.project_id (research survives)
```

The `SET NULL` for content + research was a Sprint 1 fix. Originally those FKs had no cascade — deleting a project orphaned chapters silently. Now the chapters are kept (the user might have gotten value out of them) but visually-disconnected.

The `ProjectDetail` delete UI (Sprint 1) shows a cascade-impact dialog before confirming so the user knows what they're losing.

## Soft delete

Sprint 1 added `deleted_at timestamptz` to:
- `users_v2` (technically — never used; account deletion is hard)
- `writing_projects_v2`
- `published_content_v2`
- `story_bible_v2`
- `research_reports_v2`
- `genre_config_v2` (private only)
- `story_arcs_v2` (private only)

Pattern: deletes go through `UPDATE … SET deleted_at = now()`. Reads filter `.is('deleted_at', null)`. The `TrashView` (Sprint 1 S1-3) shows soft-deleted rows with a Restore button (`UPDATE … SET deleted_at = NULL`).

## Known orphan risks

| Risk | Where | Mitigation |
|------|-------|-----------|
| `genre_slug` is text-only (no FK) | `writing_projects_v2.genre_slug`, `published_content_v2.genre_slug`, `research_reports_v2.genre_slug` | Genre delete (Sprint 3 S3-5) checks reference count first; cascade-info dialog warns |
| `cover_image_path` text reference to storage object | `published_content_v2.cover_image_path` | No verification; if storage object deleted manually, ContentDetail shows broken image |
| `qa_report` and `genre_eval` in `metadata` JSONB | `published_content_v2.metadata` | Stored inline in JSON; no orphan risk but no schema either |
| `metadata.last_rewrite.research_report_id` | `published_content_v2.metadata` | Soft text reference; deleting the research report doesn't update metadata |
| `outline._character_drift_scan` JSONB | `writing_projects_v2.outline` | Self-contained; no cross-table FK |

## 1:1 vs 1:N

| Relation | Cardinality |
|----------|-------------|
| user → user_subscriptions | 1:1 (UNIQUE constraint) |
| user → user_role_meta_v2 | 1:1 (PK on user_id) |
| user → user_account_meta_v2 | 1:1 |
| user → writing_projects_v2 | 1:N |
| project → published_content_v2 | 1:N (chapters per project) |
| project → story_bible_v2 | 1:N |
| project → outline_versions_v2 | 1:N |
| content → content_versions_v2 | 1:N |
| user → credit_transactions | 1:N |
| superuser → impersonation_log (active) | 1:1 (partial UNIQUE) |
| edition → newsletter_subscribers_v2 | 1:N |
| edition → newsletter_sends_v2 | 1:N |
| send → newsletter_approvals_v2 | 1:1 (typically) |

## Cross-table integrity outside FK

**Story bible dedup:** `story_bible_v2` has no UNIQUE constraint. Sprint 12 hotfix adds dedup logic in the `extract_bible_*` chain via `(entry_type, lower(name))` lookup before INSERT. Re-runs of the extractor on the same chapter won't duplicate.

**Drift scan exclusions:** `outline._scanner_exclusions string[]` is a per-project escape hatch list of names that the deterministic drift scanner ignores ("Yick Wo", "Justice Brennan", etc.). Editing it requires `outline` JSONB write — no UI yet.

**Annotation dismissed list:** `metadata.dismissed_annotations: string[]` on each `published_content_v2` row stores annotation IDs the user dismissed so they don't re-surface on re-scan.

## Adding a new feature attribute

Follow the meta-table pattern (see [[base-tables]]):

1. Pick a number for your migration (next unused; current is 017 → use 018).
2. `CREATE TABLE IF NOT EXISTS <feature>_meta_v2 (user_id text PK REFERENCES users_v2(user_id) ON DELETE CASCADE, …)`.
3. Add RLS via `get_current_user_id()` policy.
4. Index FK columns.
5. Update [[migrations]] table here + this page if it adds a new relationship.
6. Update [[base-tables]] meta-table list.

Don't `ALTER` a base table for a new column. The CI check will fail.
