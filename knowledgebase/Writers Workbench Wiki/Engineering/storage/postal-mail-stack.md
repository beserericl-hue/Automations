---
name: Postal mail stack
description: Three-service Postal 3.3.5 deployment on Railway. Domain config, mail-server tier isolation, gotchas.
type: concept
tags: [storage, email, postal]
last_reviewed: 2026-05-09
---

# Postal mail stack

Self-hosted Postal v3.3.5 replacing Gmail OAuth (Sprint 11). Lives in Railway project `N8N-MCP`, production environment. Single shared instance — DEV vs PROD isolation is at the Postal-mail-server level, not at the infra level.

Runbook: [`writers-workbench/docs/postal-install-runbook.md`](../../../../writers-workbench/docs/postal-install-runbook.md).

## Services

| Service | Image | Volume | Public URL | Notes |
|---------|-------|--------|------------|-------|
| `postal-mariadb` | `mariadb:11` | `/var/lib/mysql` (5 GB) | private | Postal metadata + per-server DBs (`postal-server-1`, `postal-server-2`, …) |
| `postal-web` | `ghcr.io/postalserver/postal:3.3.5` | `/config` | `postal-admin.courseworx.media` | Admin UI + HTTP API. `BIND_ADDRESS=0.0.0.0`, `PORT=8080`. Custom Start Command: `postal web-server`. |
| `postal-worker` | `ghcr.io/postalserver/postal:3.3.5` | `/config` (separate volume — must contain same `postal.yml` + `signing.key`) | private | Outbound mail processor. Custom Start Command: `postal worker`. |

**Not installed:** `postal-rabbitmq` (Postal 3.x dropped RabbitMQ in favor of internal queueing) and `postal-smtp` (inbound SMTP only — out of scope for API-only sending).

## Domain config

| Item | Value |
|------|-------|
| Sending domain | `courseworx.media` |
| SPF record | green in Postal (configured on Cloudflare) |
| DKIM record | green in Postal (configured on Cloudflare) |
| Return Path CNAME | `rp.postal.courseworx.media` — **DNS-only** in Cloudflare (grey cloud, NOT orange) |
| Admin URL | `https://postal-admin.courseworx.media` |
| API base | `https://postal-admin.courseworx.media/api/v1` |

Orange-clouding the Return Path CNAME breaks return-path handshake; bounces fail in non-obvious ways.

## Organization + mail servers

Inside Postal admin (`https://postal-admin.courseworx.media`):

- Organization: `Courseworx Media` (slug `courseworx-media`)
- Two mail servers under that org:
  - `writers-workbench-mail-prod` — **Live mode**. Real outbound delivery.
  - `writers-workbench-mail-dev` — **Development mode**. Postal swallows sends, logs them in the Messages tab. No real delivery.
- Admin user: `eric@agileadtesting.com`

Each server has its own API key. Tier isolation = which API key the Workbench uses.

## Per-tier wiring

| Env var | DEV value | PROD value |
|---------|-----------|-----------|
| `POSTAL_API_URL` | `https://postal-admin.courseworx.media/api/v1` | same |
| `POSTAL_API_KEY` | `writers-workbench-mail-dev` server API key | `writers-workbench-mail-prod` server API key |
| `SENDER_EMAIL` | `eve@courseworx.media` | same |
| `SENDER_NAME` | `The Writers Workbench` (was `(Dev)` originally — fixed at v1.1.0 release) | `The Writers Workbench` |
| `REPLY_TO_EMAIL` | `support@courseworx.media` | same |
| `DRY_RUN_EMAIL` | `false` (after smoke test) | `false` |

When `DRY_RUN_EMAIL=true`, [`server/src/lib/email.ts`](../../../../writers-workbench/server/src/lib/email.ts) skips the Postal call and returns `{success:true, message_id:'dry-run-…', mode:'dry-run'}`. Used during local dev + initial smoke tests.

## Workbench email pipeline

`POST /api/email/send` is the endpoint. Gated by `X-Email-Secret` shared header.

```ts
// server/src/lib/email.ts
sendEmail({
  to: string | string[],
  subject: string,
  html: string,
  text?: string,
  from?: string,        // defaults to SENDER_EMAIL
  reply_to?: string,
  attachments?: [{filename, content, content_type}]
}) → Promise<{success, message_id, mode: 'sent'|'dry-run'}>
```

Rate-limit: Redis sliding-window 30/min per `user_id` (Sprint 11 S11-4). See [[email-pipeline]].

## n8n side

15 V2 workflows formerly used Gmail OAuth (cred `CPCSZOInV8Zj1PI1`). Sprint 11 sweep `scripts/s11-migrate-gmail-to-postal.py` (commit `b9303aa`) replaced Gmail Send nodes with HTTP Request → `https://writersworkbench{dev}-production.up.railway.app/api/email/send`. The Authorization-equivalent is `X-Email-Secret` from a tier-specific httpHeaderAuth credential.

Tier credentials in n8n:
- DEV — `kxrSg24PIR2Npfvw` (DEV Workbench Email Secret)
- PROD — created at v1.1.0 promotion (id varies; see [[credentials-map]])

Status by tier:
- DEV: 14/14 email-sending workflows on Postal (via Workbench API).
- PROD: 14/14 also on Postal as of v1.1.0 release (PROD Workbench has its own EMAIL_SECRET + API key).

## Bounces

Postal sends bounces back to the Return Path which we route to `/api/admin/email-bounces` (or via webhook). The handler:

1. INSERT into `email_bounces_v2`.
2. UPDATE `newsletter_subscribers_v2.status='bounced'` if the email matches a subscriber (Newsletter PR #74).
3. AdminPanel "Email Bounces" tab (Sprint 6 follow-up) lists them with severity tags.

## Common gotchas

- **Postal 3.x image tag `:3` does NOT exist** on GHCR. Use `:latest` or specific versions like `:3.3.5`. Use the runbook.
- **`postal start` is NOT a real command.** Each process is its own Railway service: `postal web-server`, `postal worker`, `postal smtp-server`. Set Custom Start Command on each.
- **Postal `config/puma.rb`** reads `BIND_ADDRESS` + `PORT` env. Default is loopback. On Railway: set `BIND_ADDRESS=0.0.0.0` and `PORT=8080`, then set Networking target port to 8080.
- **MariaDB user privileges:** `postal-server-N` databases get created on demand. The `postal` MariaDB user needs `GRANT ALL PRIVILEGES ON \`postal-%\`.* TO 'postal'@'%'` or Build Server returns 500.
- **Postal ActionDispatch::HostAuthorization** only accepts `web_hostname` from `postal.yml`. Other URLs return 403.
- **"LIVE" badge** on a server tile means online, NOT live mode. To verify mode: open `/org/<slug>/servers/<server>/edit` (or Settings → Server Settings).
- **Keep `signing.key` consistent** between web + worker `/config` volumes. Drift breaks DKIM signing.
- **DEV mail server in Development mode** swallows mail. Use the Messages tab to inspect what would have been sent.

## Health check

`/api/health` runs:
```ts
const checks = await Promise.allSettled([
  postalReachable(POSTAL_API_URL, POSTAL_API_KEY),
  // ...
]);
```

`postal: 'ok' | 'error' | 'skipped'`. Skipped when `DRY_RUN_EMAIL=true` (no point pinging if we're not calling).
