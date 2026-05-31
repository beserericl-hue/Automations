---
name: Backend stack
description: Express + TypeScript + BullMQ + Postal + IORedis. Boot order, middleware chain, route registration, shutdown handling.
type: concept
tags: [backend, stack]
last_reviewed: 2026-05-09
---

# Backend stack

`writers-workbench/server/`. Express + TypeScript, compiled to `server/dist/`.

## Dependencies

| Package | Why |
|---------|-----|
| `express@4` | HTTP framework |
| `@supabase/supabase-js` | Service-role client for admin / impersonation paths |
| `bullmq@^5` | Job queue (Sprint 10b-1) |
| `ioredis@^5` | Redis client used by BullMQ + session-store + sse-pubsub |
| `zod` | Request validation. All schemas in `schemas.ts`. |
| `pino` | Structured JSON logging. |
| `helmet`, `cors`, `express-rate-limit` | Security middleware (Sprint 0). |
| `swagger-jsdoc` + `swagger-ui-express` | OpenAPI docs at `/api/docs` (Sprint 7). |
| `docx` | KDP `.docx` export. |
| `handlebars` | Newsletter template rendering. |
| `marked` | Markdown → HTML server-side. |
| `vitest` | Unit tests. |

`maxRetriesPerRequest: null` is required on the IORedis client because BullMQ relies on it. Don't change.

## Boot sequence (`server/src/index.ts`)

```
1. Load env (dotenv)
2. Build express app
3. Apply middleware:
   - cors (ALLOWED_ORIGINS — must match own service public URL)
   - helmet
   - express.json
   - generalLimiter (rate-limit, default 1000/15min)
4. Register routes (see below)
5. Static serve client/dist
6. Catch-all → index.html (SPA fallback)
7. Start HTTP server on PORT (Railway sets 8080)
8. Initialize all named queues (initAllNamedQueues)
9. Start all BullMQ workers (boot.ts startAllWorkers)
10. Attach trackers + SSE forwarders to each queue
11. Graceful shutdown (SIGTERM/SIGINT):
    - drain HTTP
    - closeAllQueues
    - closeRedis
    - closeSsePubsub
```

## Middleware chain

`requireAuth` (in `middleware/auth.ts`) is the gatekeeper for all user-scoped routes:

```
1. Pull JWT from Authorization: Bearer or cookie
2. Validate via supabase.auth.getUser(jwt)
3. Load users_v2 row by supabase_auth_uid
4. Load user_role_meta_v2 row (effective role: superuser | admin | (none → user))
5. Load user_account_meta_v2 (account_status — block if not 'active', superuser bypass)
6. Load user_subscriptions (tier, credits)
7. Honor X-Impersonate-User if (caller is superuser AND active impersonation_log row)
8. Attach to req: {userId, role, accountStatus, subscription, isImpersonating}
9. next()
```

Variants:
- `requireAdmin` — role IN admin/superuser.
- `requireSuperuser` — role === superuser.
- `requireTierFeature(name)` — subscription.tier.features[name] === true.
- `requireCredits(opName)` — checks credits_remaining ≥ cost(opName); 402 INSUFFICIENT_CREDITS otherwise.

Other middleware:
- `error-handler.ts` — central JSON error response. Logs via pino.
- `shared-secret.ts` — factory for `requireSecret('X-Email-Secret')` etc. Used on n8n-callback routes.
- `validate.ts` — Zod request validation, per-route.

## Routes

See [[express-routes]] for full enumeration. Top-level register order:

```
/api/health           → routes/health.ts        (no auth)
/api/account          → routes/account.ts       (auth)
/api/admin            → routes/admin.ts         (auth + admin)
/api/superuser        → routes/superuser.ts     (auth + superuser)
/api/impersonate/data → routes/impersonate-data.ts  (auth + superuser + active session)
/api/impersonate/write → routes/impersonate-write.ts
/api/credits          → routes/credits.ts
/api/tiers            → routes/tiers.ts         (public for signup)
/api/cron             → routes/cron.ts          (X-Cron-Secret)
/api/chat             → routes/chat.ts          (auth + credits)
/api/jobs             → routes/jobs.ts          (auth)
/api/brainstorm       → routes/brainstorm.ts
/api/content          → routes/content-actions.ts  (rewrite-with-research, annotations)
/api/genres           → routes/genres.ts
/api/images           → routes/images.ts
/api/export           → routes/export.ts        (.docx)
/api/email            → routes/email.ts         (X-Email-Secret)
/api/ingestion        → routes/ingestion.ts     (X-Ingestion-Secret)
/api/session          → routes/session.ts       (auth)
/api/callback         → routes/session.ts (subset)  (n8n→server)
/api/newsletter       → routes/newsletter.ts + newsletter-*.ts
/api/approvals        → routes/approvals.ts     (X-Approval-Secret)
/api/test-newsletter  → routes/test-newsletter.ts (dev only)
```

