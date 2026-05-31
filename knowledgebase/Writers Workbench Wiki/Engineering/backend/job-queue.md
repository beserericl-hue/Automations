---
name: Job queue (BullMQ)
description: Workers, job tracker, per-user concurrency, SSE forwarder. End-to-end async path.
type: concept
tags: [backend, bullmq, queue]
last_reviewed: 2026-05-09
---

# Job queue

[`server/src/lib/jobs/`](../../../../writers-workbench/server/src/lib/jobs/). Sprint 10b. Backed by [[redis-bullmq|Redis]].

## Files

- [`types.ts`](../../../../writers-workbench/server/src/lib/jobs/types.ts) — QueueName, PriorityTier, QUEUE_SETTINGS, payload interfaces.
- [`classifier.ts`](../../../../writers-workbench/server/src/lib/jobs/classifier.ts) — regex-rule message classifier.
- [`n8n-worker.ts`](../../../../writers-workbench/server/src/lib/jobs/n8n-worker.ts) — Worker factory; HTTP retry semantics.
- [`concurrency.ts`](../../../../writers-workbench/server/src/lib/jobs/concurrency.ts) — per-user slot acquire/release.
- [`job-tracker.ts`](../../../../writers-workbench/server/src/lib/jobs/job-tracker.ts) — addTrackedJob + attachTrackerToQueue.
- [`sse-forwarder.ts`](../../../../writers-workbench/server/src/lib/jobs/sse-forwarder.ts) — bullmq events → SSE.
- [`boot.ts`](../../../../writers-workbench/server/src/lib/jobs/boot.ts) — startAllWorkers (called from index.ts).

## Queue topology

```ts
type QueueName = 'sync-ops' | 'medium-ops' | 'heavy-ops' | 'background-ops';

QUEUE_SETTINGS = {
  'sync-ops':       {concurrency:10, timeoutMs:   30_000},
  'medium-ops':     {concurrency: 4, timeoutMs:  120_000},
  'heavy-ops':      {concurrency: 2, timeoutMs:1_200_000},  // 20 min
  'background-ops': {concurrency: 3, timeoutMs:  300_000},
};
```

Default job options: `attempts: 3`, exponential backoff 5s, retain 1000 completed/failed jobs (capped to 1h/24h).

## Job types

```ts
type N8nWebhookJob = {
  url: string;          // hub webhook url
  body: object;         // {user_message_request, user_id, ...}
  user_id: string;
  trackerRowId: string; // FK to job_queue_v2 row
  isHeavy: boolean;     // for concurrency slot accounting
};
```

Other types reserved for future use (image gen, batch ops).

## addTrackedJob

```ts
async function addTrackedJob(
  queueName: QueueName,
  jobName: string,
  payload: object,
  userId: string
): Promise<{jobId: string, trackerRowId: string}> {
  // INSERT job_queue_v2 row first (so tracker exists before BullMQ may emit events)
  const trackerRow = await supabaseAdmin.from('job_queue_v2').insert({
    user_id: userId,
    queue_name: queueName,
    job_name: jobName,
    status: 'queued',
    payload,
  }).select().single();

  // Enqueue
  const queue = getNamedQueue(queueName);
  const job = await queue.add(jobName, {...payload, trackerRowId: trackerRow.id}, {
    attempts: 3,
    backoff: {type:'exponential', delay: 5_000},
  });

  return {jobId: job.id, trackerRowId: trackerRow.id};
}
```

## n8n-worker

```ts
function createN8nWorker({queueName, concurrency, timeoutMs}) {
  return new Worker<N8nWebhookJob>(queueName, async (job) => {
    const {url, body, user_id, isHeavy} = job.data;

    // 1. Acquire user slot
    const acquired = await tryAcquireUserSlot(user_id, isHeavy ? 'heavy' : 'normal');
    if (!acquired) {
      await job.moveToDelayed(Date.now() + 5_000, job.token);
      throw new DelayedError();   // BullMQ — not a retry
    }

    try {
      // 2. POST to n8n hub
      const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      // 3. HTTP retry semantics
      if (response.status >= 200 && response.status < 300) {
        return await response.json();           // success
      }
      if (response.status >= 400 && response.status < 500) {
        return {ok:false, status: response.status};  // user error — no retry
      }
      throw new Error(`HTTP ${response.status}`);  // 5xx / network — BullMQ retries

    } finally {
      // 4. Release slot regardless of outcome
      await releaseUserSlot(user_id, isHeavy ? 'heavy' : 'normal');
    }
  }, {connection: redis, concurrency});
}
```

Critical retry semantics:
- **2xx** → return the body. Job marked completed.
- **4xx** → return `{ok:false}`. Job marked completed (NO retry — user error).
- **5xx / network / timeout** → throw. BullMQ retries up to `attempts: 3`.

## Per-user concurrency

