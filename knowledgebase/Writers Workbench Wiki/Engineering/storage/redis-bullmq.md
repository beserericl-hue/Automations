---
name: Redis + BullMQ
description: Per-tier Redis instances, BullMQ queue topology, session-store, sse-pubsub, and per-user concurrency.
type: concept
tags: [storage, redis, bullmq, queue]
last_reviewed: 2026-05-09
---

# Redis + BullMQ

Per-tier Redis infrastructure introduced in Sprint 10b. Two services in Railway project `bubbly-solace`:

| Service | Used by | `REDIS_URL` reference |
|---------|---------|----------------------|
| `Redis` | PROD Workbench | `${{Redis.REDIS_PRIVATE_URL}}` |
| `Redis_Dev` | DEV Workbench | `${{Redis_Dev.REDIS_PRIVATE_URL}}` |

The reference syntax must match the service name exactly. `${{Redis.REDIS_PRIVATE_URL}}` does NOT match `Redis_Dev`.

## Why we need Redis

Three subsystems share Redis:

1. **BullMQ** — async job queue. Heavy ops (Write Chapter, etc.) shouldn't tie up an HTTP request.
2. **Session store** — Eve session tracking (`session:{userId}` hash with 30-min TTL).
3. **SSE pub/sub** — fan out queue events + content-ready callbacks to every open EventSource.
4. **Concurrency limiter** — per-user slot count via `INCR`/`DECR` (Sprint 10b-4).
5. **Email rate limit** — 30/min/user sliding window (Sprint 11 S11-4).

## IORedis client

[`server/src/lib/redis.ts`](../../../../writers-workbench/server/src/lib/redis.ts):

```ts
const client = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,   // REQUIRED by BullMQ — do not change
  enableAutoPipelining: true,
  reconnectOnError: (err) => err.message.includes('READONLY'),
  retryStrategy: (times) => Math.min(times * 50, 10_000),
});
```

`maxRetriesPerRequest: null` is mandatory — BullMQ rejects Redis clients without it.

Two clients are needed:
- Main client (used by BullMQ + commands).
- Dedicated subscriber client (sse-pubsub) — IORedis won't let you SUBSCRIBE on a client that also runs commands.

## BullMQ queue topology

[`server/src/lib/jobs/types.ts`](../../../../writers-workbench/server/src/lib/jobs/types.ts):

```ts
export type QueueName = 'sync-ops' | 'medium-ops' | 'heavy-ops' | 'background-ops';

export const QUEUE_SETTINGS: Record<QueueName, {concurrency: number, timeoutMs: number}> = {
  'sync-ops':       { concurrency: 10, timeoutMs:   30_000 },
  'medium-ops':     { concurrency:  4, timeoutMs:  120_000 },
  'heavy-ops':      { concurrency:  2, timeoutMs: 1_200_000 }, // 20 min
  'background-ops': { concurrency:  3, timeoutMs:  300_000 },
};
```

Defaults applied to every job:

```ts
{
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail:     { age: 86400, count: 1000 }
}
```

## Job classification

[`server/src/lib/jobs/classifier.ts`](../../../../writers-workbench/server/src/lib/jobs/classifier.ts) — regex rules first-match-wins. Mirrors the n8n hub `preprocess_message` Code node logic so server-side routing is consistent with what the agent would have done.

Sample rules (paraphrased from the file):

| Match | Tier | Job type |
|-------|------|----------|
| `/list|show|find/` | sync-ops | `chat_list` |
| `/retrieve|get/` | sync-ops | `chat_retrieve` |
| `/approve|publish/` | sync-ops | `chat_approve` |
| `/write (a |the |my )?chapter/` | heavy-ops | `write_chapter` |
| `/rewrite.*chapter.*research/` | heavy-ops | `rewrite_chapter_with_research` |
| `/brainstorm (a |the |my )?(story|book|outline)/` | medium-ops | `brainstorm_story` |
| `/brainstorm.*chapter/` | medium-ops | `brainstorm_chapter` |
| `/edit (a |the |my )?outline/` | medium-ops | `edit_outline` |
| `/cover (art|image)/` | medium-ops | `cover_art` |
| `/social.*post/` | medium-ops | `social_posts` |
| `/research/` | medium-ops | `research` |
| (no match) | medium-ops | `chat_generic` |

Sync ops bypass the queue — server fetches the n8n hub directly and returns the body. Async ops enqueue.

## Per-user concurrency (Sprint 10b-4)

[`server/src/lib/jobs/concurrency.ts`](../../../../writers-workbench/server/src/lib/jobs/concurrency.ts):