## Job queue subsystem

Lives in `server/src/lib/jobs/`. See [[job-queue]] for the deep dive.

```
types.ts        QueueName, PriorityTier, QUEUE_SETTINGS
classifier.ts   regex-rule message classifier
n8n-worker.ts   Worker factory: HTTP retry semantics
concurrency.ts  per-user slot acquire/release
job-tracker.ts  addTrackedJob (enqueue + INSERT job_queue_v2)
sse-forwarder.ts  bullmq events → SSE
boot.ts         startAllWorkers (called at boot)
```

Queue settings:

| Tier | Concurrency | Timeout | Examples |
|------|-------------|---------|----------|
| sync-ops | 10 | 30s | list_outlines, retrieve_content (mostly bypasses queue) |
| medium-ops | 4 | 120s | brainstorm, edit_outline, generate_social |
| heavy-ops | 2 | 1200s | write_chapter, rewrite_chapter_with_research, brainstorm_chapter |
| background-ops | 3 | 300s | nightly cron tasks, ingestion runs |

## Email + Postal

- `lib/email.ts` — `sendEmail({to, subject, html, text, attachments?})`. Talks to Postal via `POSTAL_API_URL` + `POSTAL_API_KEY`. Honors `DRY_RUN_EMAIL=true`.
- `lib/rate-limit.ts` — Redis sliding-window 30/min/user (Sprint 11-S11-4).
- Bounces handled by `routes/admin.ts` Email Bounces tab + n8n cron flips `newsletter_subscribers_v2.status` to `bounced` (Sprint 11-S11-5 + Newsletter fan-out PR #74).

See [[postal-mail-stack]] and [[email-pipeline]].

## Session + SSE

- `lib/session-store.ts` — Redis hash per user `session:{userId}` with 30-min TTL. In-memory fallback for local dev.
- `lib/sse-pubsub.ts` — `publishSseEvent(userId, event)` → Redis PUBLISH. Subscriber side uses dedicated IORedis connection (PUBLISH and SUBSCRIBE can't share). Ref-counted local handlers — only SUBSCRIBE on first listener per channel.
- `routes/session.ts` — `register/unregister/active/events`. EventSource needs `?token=` query (browsers can't set Authorization on EventSource).

See [[session-and-sse]].

## Ingestion + Newsletter

`routes/ingestion.ts` — `POST /upload`, `GET /search`, `GET /get/:key`, `GET /mine/days`. All gated by `X-Ingestion-Secret`. Storage in `newsletter-ingestion` bucket; metadata in `content_ingestion_v2`.

`routes/newsletter*.ts` (six files) — covers editions CRUD, sends, approvals, feed sources, render-html, generate, cadence cron callback. Approvals tokenized; rendering via Handlebars merge.

See [[email-pipeline]] and [[newsletter-cluster]].

## Build + run

```bash
cd writers-workbench/server
npm run dev          # ts-node-dev, port 3001
npm run build        # tsc → dist/
npm run start        # node dist/index.js
npm run test         # vitest run, ~150+ tests
npm run typecheck    # tsc --noEmit
```

Tests use in-memory Supabase fakes + IORedis-mock. No live deps required.

## Common gotchas

- `n8n-worker` HTTP semantics: 2xx → ok, 4xx → ok:false (do NOT retry — user error), 5xx/network → throw (BullMQ retries).
- `closeAllQueues` is required on shutdown — otherwise BullMQ leaves Redis connections open.
- `requireAuth` must run BEFORE Zod validation on routes that need scope-aware error messages.
- `app_config_v2.sprint8_superuser_config` carries config tweaks (credit costs, tier defaults, etc.) — don't hardcode if the path through config exists.
