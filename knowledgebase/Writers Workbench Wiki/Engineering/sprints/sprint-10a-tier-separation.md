---
name: Sprint 10.a — V1/DEV/PROD tier separation
description: Reframed mid-sprint from blue-green cutover to a stable two-tier model (V1 frozen + DEV active + PROD frozen-except-promotion). Foundational for everything since.
type: concept
tags: [sprints, sprint-10a, tier-separation]
last_reviewed: 2026-05-09
---

# Sprint 10.a — V1/DEV/PROD tier separation

**Released:** v1.1.0 (2026-04-28).
**PRs:** #5, #6, #7 (deploy markers), [#8](https://github.com/beserericl-hue/Automations/pull/8) (bulk: governance docs, scripts, workflow renames/clones, isolation test), #9 (CLAUDE.md note re: tier-specific Railway env vars).

## What changed

We reframed the original blue-green cutover plan into a simpler two-tier model after realizing mid-sprint that the blue-green pattern conflicted with how the user thought about the system. End state:

- **PROD tier** = what real users hit. Never modified during a sprint except by hotfix or release-time promotion.
- **DEV tier** = a parallel copy of everything for developer use. All sprint work happens here.

The two tiers are isolated across every layer: database, n8n workflows, Railway services, ElevenLabs agent.

## Databases (Supabase)

| | URL | Label | Notes |
|--|--|--|--|
| PROD | `faklxfakgzkpkbxfihzh.supabase.co` | "Writers Assistant PROD" | Unchanged. Production users' data lives here. |
| DEV | `gvbvwcnmjkdpclcisqrr.supabase.co` | "Writers Assistant DEV" | New project. Cloned from PROD via `clone-supabase-{schema,data}.sh` + `migrate-storage.py` (byte-identical row counts + storage). |

Session-pooler endpoints (needed for psql / pg_dump — direct `db.*` hosts are IPv6-only on new Supabase projects):
- PROD: `postgres.faklxfakgzkpkbxfihzh@aws-0-us-west-2.pooler.supabase.com:5432/postgres`
- DEV: `postgres.gvbvwcnmjkdpclcisqrr@aws-1-us-east-2.pooler.supabase.com:5432/postgres`

Postgres 17 — use `postgresql@17` brew cask. v15 client refuses to dump from v17.