```ts
const DEFAULT_LIMITS = { total: 3, heavy: 1 };

tryAcquireUserSlot(userId, tier) → boolean
  - INCR userSlot:{userId}:total (TTL 30 min)
  - if > limits.total: DECR back; return false
  - if heavy: INCR userSlot:{userId}:heavy
    - if > limits.heavy: DECR back AND DECR total; return false
  - return true

releaseUserSlot(userId, tier)
  - DECR total
  - if heavy: DECR heavy
```

The 30-min TTL is a safety valve so a crashed worker doesn't permanently lock a user out.

When `tryAcquireUserSlot` returns false in the n8n-worker processor:
```ts
await job.moveToDelayed(Date.now() + 5_000, token);
throw new DelayedError();   // BullMQ — not a retry
```

This re-queues the job 5s later, won't count against `attempts`.

## Session store

[`server/src/lib/session-store.ts`](../../../../writers-workbench/server/src/lib/session-store.ts).

Redis-backed session per Eve widget mount:
```
HSET session:{userId} token <token> lastActivity <ts>
EXPIRE session:{userId} 1800
```

`isActive(userId)` uses `HEXISTS` BEFORE the `MULTI`-write so an expired key isn't resurrected by `HSET lastActivity`. This was a real bug.

In-memory fallback for local dev without Redis (no isolation across server instances).

## SSE pub/sub

[`server/src/lib/sse-pubsub.ts`](../../../../writers-workbench/server/src/lib/sse-pubsub.ts).

```
publishSseEvent(userId, event)
  → publisher.PUBLISH chan:{userId} JSON.stringify(event)

subscribeSseChannel(userId, handler)
  → if first local handler for userId:
       subscriber.SUBSCRIBE chan:{userId}
  → register handler in local Map
  → return unsubscribe()
       which UNSUBSCRIBEs from Redis only when last local handler is gone
```

Channel is `chan:{userId}`. Events:
- `{type: 'content-ready', content_id, content_type, title}`
- `{type: 'job-status', jobId, status, progress, error?}`
- `{type: 'newsletter:approval-changed', token, status}`
- `{type: 'newsletter:execution-status', execution_id, stage}`
- `{type: 'eve:loaded', content_id}`

## Boot sequence

[`server/src/lib/jobs/boot.ts`](../../../../writers-workbench/server/src/lib/jobs/boot.ts):

```ts
startAllWorkers() → for each QueueName:
  initNamedQueue(name)
  attachTrackerToQueue(queue)        // job_queue_v2 audit
  const worker = createN8nWorker({queueName, concurrency, timeout})
  attachSseForwarder(worker, pushSseEvent)   // bullmq events → SSE
```

Called from `server/src/index.ts` after the HTTP server is listening.

Graceful shutdown:
```ts
await server.close()         // drain HTTP
await closeAllQueues()       // BullMQ + workers
await closeRedis()           // main + subscriber clients
await closeSsePubsub()       // unsubscribe + drop subscriber client
```

## Email rate-limit

[`server/src/lib/rate-limit.ts`](../../../../writers-workbench/server/src/lib/rate-limit.ts):

```
emailRateLimit(userId) → {allowed, remaining, resetAt}
  - INCR email:{userId}:{minute}
  - EXPIRE 70   (slightly > 60 to handle clock skew)
  - if count > 30: return {allowed:false, ...}
```

## Admin queue dashboard (Sprint 10b-4)

`GET /api/admin/queues` returns:
```json
{
  "queues": {
    "sync-ops":       {"waiting": 0, "active": 0, "delayed": 0, "completed": 12, "failed": 0, "concurrency": 10},
    "medium-ops":     {"waiting": 1, "active": 2, ...},
    "heavy-ops":      ...,
    "background-ops": ...
  },
  "limits": {"total": 3, "heavy": 1},
  "topUsers": [{"user_id": "+14105914612", "active_jobs": 2}, ...],
  "totalInFlight": 4
}
```

Returns 503 when `REDIS_URL` is unset (local dev without Redis). AdminPanel "Queues" tab polls every 10s.

## Common gotchas

- **`maxRetriesPerRequest: null`** is mandatory for BullMQ.
- **PUBLISH and SUBSCRIBE** can't share a client. Two IORedis instances.
- **Service-name reference must match exactly** — `${{Redis.REDIS_PRIVATE_URL}}` ≠ `${{Redis_Dev.REDIS_PRIVATE_URL}}`.
- **Don't add Redis as a dependency on a route's response path** unless you can degrade gracefully (return 503 with `Redis unavailable` rather than 500).
- **30-min TTL on user slots** is the wedge that prevents permanent lockout. Don't reduce; raise if heavy ops legitimately exceed 30 min.
- **`isActive` race**: `HEXISTS` first, then `MULTI` write. Reverse order = resurrected expired session.
