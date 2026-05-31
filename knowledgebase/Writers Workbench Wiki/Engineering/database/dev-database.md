---
name: DEV database
description: Configuration, applied migrations, and current state of the development Supabase project.
type: concept
tags: [database, dev, supabase]
last_reviewed: 2026-05-09
---

# DEV database

**Project URL:** `https://gvbvwcnmjkdpclcisqrr.supabase.co`
**Dashboard label:** "Writers Assistant DEV"
**PostgreSQL version:** 17.x
**Provisioned:** Sprint 10.a (2026-04-20). Cloned from PROD at provisioning time, then divergent.

## Connection

| Use case | Endpoint |
|----------|----------|
| Frontend (anon-key + JWT, RLS-scoped) | `VITE_SUPABASE_URL=https://gvbvwcnmjkdpclcisqrr.supabase.co` |
| Server (service role) | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |
| psql / pg_dump | `postgresql://postgres.gvbvwcnmjkdpclcisqrr:<pwd>@aws-1-us-east-2.pooler.supabase.com:5432/postgres` |

DEV service-role key starts `sb_secret_8GDV…`. Same DB password as PROD (user choice).

## Migrations applied (state as of 2026-05-09)

All of 001-014 + 016-017. Always one or two migrations ahead of PROD because newsletter cluster + Sprint 8 work landed here first.

| # | Title | Applied |
|---|-------|---------|
| 001-008 | (same as PROD) | yes |
| 009 | newsletter ingestion | yes |
| 010 | email bounces | yes |
| 011 | sprint8 RBAC + subscriptions | yes (2026-04-26) |
| 012 | newsletter editions | yes |
| 013 | user-specific ingestion + genre URLs | yes |
| 014 | newsletter templates | yes |
| **015** | (skipped — never written) | n/a |
| 016 | newsletter feed sources + ingestion runs | yes |
| 017 | newsletter logos + subscribers + signoff | yes |

Migration 015 was skipped during the newsletter sprint cluster. Numbering jumps directly from 014 → 016. Don't fill it in retroactively.

## Cloning origin (Sprint 10.a)

DEV was created via:
1. `scripts/clone-supabase-schema.sh` — applied `supabase_setup_v2.sql` + migrations 001-007 to the empty DEV project.
2. `scripts/clone-supabase-data.sh` — `pg_dump --data-only` from PROD → `pg_restore` into DEV (no `--disable-triggers` — Supabase pooler can't disable RI_*).
3. `scripts/migrate-storage.py` — cloned every Supabase Storage bucket + object via REST API (idempotent, 5-way concurrency).
4. **auth.users were populated by manual `auth.admin.createUser` calls** — `pg_dump` doesn't include the `auth` schema. The DEV auth user UUID matches PROD's so `users_v2.supabase_auth_uid` cross-tier links still resolve.

## Auth users on DEV (verified)

```
   user_id    | legacy_role | effective_role
--------------+-------------+----------------
 +14105914612 | admin       | superuser     -- Eric
 +17063338699 | user        | (none)        -- Horace (test user; no subscription row)
```

Same emails + passwords as PROD (user choice). `E2E_TEST_PASSWORD=Fr332bafami!y` works on both tiers.

## Eric's DEV subscription

- tier: `free_full`
- status: `active`
- billing_cycle: `none`
- credits_remaining: `1000` (gets reset to 1000 on monthly_reset cron)

## Active newsletter state on DEV

- 17 baseline feeds seeded into `newsletter_feed_sources_v2` (Sprint S5 newsletter sprint, then expanded in PR #69 for multi-user).
- Multiple test editions in `newsletter_editions_v2` (e.g. "The Workbench").
- Subscribers in `newsletter_subscribers_v2` (CSV import + manual adds).
- Logos uploaded to `newsletter-logos` storage bucket.
- 5 templates in `newsletter_templates_v2` (PR #62, #73).

## DEV-specific state worth knowing

- `app_config_v2` includes a `sprint8_superuser_config` row with the credit-cost overrides for testing.
- `_scanner_exclusions` arrays populated on a few projects (e.g. *The Invisible Wall*) for the drift scanner. Stored at `writing_projects_v2.outline._scanner_exclusions`. See [[chapter-writer-architecture]].
- `outline._character_drift_scan` carries the latest deterministic scan output (Sprint 12 S12-12). Re-runs via `/api/content/:id/annotations`.

## Auth URL configuration on DEV

**Site URL:** `http://localhost:3000` (factory default — same fix needed as PROD)

Pending action:
- Site URL → `https://writersworkbench-develop.up.railway.app`
- Redirect URLs → `https://writersworkbench-develop.up.railway.app/**`

## Backups

Supabase auto-backups same as PROD. Migration changes additionally version-controlled in `writers-workbench/migrations/`.

## DEV vs PROD drift checklist

When asked "what's on DEV that isn't on PROD?":

| Item | On DEV? | On PROD? |
|------|---------|----------|
| Migrations 013, 014, 016, 017 | yes | no |
| Storage buckets `newsletter-ingestion`, `newsletter-logos` | yes | partially (`newsletter-ingestion` from migration 009 yes; `newsletter-logos` no) |
| Newsletter cron workflows (`JAQ8rmCaDoddqt2k`, `7l1z4uMS9kdkYIT4`) | yes (active) | no |
| Drift scanner v4 + LOCKED CHARACTER ROSTER context | yes | yes (promoted via PR #71 hotfix) |
| Story bible extractor in `Worker - Write Chapter` | yes | yes (promoted via PR #71 hotfix) |
| 17 baseline feeds | yes | no (data not promoted) |
| Subscribers / templates / editions | yes (test data) | no (no real users yet) |

Promotion at next release moves all of this. See [[promotion-dev-to-prod]].