`auth.users` was populated by manual admin API call (Supabase auth schemas aren't cloned by `pg_dump`). DEV auth user has same UUID as PROD so `users_v2.supabase_auth_uid` still links.

## n8n workflows

24 `PROD - <name>` workflows (renamed from V2 suffix). Webhook `/webhook/author_request_v2`. IDs unchanged.

24 `DEV - <name>` workflows — clones with:
- DEV Supabase URL/key substituted
- Webhook paths rewritten `_v2` → `_dev`, `-v2` → `-dev`
- `executeWorkflow` / `toolWorkflow` refs rewired so DEV workflows only call sibling DEV workflows
- `webhookId`s regenerated to avoid activation collisions with PROD

All 48 active. Full PROD↔DEV id map in [`scripts/workflow-id-map.json`](../../../../scripts/workflow-id-map.json). See [[workflow-id-map]].

DEV hub webhook: `/webhook/author_request_dev`.
DEV brainstorm webhook: `/webhook/brainstorm_story_dev`.

## ElevenLabs

- **PROD Eve** `agent_2801kks580vnf5q80j3bd0n0x45v` — renamed to `Writing Assistant PROD`. Tool `tool_2301kksb78ygewvv3q3cm82wcfjs` (`forward_writing_request_v2`).
- **DEV Eve** `agent_0001kpr667v6ffctex0a8dt4fk71` — `Writing Assistant Dev`. Dedicated tool `tool_0801kprf5a14ee9b5ts7b8d2tetf` (`forward_writing_request_dev`).
- DEV agent used to share PROD's tool — now has its own. Pre-fix, DEV calls hit PROD webhook (real bug).

## Railway

Two services in `bubbly-solace`, one per environment:
- `writersworkbench-production.up.railway.app` → PROD Supabase, PROD webhooks, NODE_ENV=production
- `writersworkbench-develop.up.railway.app` → DEV Supabase, DEV webhooks, NODE_ENV=development

Each env has its own Redis service (added late in sprint):
- Production env: `Redis`
- Development env: `Redis_Dev`

`REDIS_URL` env vars use reference syntax: `${{Redis.REDIS_PRIVATE_URL}}` / `${{Redis_Dev.REDIS_PRIVATE_URL}}` — exact service-name match matters.

`/api/health` now returns `version`, `deployed_at`, `environment`, `checks.{supabase,redis}`. Environment derived from NODE_ENV.

**ALLOWED_ORIGINS gotcha:** must equal the service's own public URL, otherwise crossorigin JS/CSS requests 500 and the page appears blank. Documented in `CLAUDE.md`.

## Governance (CI-enforced)

- `CLAUDE.md` — three-tier baseline protection (V1 frozen, PROD frozen except release/hotfix, DEV active).
- `writers-workbench/docs/workflow-governance.md` — DEV→PROD promotion flow, hotfix flow, what-breaks-if-you-ignore-it.
- `writers-workbench/docs/schema-governance.md` — 9 base tables immutable (7 named + content_versions_v2 + outline_versions_v2). Migrations 008+ may not `ALTER`/`DROP`/`RENAME` base tables. Migrations 001-007 frozen (SHA-256 pinned in `.baseline-hashes.json`).
- `scripts/check-base-table-immutability.py` + `scripts/test-check-base-table-immutability.sh` enforce above.
- Wired into GitHub Actions as `Schema Governance Check` job; required on `main` (4 required checks total).

## Scripts added (all in `scripts/`)

- `clone-supabase-schema.sh` — apply `supabase_setup_v2.sql` + numbered migrations to a target DB.
- `clone-supabase-data.sh` — `pg_dump --data-only` → `pg_restore`. No `--disable-triggers` (Supabase pooler can't disable RI_*).
- `migrate-storage.py` — clone every Supabase Storage bucket/object via REST API. Idempotent, 5-way concurrency.
- `clone-prod-to-dev.py` — idempotent workflow cloner. Runs PROD → DEV transformation: creds, webhook paths, executeWorkflow refs, webhookIds.
- `promote-dev-to-prod.py` — release-time promotion. Default `--dry-run`. Reverses transformations.
- `verify-env-isolation.py` — 3-layer system test (workflow config / data isolation / Railway env). All 3 currently pass.
- `check-base-table-immutability.py` + test runner — schema governance CI.
- `workflow-id-map.json` — authoritative PROD id → DEV id table (24 entries).

## Per-tier env vars (lessons learned the hard way)

| Variable | DEV | PROD | Failure mode |
|----------|-----|------|--------------|
| `ALLOWED_ORIGINS` | dev URL | prod URL | CORS 500 → blank page |
| `NODE_ENV` | development | production | health check reports wrong tier |
| `SUPABASE_URL` / keys | DEV | PROD | DEV writes land in PROD or vice versa |
| `VITE_N8N_WEBHOOK_URL` | `_dev` suffix | `_v2` suffix | cross-tier hub call |
| `N8N_HUB_WEBHOOK_URL` | `_dev` | `_v2` | async jobs cross-tier |

This list is in `CLAUDE.md` because we hit several of these during the v1.1.0 release (PR #9 added it). See [[hotfixes]].

## What it enables

- Sprint work touches DEV only. PROD users see no in-progress code.
- Promotion script gives a controlled DEV→PROD transition.
- Hotfixes apply to PROD then mirror back to DEV.
- Verify-env-isolation script catches cross-tier wiring before it reaches users.

## What broke during the rollout

1. **Cross-tier wiring on PR #9 release**: `N8N_HUB_WEBHOOK_URL` had `_dev` on PROD. Caught before user traffic.
2. **`SENDER_NAME=The Writers Workbench (Dev)`** copied to PROD. Cosmetic; fixed mid-release.
3. **Auth Site URL** was factory default `localhost:3000` on both tiers. Password reset emails landed on dead local addresses. Pending fix in Supabase Dashboard.
4. **`webhookId` collisions** when cloning workflows — fixed by `clone-prod-to-dev.py` regenerating all webhookIds.
5. **n8n PUT settings rejection** — only `executionOrder` accepted. Strip allowlist.

## Verify-env-isolation snapshot at session end

3/3 layers green. Run periodically:
```bash
python3 scripts/verify-env-isolation.py
```

## Tests

`server/src/test/sprint10a-*.test.ts` and `e2e/` cover environment health checks, governance enforcement, deploy markers.