```ts
DEFAULT_LIMITS = {total: 3, heavy: 1};

async function tryAcquireUserSlot(userId, kind: 'normal'|'heavy') {
  const total = await redis.incr(`userSlot:${userId}:total`);
  await redis.expire(`userSlot:${userId}:total`, 1800);
  if (total > DEFAULT_LIMITS.total) {
    await redis.decr(`userSlot:${userId}:total`);
    return false;
  }
  if (kind === 'heavy') {
    const heavy = await redis.incr(`userSlot:${userId}:heavy`);
    await redis.expire(`userSlot:${userId}:heavy`, 1800);
    if (heavy > DEFAULT_LIMITS.heavy) {
      await redis.decr(`userSlot:${userId}:heavy`);
      await redis.decr(`userSlot:${userId}:total`);
      return false;
    }
  }
  return true;
}
```

30-min TTL safety valve — even if a worker crashes leaving slots locked, they auto-release.

## Tracker (`job_queue_v2`)

`attachTrackerToQueue(queue)` sets up `QueueEvents` listeners:

```
'waiting'    → UPDATE job_queue_v2 SET status='queued'
'active'     → UPDATE job_queue_v2 SET status='active', started_at=now()
'completed'  → UPDATE job_queue_v2 SET status='completed', finished_at=now(), duration_ms, result_json
'failed'     → UPDATE job_queue_v2 SET status='failed', finished_at=now(), error_text
'delayed'    → (no DB update — internal slot logic)
```

Schema:
```
job_queue_v2
  id            uuid PK
  user_id       text NOT NULL FK
  queue_name    text NOT NULL
  job_name      text NOT NULL
  status        text NOT NULL CHECK (status IN ('queued','active','completed','failed'))
  payload       jsonb
  result_json   jsonb
  error_text    text
  duration_ms   int
  attempts      int DEFAULT 0
  created_at    timestamptz DEFAULT now()
  started_at    timestamptz
  finished_at   timestamptz
```

Indexes on `(user_id, status)`, `(created_at)`. RLS: own rows only.

## SSE forwarder

```ts
function attachSseForwarder(queue, pushSseEvent) {
  const events = new QueueEvents(queue.name);
  events.on('waiting',   ({jobId}) => pushSseEvent(getUserIdForJob(jobId), {type:'job-status', jobId, status:'queued'}));
  events.on('active',    ({jobId}) => pushSseEvent(..., {type:'job-status', jobId, status:'active'}));
  events.on('progress',  ({jobId, data}) => pushSseEvent(..., {type:'job-status', jobId, status:'active', progress: data}));
  events.on('completed', ({jobId}) => pushSseEvent(..., {type:'job-status', jobId, status:'completed'}));
  events.on('failed',    ({jobId, failedReason}) => pushSseEvent(..., {type:'job-status', jobId, status:'failed', error: failedReason}));
}
```

`pushSseEvent` is the abstraction from `lib/sse-pubsub.ts` — Redis PUBLISH. See [[session-and-sse]].

## boot.ts

```ts
async function startAllWorkers() {
  for (const queueName of Object.keys(QUEUE_SETTINGS) as QueueName[]) {
    const queue = initNamedQueue(queueName);
    attachTrackerToQueue(queue);
    const worker = createN8nWorker({
      queueName,
      ...QUEUE_SETTINGS[queueName],
    });
    attachSseForwarder(worker, pushSseEvent);
  }
}
```

Called from `server/src/index.ts` after the HTTP server starts listening.

## Cancellation

`POST /api/jobs/:id/cancel` — only allowed for `waiting` or `delayed` status. Active jobs cannot be cancelled (BullMQ doesn't support clean cancellation mid-execution).

```ts
const job = await queue.getJob(jobId);
if (['waiting','delayed'].includes(await job.getState())) {
  await job.remove();
  await supabaseAdmin.from('job_queue_v2').update({status:'failed', error_text:'Cancelled by user'}).eq('id', trackerRowId);
}
```

## Admin queue dashboard (Sprint 10b-4)

`GET /api/admin/queues`:
```json
{
  "queues": {
    "sync-ops":   {"waiting":0, "active":0, "delayed":0, "completed":12, "failed":0, "concurrency":10},
    "medium-ops": ...,
    "heavy-ops":  ...,
    "background-ops": ...
  },
  "limits": {"total":3, "heavy":1},
  "topUsers":[{"user_id":"+14105914612","active_jobs":2}, ...],
  "totalInFlight": 4
}
```

503 when REDIS_URL unset. AdminPanel "Queues" tab polls every 10s.

## Pre-S10b-1 behavior

Before Sprint 10b-1, every chat call was synchronous: server → fetch n8n → wait → return. Heavy ops tied up an HTTP socket for 10-20 minutes, hitting Cloudflare 524 timeouts.

Sprint 10b-3 migrated `/api/chat/proxy` to async via this queue. Sync ops still bypass.

## Common gotchas

- **`maxRetriesPerRequest: null`** on the IORedis client. Required by BullMQ.
- **DelayedError** vs Error vs returning `{ok:false}` — pick the right one.
- **Slot release in `finally`** — without it, a thrown error orphans the slot until 30-min TTL.
- **`attachTrackerToQueue` must run before workers process jobs** — otherwise the first `'waiting'` event has no listener and the tracker row never updates.
- **n8n response timeout 1200000ms** for heavy-ops queue — Cloudflare cuts before this. Budget 90s for sync hub fetches.
- **`X-Credits-Remaining` header** returned on every chat-proxy response so the UI can refresh the credits pill.
