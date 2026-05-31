---
name: Env vars by tier
description: Full per-tier env var reference. Which are tier-sensitive, which are shared, which are unset.
type: reference
tags: [operations, env-vars, ops]
last_reviewed: 2026-05-09
---

# Env vars by tier

Every Workbench Railway service needs these. **Tier-sensitive** vars MUST differ between DEV and PROD; mistakes here are the #1 release-day bug source.

## Workbench services

### Tier-sensitive (audit field-by-field; never blanket-copy)

| Variable | DEV value | PROD value | Notes |
|----------|-----------|-----------|-------|
| `ALLOWED_ORIGINS` | `https://writersworkbench-develop.up.railway.app` | `https://writersworkbench-production.up.railway.app` | Crossorigin asset CORS 500 → blank page if wrong |
| `NODE_ENV` | `development` | `production` | Reflects on `/api/health.environment` |
| `PORT` | `8080` | `8080` | Railway sets automatically |
| `SUPABASE_URL` | `https://gvbvwcnmjkdpclcisqrr.supabase.co` | `https://faklxfakgzkpkbxfihzh.supabase.co` | DEV writes land in PROD or vice versa if wrong |
| `SUPABASE_SERVICE_ROLE_KEY` | starts `sb_secret_8GDV…` | starts `sb_secret_huxH…` | |
| `VITE_SUPABASE_URL` | same as SUPABASE_URL | same | Bundle uses this |
| `VITE_SUPABASE_ANON_KEY` | DEV anon public | PROD anon public | |
| `VITE_N8N_WEBHOOK_URL` | `…/webhook/author_request_dev` | `…/webhook/author_request_v2` | Cross-tier hub call if wrong |
| `N8N_HUB_WEBHOOK_URL` | same | same | Async jobs cross-tier if wrong |
| `N8N_BRAINSTORM_WEBHOOK_URL` | `…/webhook/brainstorm_story_dev` | `…/webhook/brainstorm_story_v2` | |
| `N8N_API_URL` | `https://n8n.agileadautomation.com` | same | Shared instance |
| `N8N_API_KEY` | shared | shared | |
| `VITE_ELEVENLABS_AGENT_ID` | `agent_0001kpr667v6ffctex0a8dt4fk71` (DEV Eve) | `agent_2801kks580vnf5q80j3bd0n0x45v` (PROD Eve) | |
| `SENDER_NAME` | `The Writers Workbench` (was `(Dev)` historically) | `The Writers Workbench` | Cosmetic; appears in From line |
| `SENDER_EMAIL` | `eve@courseworx.media` | same | |
| `REPLY_TO_EMAIL` | `support@courseworx.media` | same | |

### Per-tier secrets

| Variable | Purpose | Used by |
|----------|---------|---------|
| `EMAIL_SECRET` | gates `/api/email/send` (`X-Email-Secret`) | n8n → Workbench |
| `INGESTION_SECRET` | gates `/api/ingestion/*` (`X-Ingestion-Secret`) | n8n → Workbench |
| `APPROVAL_SECRET` | gates `/api/approvals/:token` (`X-Approval-Secret`) | n8n → Workbench |
| `NEWSLETTER_CALLBACK_SECRET` | gates `/api/newsletter/cron-callback` (`X-Newsletter-Callback-Secret`) | n8n → Workbench |

Each tier has its own value — no overlap.

### Per-tier Postal

| Variable | DEV | PROD |
|----------|-----|------|
| `POSTAL_API_URL` | `https://postal-admin.courseworx.media/api/v1` | same |
| `POSTAL_API_KEY` | writers-workbench-mail-dev API key | writers-workbench-mail-prod API key |
| `DRY_RUN_EMAIL` | `false` | `false` |

### Reference-syntax (Railway service references)

| Variable | DEV | PROD |
|----------|-----|------|
| `REDIS_URL` | `${{Redis_Dev.REDIS_PRIVATE_URL}}` | `${{Redis.REDIS_PRIVATE_URL}}` |

The service name in the reference must match exactly. Don't typo `Redis_Dev` as `Redis-Dev`.

### Currently UNSET (returns 503 if route is hit)

| Variable | Purpose | When to set |
|----------|---------|-------------|
| `CRON_SECRET` | gates `/api/cron/*` | When external scheduler is wired |
| `STRIPE_PUBLISHABLE_KEY` | client-side Stripe Elements | Sprint 9 |
| `STRIPE_SECRET_KEY` | server-side Stripe API | Sprint 9 |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature validation | Sprint 9 |
| `KIEAI_API_KEY` | KIE.AI cover art (newer alternative to DALL-E) | When that workflow is preferred |

### Optional / feature flags

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_GOOGLE_OAUTH_ENABLED` | `false` | Enables "Continue with Google" button on auth pages. Requires Supabase Auth → Google provider configured first. |
| `LOG_LEVEL` | `info` | Pino log level. `debug` for noisy diagnostics. |

## .env.example (committed in repo)

`writers-workbench/.env.example` lists all env vars with placeholder values. Use as a checklist when configuring a new Railway service.

## Where to set on Railway

`bubbly-solace` project → service (Workbench-prod or WritersWorkbenchDev) → Variables tab.

Use Railway's "Reference" syntax for service-to-service dependencies (`${{Redis.REDIS_PRIVATE_URL}}`). Don't paste raw values — the indirection survives Redis service URL rotation.

## Lifecycle

When adding a new env var:

1. Add to `writers-workbench/.env.example` (placeholder value).
2. Document here under appropriate section.
3. Set on DEV Railway service.
4. Verify in dev (`/api/health` should not regress).
5. At next release: set on PROD Railway service BEFORE running `promote-dev-to-prod.py`.

## Rotation

If a secret leaks:

1. Generate new value (`openssl rand -hex 32` for 256-bit secrets).
2. Set on Railway service first.
3. Then update n8n credential with the new value.
4. n8n REST PUT credential — confirm 200 (it's separate from workflow PUT).
5. Test: trigger an op; verify auth succeeds.
6. Old value invalid; any in-flight requests at the moment of rotation fail (acceptable).

## Common gotchas

- **Service-name reference must match exactly.** `${{Redis.REDIS_PRIVATE_URL}}` ≠ `${{Redis_Dev.REDIS_PRIVATE_URL}}`. Typos silent.
- **`PORT=3000` in Vite proxy** vs `PORT=8080` on Railway — consistent on Railway, just different in dev.
- **Bundle env vars (VITE_*) are public.** RLS protects DB; don't expose secrets via VITE_*.
- **`NODE_ENV=production` flips a lot of behavior** — pino log level, error verbosity, build optimization. Setting it wrong on PROD makes diagnostics painful.
- **`ALLOWED_ORIGINS` mismatch** = blank page. Crossorigin assets get CORS 500. Documented in CLAUDE.md.
- **`SENDER_NAME=… (Dev)`** copied to PROD on v1.1.0 — caught visually mid-release. Cosmetic but real.
- **`DRY_RUN_EMAIL=true` left on** = silent email failures. Always confirm before declaring "release done."
- **Newly-introduced env var unset on the OTHER tier** at release-day = 503 there. Always set on both before enabling the route.
