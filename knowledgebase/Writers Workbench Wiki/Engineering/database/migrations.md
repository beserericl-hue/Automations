---
name: Migrations log
description: Every migration 001–017, what it does, sprint of origin, and tier-application status.
type: concept
tags: [database, migrations]
last_reviewed: 2026-05-09
---

# Migrations log

Migration files live in `writers-workbench/migrations/`. Naming `NNN_<topic>.sql`. SHA-256 pins for 001–007 in `.baseline-hashes.json` (CI enforces).

| # | File | Sprint | Description | DEV applied | PROD applied |
|---|------|--------|-------------|-------------|--------------|
| 001 | `001_add_role_column.sql` | Sprint 0 baseline | Adds `users_v2.role` column with CHECK ('user','admin','viewer'). Frozen baseline. | yes (cloned) | yes (frozen) |
| 002 | `002_sprint1_data_integrity.sql` | Sprint 1 | FK cascades fixed (SET NULL on `published_content_v2.project_id`); soft-delete `deleted_at` columns added across base tables; `discovery_question` added to `story_arcs_v2`. | yes | yes |
| 003 | `003_sprint3_outline_versioning.sql` | Sprint 3 | Postgres trigger `trg_snapshot_outline` on `writing_projects_v2.outline` → INSERT into `outline_versions_v2`. | yes | yes |
| 004 | `004_cascade_delete_project_content.sql` | Sprint 1 follow-up | Fixes cascade rules for `published_content_v2.project_id`. | yes | yes |
| 005 | `005_sprint4_images_social.sql` | Sprint 4 | `generated_images_v2` + `social_posts_v2` tables; storage buckets `cover-images`, `social-images`, `writing-samples`. | yes | yes |
| 006 | `006_sprint5_token_usage.sql` | Sprint 5 | `token_usage_v2` table + `token_usage_daily_v2` view (Schema-Editor view, also in PROD). | yes | yes |
| 007 | `007_atomic_chapter_outline.sql` | Sprint 5 | Atomic write helper for chapter outline updates (race-free patch). | yes | yes |
| **008** | `008_job_queue.sql` | Sprint 10b-2 | `job_queue_v2` BullMQ audit table. RLS, FK cascade. **First migration covered by base-table-immutability check.** | yes | yes |
| 009 | `009_newsletter_ingestion.sql` | Newsletter S2 | `content_ingestion_v2`, `newsletter_approvals_v2`, `newsletter_sends_v2`. Bucket `newsletter-ingestion`. RLS on all three. | yes | yes |
| 010 | `010_email_bounces.sql` | Sprint 11 S11-5 | `email_bounces_v2` for Postal webhook. Bounce auto-flips `newsletter_subscribers_v2.status='bounced'`. | yes | yes |
| 011 | `011_sprint8_rbac_subscriptions.sql` | Sprint 8 | 6 tables: `user_account_meta_v2`, `user_role_meta_v2`, `subscription_tiers` (5 seeded), `user_subscriptions`, `credit_transactions`, `impersonation_log`. Trigger `prevent_role_meta_escalation`. Helper functions `is_admin_v2`, `is_superuser_v2`, `is_account_active_v2`, `get_user_effective_role_v2`. | yes (2026-04-26) | yes (2026-04-28 release) |
| 012 | `012_newsletter_editions.sql` | Newsletter S3 (multi-user) | `newsletter_editions_v2` for per-user newsletter identity (name, sender_name, schedule, intro). | yes | yes |
| 013 | `013_user_specific_ingestion_and_genre_urls.sql` | Newsletter (mid-sprint) | Adds `genre_config_v2.genre_urls text[]` (RSS feeds per genre); user-specific scoping for ingestion. | yes | NO |
| 014 | `014_newsletter_templates.sql` | Newsletter Templates Sprint | `newsletter_templates_v2` (Handlebars body + name + section_order). 5 seeded templates. | yes | NO |
| **015** | (skipped) | n/a | Number reserved but never written. Don't fill in retroactively. | n/a | n/a |
| 016 | `016_newsletter_feed_sources.sql` | Multi-User Newsletters PR #69 | `newsletter_feed_sources_v2` (per-user feed URLs) + `newsletter_ingestion_runs_v2` (cron audit). 17 feeds seeded. | yes | NO |
| 017 | `017_newsletter_logos_subscribers_signoff.sql` | Newsletter Flow Fixes PR #70 | Adds `stamp_url`, `signature_name`, `signature_role`, `cadence`, `cadence_send_time` to `newsletter_editions_v2`. New `newsletter_subscribers_v2` table. New `newsletter-logos` storage bucket. | yes | NO |

## Pending PROD migrations (release-blockers)

These four (013, 014, 016, 017) are slated for the next release-day promotion. Run order is the file order. Before applying:

```bash
# Verify schema governance still passes
python3 scripts/check-base-table-immutability.py

# Connect to PROD pooler
PGPASSWORD=… /usr/local/opt/postgresql@17/bin/psql \
  "postgresql://postgres.faklxfakgzkpkbxfihzh:…@aws-0-us-west-2.pooler.supabase.com:5432/postgres" \
  -f writers-workbench/migrations/013_user_specific_ingestion_and_genre_urls.sql

# Repeat for 014, 016, 017
```

Then re-run `scripts/promote-dev-to-prod.py` for the n8n workflow side. See [[promotion-dev-to-prod]].

## Migration authoring rules

Per `writers-workbench/docs/schema-governance.md`:

1. **Filename**: `NNN_<feature_topic>.sql` — incrementing zero-padded number.
2. **Idempotent**: use `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `INSERT … ON CONFLICT DO NOTHING`, etc. PROD applies are not transactional across multiple migrations; if one half-applies, the rest of that file must be safe to re-run.
3. **Additive only** for migrations ≥008 against base tables.
4. **No data deletes** without explicit user permission. Soft delete via `UPDATE … SET deleted_at = now()` instead.
5. **RLS**: every new table gets RLS enabled and at least an own-row SELECT + ALL policy via `get_current_user_id()`. Service role bypasses.
6. **Indexes**: index every FK column. Index `(deleted_at)` if soft-delete supported.
7. **Tests**: add at least a smoke test in `server/src/test/` that exercises an INSERT + RLS-scoped SELECT.
8. **Pre-commit check**: `python3 scripts/check-base-table-immutability.py` should pass. Also runs in CI.

## Common gotchas

- **Migration runs are NOT in transactions across files.** Each file may break partway and leave you in a half-state. Idempotency rescues you; non-idempotent statements don't.
- **Service role bypasses RLS — but doesn't bypass triggers**, so `prevent_role_meta_escalation` still fires unless `auth.uid() IS NULL`. Service role calls have `auth.uid() = NULL`, so the trigger correctly bypasses for them.
- **Supabase Schema Editor changes don't appear in `migrations/`.** Two views (`content_metrics_v2`, `token_usage_daily_v2`) drifted. Catch via `pg_dump --schema-only` diff before any clone.
- **`CREATE OR REPLACE` on functions/triggers that base tables depend on** is forbidden. If you need to swap, write a parallel function (`is_admin_v2()` instead of overwriting `is_admin()`).

See [[base-tables]] for the immutability rule details and [[rls-policies]] for RLS templates.
