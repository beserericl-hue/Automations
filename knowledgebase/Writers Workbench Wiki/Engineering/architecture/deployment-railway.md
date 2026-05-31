---
name: Deployment (Railway)
description: Railway services, deploy refs, env vars, health checks, build pipeline, and the gotchas that have bitten releases.
type: concept
tags: [deployment, railway, ops]
last_reviewed: 2026-05-09
---

# Deployment

## Two Railway projects

| Project | Services | Notes |
|---------|----------|-------|
| `bubbly-solace` | Workbench (PROD), Workbench (DEV), Redis, Redis_Dev | App services + queue infra |
| `N8N-MCP` | postal-web, postal-worker, postal-mariadb | Postal mail stack (single instance — both tiers share, isolated by mail-server credentials) |

## Workbench services

| Service | Public URL | NODE_ENV | Tracks | Supabase | Redis | n8n |
|---------|-----------|----------|--------|----------|-------|-----|
| `WritersWorkbench` (PROD) | `writersworkbench-production.up.railway.app` | `production` | `release/v1.0` (Railway watches this) | PROD `faklxfakgzkpkbxfihzh` | `Redis` | `_v2` webhooks |
| `WritersWorkbenchDev` | `writersworkbench-develop.up.railway.app` | `development` | `develop` | DEV `gvbvwcnmjkdpclcisqrr` | `Redis_Dev` | `_dev` webhooks |

**Critical:** Railway PROD deploys from `release/v1.0`, NOT `main`. The branch is misleadingly named — it now carries v1.1 — but Railway watches it. Release-day checklist: after merging `release/v1.X` → `main` and tagging, run:

```bash
git push origin main:release/v1.0
```

This advances the deploy ref. See [[releases-and-tags]] and [[promotion-dev-to-prod]].

## Build pipeline

Single `Dockerfile` at `writers-workbench/Dockerfile`. Three stages:

1. **client builder** — `npm ci` in `client/`, `npm run build` → `client/dist/`.
2. **server builder** — `npm ci` in `server/`, `tsc` → `server/dist/`.
3. **production** — `node:20-alpine`. Copies `server/dist/` + `server/package.json` (production deps) + `client/dist/`. Runs `node dist/index.js`.

`railway.toml` health check at `/api/health`. 30s timeout. Auto-restart on 3 consecutive fails.

## `/api/health` payload

```json
{
  "status": "ok",
  "version": "<git-sha>",
  "deployed_at": "<iso8601>",
  "environment": "production" | "development",
  "checks": {
    "supabase": "ok" | "error" | "skipped",
    "redis": "ok" | "error" | "skipped",
    "postal": "ok" | "error" | "skipped"
  },
  "active_sessions": <int>
}
```

`active_sessions` was added Sprint 10b-5; reads from Redis `SCAN session:*`.

## Env vars (per tier)

See [[env-vars-by-tier]] for the full annotated table. Critical ones:

### Tier-sensitive (DO NOT blanket-copy DEV→PROD)

| Variable | DEV value | PROD value | Failure mode if wrong |
|----------|-----------|------------|----------------------|
| `ALLOWED_ORIGINS` | `https://writersworkbench-develop.up.railway.app` | `https://writersworkbench-production.up.railway.app` | Crossorigin asset CORS 500, blank page |
| `NODE_ENV` | `development` | `production` | `/api/health.environment` reports wrong tier |
| `SUPABASE_URL` | `https://gvbvwcnmjkdpclcisqrr.supabase.co` | `https://faklxfakgzkpkbxfihzh.supabase.co` | DEV writes land in PROD or vice versa |
| `SUPABASE_SERVICE_ROLE_KEY` | DEV key (`sb_secret_8GDV…`) | PROD key (`sb_secret_huxH…`) | Auth + admin paths fail |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | DEV public | PROD public | Bundle reads wrong DB |
| `VITE_N8N_WEBHOOK_URL` | `…/webhook/author_request_dev` | `…/webhook/author_request_v2` | Cross-tier hub call |
| `N8N_HUB_WEBHOOK_URL` | same | same | Async jobs cross-tier |
| `SENDER_NAME` | `The Writers Workbench (Dev)` | `The Writers Workbench` | Real users see "(Dev)" in From |

### Shared but secret (per tier — don't reuse across tiers)

- `EMAIL_SECRET`, `INGESTION_SECRET`, `APPROVAL_SECRET`, `NEWSLETTER_CALLBACK_SECRET`
- `POSTAL_API_KEY` — DEV mail server vs PROD mail server (DEV is in Development mode; messages logged but not delivered)
- `POSTAL_API_URL` — same (`https://postal-admin.courseworx.media/api/v1`)
- `CRON_SECRET` — currently UNSET on both tiers. Set when `/api/cron/*` becomes externally driven.

### Reference-syntax (Railway service references)

- `REDIS_URL=${{Redis.REDIS_PRIVATE_URL}}` (PROD)
- `REDIS_URL=${{Redis_Dev.REDIS_PRIVATE_URL}}` (DEV)

The service name in the reference must match exactly.

## Health-check checks (current state)

| Tier | Last verified | Status |
|------|---------------|--------|
| PROD | 2026-04-28 release | `{environment:production, checks:{supabase:ok, redis: <pre-S10b-1 unset until next release>, postal: <unset>}}` |
| DEV | 2026-05-01 | `{environment:development, version:<recent>, checks:{supabase:ok, redis:ok, postal:ok}}` |

## Postal stack details

`N8N-MCP` Railway project, production env:

| Service | Image | Volume | Notes |
|---------|-------|--------|-------|
| `postal-mariadb` | `mariadb:11` | `/var/lib/mysql` (5 GB) | Postal metadata + per-server DBs |
| `postal-web` | `ghcr.io/postalserver/postal:3.3.5` | `/config` | Admin UI at `postal-admin.courseworx.media`. `BIND_ADDRESS=0.0.0.0`, `PORT=8080`. Custom Start Command `postal web-server`. |
| `postal-worker` | same | `/config` (own copy w/ same postal.yml + signing.key) | Custom Start Command `postal worker` |

Not installed: `postal-rabbitmq` (Postal 3.x dropped it), `postal-smtp` (inbound-only, out of scope).

Sending domain: `courseworx.media` with SPF + DKIM verified. Cloudflare-fronted; Return Path CNAME must be **DNS-only** (grey cloud).

Two mail servers in Postal:
- `writers-workbench-mail-prod` — Live mode
- `writers-workbench-mail-dev` — Development mode (logs only, no delivery)

See [[postal-mail-stack]].

## Branch protection (main)

4 required status checks: `TypeScript & Lint`, `Unit Tests`, `Production Build`, `Schema Governance Check`. E2E is NOT required (known broken — Issue #3). Admin push blocked.

## Known gotchas

- **Railway service name in references is exact.** `${{Redis.REDIS_PRIVATE_URL}}` does NOT match `Redis_Dev`.
- **`pg_dump` version must match the server.** PG17 server, PG15 client fails. Use `postgresql@17` brew cask.
- **Direct `db.<ref>.supabase.co` is IPv6-only** on new Supabase projects. Use the session-pooler URI for psql/pg_dump.
- **`pg_dump --disable-triggers` fails** because the pooler role can't disable RI_* triggers. Drop the flag.
- **Setting Site URL + Redirect URLs in Supabase Auth** is REQUIRED for password reset / magic link. Both PROD and DEV currently default to `http://localhost:3000` — see [[hotfixes]].
- **CI workflow has a `paths` filter.** Scripts-only PRs to `main` don't trigger CI and can't satisfy required status checks. Include a doc file under `writers-workbench/docs/` to force CI to run.
