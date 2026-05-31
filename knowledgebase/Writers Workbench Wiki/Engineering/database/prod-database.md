---
name: PROD database
description: Configuration, applied migrations, and current state of the production Supabase project.
type: concept
tags: [database, prod, supabase]
last_reviewed: 2026-05-09
---

# PROD database

**Project URL:** `https://faklxfakgzkpkbxfihzh.supabase.co`
**Dashboard label:** "Writers Assistant PROD"
**PostgreSQL version:** 17.x

## Connection

| Use case | Endpoint |
|----------|----------|
| Frontend (anon-key + JWT, RLS-scoped) | `VITE_SUPABASE_URL=https://faklxfakgzkpkbxfihzh.supabase.co` |
| Server (service role, bypasses RLS) | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |
| psql / pg_dump (session pooler — IPv6 not required) | `postgresql://postgres.faklxfakgzkpkbxfihzh:<pwd>@aws-0-us-west-2.pooler.supabase.com:5432/postgres` |

PROD service-role key starts `sb_secret_huxH…`.

## Migrations applied (as of v1.1.0 release 2026-04-28)

001 → 012, applied via session pooler during release. All idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, etc.).

| # | Title | Status |
|---|-------|--------|
| 001 | role column | applied (frozen baseline) |
| 002 | sprint1 data integrity (FK cascades, soft delete cols) | applied |
| 003 | sprint3 outline versioning (trigger) | applied |
| 004 | cascade delete project content | applied |
| 005 | sprint4 images_social tables | applied |
| 006 | sprint5 token usage table | applied |
| 007 | atomic chapter outline | applied |
| 008 | job queue (`job_queue_v2`) | applied |
| 009 | newsletter ingestion (`content_ingestion_v2`, `newsletter_approvals_v2`, `newsletter_sends_v2`) | applied |
| 010 | email bounces | applied |
| 011 | sprint8 RBAC + subscriptions (6 new tables) | applied |
| 012 | newsletter editions | applied |

**Not yet applied to PROD:**
- 013 — user-specific ingestion + genre URLs
- 014 — newsletter templates
- 016 — newsletter feed sources + ingestion runs
- 017 — newsletter logos + subscribers + signoff

These migrations are DEV-only as of 2026-05-09. They will land at the next release-day promotion. See [[newsletter-cluster]].

## Auth users on PROD (verified 2026-04-28)

```
   user_id    | legacy_role | effective_role | notes
--------------+-------------+----------------+----------------------------
 +14105914612 | admin       | superuser      | Eric — superuser
 +17063338699 | user        | (none)         | Horace / JR (race)
                                              auth UID linked 2026-04-28
                                              after admin-create gap
```

5 subscription tiers seeded (`subscription_tiers`):
- `trial` — 200/mo, 30d, 0¢ (default for self-signup, optional)
- `standard` — 100/mo, $19.99/mo or $199/yr (default for self-signup)
- `pro` — 500/mo, $49.99/mo or $499/yr, all features
- `paid_full` — 1000/mo, $49.99/mo or $499/yr
- `free_full` — 1000/mo, 0¢ (admin-provisioned only — `publicly_selectable=false`)

Eric has a `free_full` subscription with 1000/1000 credits.

## PROD-only state worth knowing

- `users_v2.role` legacy column has CHECK constraint that doesn't accept `'superuser'`. Effective role is computed via `COALESCE(user_role_meta_v2.role, users_v2.role, 'user')`. Migration 011 seed inserted `user_role_meta_v2.role='superuser'` for Eric with the legacy column staying `admin`.
- `app_config_v2` rows include `recipient_email`, `bcc_email`, and `sprint8_superuser_config` JSONB (credit costs, tier defaults).
- 2 Schema Editor views (`content_metrics_v2`, `token_usage_daily_v2`) exist but are not in any migration file. Catch them via `pg_dump --schema-only` if cloning.

## Storage buckets on PROD

| Bucket | Status |
|--------|--------|
| `author-content` | Active (legacy V1 + ongoing) |
| `cover-images` | Active since Sprint 4 |
| `social-images` | Active since Sprint 4 |
| `writing-samples` | Active since Sprint 4 |
| `newsletter-ingestion` | NOT YET (migration 009 applied, but ingestion endpoints not wired) |
| `newsletter-logos` | NOT YET (migration 017 not applied) |

See [[supabase-storage]].

## Auth URL configuration

**Site URL:** `http://localhost:3000` (FACTORY DEFAULT — needs to be changed)
**Redirect URLs:** none beyond default

Password-reset / magic-link emails embed Site URL → users land on `http://localhost:3000`. **Pending fix** in Supabase Dashboard:
- Site URL → `https://writersworkbench-production.up.railway.app`
- Redirect URLs → `https://writersworkbench-production.up.railway.app/**`

See [[hotfixes]] (2026-04-28 entry).

## Backups

Supabase Pro plan auto-backs up daily. PITR (point-in-time-recovery) enabled. Manual snapshots taken at every release via `pg_dump --schema-only` for drift detection.

## Schema governance enforcement

Every migration runs through `scripts/check-base-table-immutability.py` in CI (`Schema Governance Check` job, required on `main`). Migrations 001-007 have SHA-256 pins in `writers-workbench/migrations/.baseline-hashes.json` — any byte change fails. Migrations 008+ may not `ALTER`/`DROP`/`RENAME` a [[base-tables|base table]].
