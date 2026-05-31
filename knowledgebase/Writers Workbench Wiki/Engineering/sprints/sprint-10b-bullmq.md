---
name: Sprint 10.b — Redis + BullMQ + concurrency + SSE pub/sub
description: 5 stories / 34 pts. Job queue infra, classifier, per-user concurrency, session store, SSE pub/sub.
type: concept
tags: [sprints, sprint-10b, bullmq, redis]
last_reviewed: 2026-05-09
---

# Sprint 10.b — Redis + BullMQ + concurrency + SSE pub/sub

**Released:** v1.1.0 (2026-04-28).
**Stories:** S10b-1 through S10b-5 (34 pts).
**PRs:** [#10](https://github.com/beserericl-hue/Automations/pull/10) (S10b-1), [#11](https://github.com/beserericl-hue/Automations/pull/11) (S10b-2), [#13](https://github.com/beserericl-hue/Automations/pull/13) (S10b-3), [#15](https://github.com/beserericl-hue/Automations/pull/15) (S10b-5), [#20](https://github.com/beserericl-hue/Automations/pull/20) (S10b-4 — replaces #14).

## S10b-1 — Redis + BullMQ library

PR #10. Foundation work.

- Added `bullmq@^5` and `ioredis@^5` to server deps.
- [`server/src/lib/redis.ts`](../../../../writers-workbench/server/src/lib/redis.ts) — lazy IORedis client with `maxRetriesPerRequest: null` (BullMQ requirement), exponential retry up to 10s, READONLY auto-reconnect, event logging.
- [`server/src/lib/queue.ts`](../../../../writers-workbench/server/src/lib/queue.ts) — BullMQ Queue factory with name registry, default job options.
- `/api/health` new `checks.redis` field.
- Shutdown handler now async — drains queues + closes Redis alongside HTTP server.

12 new unit tests. `REDIS_URL=${{Redis.REDIS_PRIVATE_URL}}` wired on both Railway services.

## S10b-2 — Job queue schema + priority

PR #11. Migration 008 + classifier + worker scaffolding.

- [`migrations/008_job_queue.sql`](../../../../writers-workbench/migrations/008_job_queue.sql) — `job_queue_v2` BullMQ lifecycle audit table. 4 indexes, RLS, FK to `users_v2(user_id)`. Additive only. Applied live to DEV; PROD untouched at this point.
- [`server/src/lib/jobs/types.ts`](../../../../writers-workbench/server/src/lib/jobs/types.ts) — `QueueName`, `PriorityTier`, `QUEUE_SETTINGS` with concurrency + timeout per tier.
- [`server/src/lib/jobs/classifier.ts`](../../../../writers-workbench/server/src/lib/jobs/classifier.ts) — regex-rule message classifier mirroring hub `preprocess_message` logic. First-match-wins; unmatched → `medium-ops/chat_generic`.
- [`server/src/lib/jobs/n8n-worker.ts`](../../../../writers-workbench/server/src/lib/jobs/n8n-worker.ts) — BullMQ Worker factory. 2xx → ok; 4xx → ok:false (no retry); 5xx/network → throw (BullMQ retries).
- [`server/src/lib/jobs/job-tracker.ts`](../../../../writers-workbench/server/src/lib/jobs/job-tracker.ts) — `addTrackedJob` enqueues + INSERTs `job_queue_v2` atomically; `attachTrackerToQueue` listens to `QueueEvents` and mirrors status transitions, computes `duration_ms`.

Queue settings:

| Tier | Concurrency | Timeout |
|------|-------------|---------|
| sync-ops | 10 | 30s |
| medium-ops | 4 | 120s |
| heavy-ops | 2 | 1200s |
| background-ops | 3 | 300s |

33 new unit tests. Full suite 169/169 green at merge.

**Nothing actually enqueues yet** at this point — scaffolding only.

## S10b-3 — Migrate chat proxy onto BullMQ + SSE progress

PR #13. The big migration.

- `server/src/routes/chat.ts` classifies every inbound message via `jobs/classifier.ts`. Sync tier (list/retrieve/approve) keeps direct n8n fetch; async tier (write/brainstorm/generate) enqueues to priority-matched queue and returns `{jobId, trackerRowId, status:'queued'}`.
- New `N8N_HUB_WEBHOOK_URL` env var (full URL). Falls back to legacy `${N8N_API_URL}/webhook/author_request_v2` so prod keeps working without env changes. **DEV needs `N8N_HUB_WEBHOOK_URL=…/author_request_dev`** before deploy — caught + fixed pre-merge.
- `server/src/routes/jobs.ts` — user-scoped jobs API (list, stats, detail, status, cancel). Cancel only allowed for `waiting`/`delayed`.
- `server/src/lib/jobs/sse-forwarder.ts` + `boot.ts` — server-boot starts one BullMQ Worker per queue; attaches tracker (S10b-2) + SSE forwarder.
- `server/src/routes/session.ts` — `pushSseEvent(userId, event)` exported so forwarder can push without a round-trip.
- `client/src/components/chat/ChatDrawer.tsx` — async responses render Queued → Processing → Complete/Failed pills. Active job IDs persist in localStorage so a refresh restores state.
- `client/src/components/layout/AppShell.tsx` — fans `job-status` SSE events to the window so ChatDrawer can subscribe.

11 new server tests + 3 client component tests + 1 updated S4-6 test. Full suite 335/335 green at merge.

## S10b-4 — Per-user concurrency + admin queue dashboard

PR #20 (originally PR #14, closed and superseded).

- [`server/src/lib/jobs/concurrency.ts`](../../../../writers-workbench/server/src/lib/jobs/concurrency.ts) — `tryAcquireUserSlot`, `releaseUserSlot`, `getUserCounts` using Redis `INCR`/`DECR` with 30-min TTL safety valve. `DEFAULT_LIMITS = {total: 3, heavy: 1}`.
- `n8n-worker.ts` processor — acquires before HTTP, releases in `finally`. On refusal: `job.moveToDelayed(now+5s, token)` + `throw new DelayedError()` (not a retry).
- `server/src/routes/admin.ts` — `GET /api/admin/queues` per-tier queue depths + concurrency + DEFAULT_LIMITS + top 20 users + total in-flight. 503 when REDIS_URL unset.
- `client/src/components/admin/AdminPanel.tsx` — new **Queues** tab with 10s auto-refresh.

10 new server tests.

## S10b-5 — Session store + SSE fan-out to Redis

PR #15.

- [`server/src/lib/session-store.ts`](../../../../writers-workbench/server/src/lib/session-store.ts) — `SessionStore` interface. Redis impl uses hash-per-user `session:{userId}` with key-level 30-min TTL, `SCAN` for count. `isActive` uses `HEXISTS` BEFORE the `MULTI` so an expired key doesn't get resurrected by `HSET lastActivity` (real bug). In-memory fallback for local dev.
- [`server/src/lib/sse-pubsub.ts`](../../../../writers-workbench/server/src/lib/sse-pubsub.ts) — `publishSseEvent` uses main Redis for PUBLISH; dedicated second IORedis connection for subscriber mode (IORedis won't let you SUBSCRIBE on the same client as PUBLISH). Ref-counted per-channel local handlers.
- `server/src/routes/session.ts` — refactored. `pushSseEvent` is now async + publishes. Every endpoint goes through the two abstractions.
- `server/src/routes/health.ts` — new `active_sessions` field. Failure to read does not fail health check.
- `server/src/lib/jobs/sse-forwarder.ts` — `SsePushFn` widened to sync-or-async return.
- `server/src/index.ts` — `closeSsePubsub` in graceful shutdown alongside `closeAllQueues` + `closeRedis`.

12 new server tests.

## Test counts at end of 10.b work

- Server: 119 (base) + 11 (S10b-3) + 10 (S10b-4) + 12 (S10b-5) = 152 passing.
- Client: 217 passing.

## Why it matters

Before Sprint 10.b, `/api/chat/proxy` was synchronous — server fetches n8n, waits 10-20 minutes on heavy ops, hits Cloudflare 524 timeouts. Sprint 10.b decouples:
- Sync ops bypass queue (still direct).
- Async ops queue + immediate `{jobId, trackerRowId}` response. SSE delivers progress.

Foundational for Sprint 11 (Postal email pipeline calling /api/email/send), Sprint 12 (rewrite-with-research dispatching as heavy-ops jobs), and Sprint 16-18 (Anthropic token budget gatekeeper).

## Common gotchas

- **`maxRetriesPerRequest: null`** required by BullMQ.
- **PUBLISH and SUBSCRIBE clients can't share** — two IORedis instances.
- **Service-name reference must match exactly** — `${{Redis.REDIS_PRIVATE_URL}}` ≠ `${{Redis_Dev.REDIS_PRIVATE_URL}}`.
- **`HEXISTS` before `MULTI`** in session store — order matters.
- **`addTrackedJob` INSERTS first** then enqueues — so tracker exists before BullMQ may emit events.
- **Cancellation only for waiting/delayed** — active jobs continue.
