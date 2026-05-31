---
name: Session + SSE
description: Eve session store + sse-pubsub + EventSource flow.
type: concept
tags: [backend, session, sse, sprint-5, sprint-10b]
last_reviewed: 2026-05-09
---

# Session + SSE

Sprint 5 introduced session tracking + SSE callbacks. Sprint 10b-5 moved session state from in-memory to Redis (so multiple server instances behind the load balancer share state).

## Session store

[`server/src/lib/session-store.ts`](../../../../writers-workbench/server/src/lib/session-store.ts). Interface:

```ts
type SessionStore = {
  register(userId: string, token: string): Promise<void>;
  unregister(userId: string): Promise<void>;
  isActive(userId: string): Promise<boolean>;
  list(): Promise<{userId: string, lastActivity: number}[]>;
  count(): Promise<number>;
};
```

### Redis impl

```ts
async register(userId, token) {
  const key = `session:${userId}`;
  await redis.multi()
    .hset(key, {token, lastActivity: Date.now()})
    .expire(key, 1800)   // 30 min TTL
    .exec();
}

async isActive(userId) {
  // CRITICAL: HEXISTS BEFORE the MULTI write
  // so an expired key doesn't get resurrected by HSET lastActivity
  const exists = await redis.hexists(`session:${userId}`, 'token');
  return exists === 1;
}

async count() {
  let cursor = '0';
  let total = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
    cursor = next;
    total += keys.length;
  } while (cursor !== '0');
  return total;
}
```

`isActive` is called by n8n's `Sub - Eve Knowledge Callback` to decide web vs phone. The HEXISTS-before-MULTI pattern was a real bug: the original code did MULTI first, which `HSET lastActivity` resurrected the key after expiry.

### In-memory fallback

For local dev without Redis. Doesn't share state across server instances — fine for single-process dev.

## SSE pub/sub

[`server/src/lib/sse-pubsub.ts`](../../../../writers-workbench/server/src/lib/sse-pubsub.ts).

### `publishSseEvent`

```ts
async function publishSseEvent(userId: string, event: object): Promise<void> {
  const channel = `chan:${userId}`;
  await publisherRedis.publish(channel, JSON.stringify(event));
}
```

Uses the main Redis client (the one BullMQ uses).

### `subscribeSseChannel`

```ts
function subscribeSseChannel(userId: string, handler: (event: object) => void): () => void {
  const channel = `chan:${userId}`;
  // First listener for this user → SUBSCRIBE to Redis
  const handlers = localHandlers.get(channel) ?? [];
  if (handlers.length === 0) {
    subscriberRedis.subscribe(channel);
  }
  handlers.push(handler);
  localHandlers.set(channel, handlers);

  return () => {
    // unsubscribe
    const remaining = (localHandlers.get(channel) ?? []).filter(h => h !== handler);
    if (remaining.length === 0) {
      subscriberRedis.unsubscribe(channel);
      localHandlers.delete(channel);
    } else {
      localHandlers.set(channel, remaining);
    }
  };
}

subscriberRedis.on('message', (channel, message) => {
  const handlers = localHandlers.get(channel) ?? [];
  const event = JSON.parse(message);
  handlers.forEach(h => h(event));
});
```

**Two IORedis clients required** because SUBSCRIBE makes the client read-only — you can't run other commands on it. Sprint 10b-5 lesson.

Ref-counted local handlers: only SUBSCRIBE on the first local listener for a channel; UNSUBSCRIBE on the last. Multiple SSE connections from the same user (two browser tabs) share one Redis subscription.

## EventSource endpoint

`/api/session/events?token=<jwt-or-short-token>`:

```ts
router.get('/events', async (req, res) => {
  const token = req.query.token;
  const userId = await validateToken(token);   // can't use Authorization header on EventSource
  if (!userId) return res.status(401).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // disable nginx buffering
  });
  res.flushHeaders();

  const unsubscribe = subscribeSseChannel(userId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // keep-alive ping every 25s (Cloudflare cuts at ~30s idle)
  const pingInterval = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(pingInterval);
    unsubscribe();
  });
});
```

## Event types

| Type | Producer | Consumer |
|------|----------|----------|
| `content-ready` | n8n `/api/callback/content-ready` | AppShell → toast + invalidate |
| `job-status` | BullMQ events via sse-forwarder | ChatDrawer → pill update |
| `newsletter:approval-changed` | server (after approval action) | NewsletterApprovals refresh |
| `newsletter:execution-status` | n8n `/api/newsletter/cron-callback` (per stage) | ExecutionStatus live progress |
| `eve:loaded` | n8n `Sub - Eve Knowledge Callback` (web mode) | ChatDrawer / AppShell |

## Eve session lifecycle

```
Eve widget mounts (EveWidget.tsx)
  → POST /api/session/register {token}
       sessionStore.register(userId, token)

n8n Sub - Eve Knowledge Callback:
  → GET /api/session/active?user_id=X
  → if active: POST /api/callback/content-ready (publishes SSE)
       AppShell receives via subscribeSseChannel → handler fires → toast + invalidate
  → if inactive: ElevenLabs outbound call

Eve widget unmounts:
  → DELETE /api/session/unregister
       sessionStore.unregister(userId)
```

## `/api/health` integration

Sprint 10b-5 added `active_sessions` field:

```ts
const activeSessions = await sessionStore.count();
return {
  status:'ok', version, deployed_at, environment,
  checks:{supabase, redis, postal},
  active_sessions: activeSessions
};
```

Failure to read does not fail the health check (try/catch).

## Graceful shutdown

```ts
async function gracefulShutdown() {
  await server.close();           // drain HTTP
  await closeAllQueues();          // BullMQ workers
  await closeRedis();              // main client
  await closeSsePubsub();          // subscriber client + clear local handlers
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
```

Without `closeSsePubsub`, the subscriber client lingers and Railway's deploy reconnects can pile up.

## Known gotchas

- **EventSource can't set Authorization header** — use `?token=` query param. Server validates from the query.
- **Cloudflare timeouts at 30s idle** — keep-alive ping every 25s.
- **Two IORedis clients** — SUBSCRIBE blocks command execution. Don't try to share one.
- **`HEXISTS` before `MULTI`** — sequence matters. See above.
- **`sessionStore.count()` uses SCAN** — O(n) on number of session keys. Cheap at our scale; could become slow at >100k.
- **`X-Accel-Buffering: no`** — disables nginx (or Cloudflare) buffering. Without it, SSE events delay until the buffer fills.
- **Two browser tabs from same user** — both subscribe via same channel. Local handlers ref-counted so SUBSCRIBE/UNSUBSCRIBE only happen on first/last.
