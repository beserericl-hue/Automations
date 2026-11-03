---
name: Migrations log
description: Every migration 001–049, what it does, sprint of origin, and tier-application status (DEV checked 2026-11-03; PROD unverified past 017).
type: concept
tags: [database, migrations]
last_reviewed: 2026-11-03
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
| 013 | `013_user_specific_ingestion_and_genre_urls.sql` | Newsletter (mid-sprint) | Adds `genre_config_v2.genre_urls text[]` (RSS feeds per genre); user-specific scoping for ingestion. | yes | NO? |
| 014 | `014_newsletter_templates.sql` | Newsletter Templates Sprint | `newsletter_templates_v2` (Handlebars body + name + section_order). 5 seeded templates. | yes | NO? |
| 015 | `015_workbench_template_body_md.sql` | Newsletter Templates Sprint | Data only: adds a `{{body_md}}` fallback zone to the seeded Workbench template row (n8n send-time render). (This row used to say "skipped"; the file exists.) | yes | NO? |
| 016 | `016_newsletter_feed_sources.sql` | Multi-User Newsletters PR #69 | `newsletter_feed_sources_v2` (per-user feed URLs) + `newsletter_ingestion_runs_v2` (cron audit). 17 feeds seeded. | yes | NO? |
| 017 | `017_newsletter_logos_subscribers_signoff.sql` | Newsletter Flow Fixes PR #70 | Adds `stamp_url`, `signature_name`, `signature_role`, `cadence`, `cadence_send_time` to `newsletter_editions_v2`. New `newsletter_subscribers_v2` table. New `newsletter-logos` storage bucket. | yes | NO? |
| 018–022 | (never written) | n/a | Numbers skipped. Don't fill in retroactively. | n/a | n/a |
| 023 | `023_engine_approval_mirror.sql` | Engine F2-7 | `newsletter_approvals_v2` compatibility for the engine's HITL gates. | yes | NO? |
| 024 | `024_newsletter_sends_edition_date_unique.sql` | Engine F2 | Unique (edition, date) on `newsletter_sends_v2` — the saga's ON CONFLICT target. | yes | NO? |
| 025 | `025_chapter_qa_telemetry.sql` | CR-005 | `chapter_qa_v2` per-chapter telemetry. | yes | NO? |
| 026 | `026_research_project_link.sql` | CR-006 | `research_report_projects_v2` link table (+ backfill script at `scripts/backfill_research_project_links.py`). | yes | NO? |
| 027 | `027_engine_embedding_match.sql` | Inventory A3 | Vector-match function for engine canon retrieval. | yes (2026-10-16) | NO? |
| 028 | `028_engine_job_runs.sql` | Inventory B6 | `engine_job_runs` run ledger (idempotency). | yes (2026-10-17) | NO? |
| 029 | `029_feed_source_item_type.sql` | Inventory E1 | `newsletter_feed_sources_v2.item_type`. | yes | NO? |
| 030 | `030_passwordless_login_tokens.sql` | Passwordless login | `user_login_tokens_v2`. | yes | NO? |
| 031 | `031_trial_grant_transaction_type.sql` | Auto-trial | `credit_transactions.transaction_type` gains `trial_grant`. | yes | NO? |
| 032 | `032_author_profiles.sql` | Publishing | Author profiles (facts a bio is built from). | yes | NO? |
| 033 | `033_author_pronouns.sql` | Publishing | Pronouns for the author bio. | yes | NO? |
| 034 | `034_reference_photos.sql` | Publishing | `generated_images_v2.image_type` CHECK widened with `reference_photo`. | yes | NO? |
| 035 | `035_landing_page_reservations.sql` | Landing page | `landing_page_reservations_v2`. | yes | NO? |
| 036 | `036_print_orders.sql` | RPI print | `print_orders_v2` + RLS. | yes | NO? |
| 037 | `037_landing_page_mailings.sql` | Landing page | Unsubscribe/mailing columns; `landing_page_mailings_v2`. | yes | NO? |
| 038 | `038_social_schedule_and_radars.sql` | Social port | Post calendar, deliveries, radar subscriptions/runs/topics/video archive; widens a feed-source CHECK. | yes | NO? |
| 039 | `039_sprint9_stripe.sql` | Sprint 9 | Stripe customers/events/print offers; alters tiers, subscriptions, credit transactions, print orders. **Never add a second FK `user_subscriptions` → `subscription_tiers`.** | yes | NO? |
| 040 | `040_rls_writing_embeddings.sql` | Security | RLS on `writing_embeddings_v2`. | yes | NO? |
| 041 | `041_newsletter_issue_numbers.sql` | Item 5, PR #225 | Per-edition issue numbers (trigger, partial unique index, peek RPC); backfills existing sends and their "Issue #1" text. | yes | NO |
| 042 | `042_social_schedule_humanize.sql` | Item 6, PR #231 | `social_schedule_v2.humanize` JSONB. | yes | NO |
| 043 | `043_user_integrations.sql` | PR #235 | `user_integrations_v2` (AES-GCM secrets, service role only); moves the Blotato account id off `social_channels_v2.config`. | yes | NO |
| 044 | `044_cost_recording.sql` | PR #237 | ~15 cost columns on `token_usage_v2`, `cost_source` CHECK, unique (provider, request_id), reprice, `token_usage_breakdown()`. **Drops policy `"Own data only"` on `token_usage_v2`.** | yes | NO |
| 045 | `045_app_config_global.sql` | Item 8, PR #240 | `app_config_global_v2`. | yes | NO |
| 046 | `046_token_usage_owner_backfill.sql` | PR #253 | Data: owner on newsletter + ingestion cost rows (213 DEV rows tagged `owner_backfill`). | yes | NO |
| 047 | `047_token_usage_reprice_n8n_rows.sql` | PR #259 | Data: price n8n-era rows; provider `google` → `gemini`. | yes | NO |
| 048 | `048_token_usage_labels.sql` | PR #258 | `token_usage_v2_default_labels` insert trigger; DEV-shaped backfill (filters `created_at >= 2026-11-02`). | yes | NO |
| 049 | `049_token_usage_provider_alias.sql` | PR #259 | Provider aliasing in the 048 trigger function. Requires 048. | yes | NO |

"NO?" = recorded as DEV-only everywhere, but nobody has dumped the PROD schema since May. 041–049 were
written after PROD's last deploy, so they cannot be there. DEV status above was checked 2026-11-03 by
querying for each migration's objects.

## Pending PROD migrations (release-blockers)

Everything after 012, in file order, once a `pg_dump --schema-only` of PROD shows what is really there.
The ordered list with a note per migration is section B of
[`writers-workbench/docs/prod-release-checklist.md`](../../../../writers-workbench/docs/prod-release-checklist.md).
Before applying:

```bash
# Verify schema governance still passes
python3 scripts/check-base-table-immutability.py

# Connect to the PROD pooler (credentials from Railway; never typed into a file)
psql "$PROD_DATABASE_URL" -f writers-workbench/migrations/013_user_specific_ingestion_and_genre_urls.sql
```

The n8n promotion script is no longer the release path: the release is an engine cutover. See
[[promotion-dev-to-prod]] for the n8n side.

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
