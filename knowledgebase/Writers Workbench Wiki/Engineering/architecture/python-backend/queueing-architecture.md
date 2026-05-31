---
name: Queueing architecture
description: Redis-backed queue topology, worker pool model, Anthropic token budget gatekeeper, idempotency cache, retry/DLQ semantics, leader election for cron singletons.
type: concept
tags: [architecture, python-backend, queueing, redis, scaling]
last_reviewed: 2026-05-10
---

# Queueing architecture

Backbone of the entire async surface. Every heavy operation flows through here. Designed for: throughput, idempotency, fault tolerance, observability, and per-tenant fairness.

## Substrate: Redis

Single Redis instance per environment (DEV / PROD / Testbed) hosts:
- Queues (jobs in flight)
- Anthropic token budget (sliding window)
- Per-user/tenant slots (concurrency limits)
- Idempotency cache (replay protection)
- Rate limits (per-tenant API throttling)
- Sessions (Eve widget tracking)
- SSE pub/sub (callback fan-out)
- Auth cache (API-key resolution)
- Cron leader-election locks

```
                    Redis (per environment)
        ┌───────────────────────────────────────────────────────┐
        │                                                         │
        │  Queues (arq)                                           │
        │    arq:queue:sync-ops      ZSET (job_id → score=run_at)│
        │    arq:queue:medium-ops    ZSET                         │
        │    arq:queue:heavy-ops     ZSET                         │
        │    arq:queue:background    ZSET                         │
        │    arq:in_progress         HASH (job_id → worker_id)    │
        │    arq:result:{job_id}     STRING (JSON result)         │
        │                                                         │
        │  Anthropic Token Budget (sliding-window Lua)             │
        │    anthropic:budget:claude-sonnet:{minute_bucket}        │
        │    anthropic:budget:claude-haiku:{minute_bucket}         │
        │                                                         │
        │  Concurrency Slots (per user / per tenant)              │
        │    slots:user:{user_id}:total      INT (TTL 30m)        │
        │    slots:user:{user_id}:heavy      INT (TTL 30m)        │
        │    slots:tenant:{tenant_id}:total  INT (TTL 30m)        │
        │                                                         │
        │  Idempotency Cache                                       │
        │    idem:{api_key_id}:{key}    STRING (TTL 24h)           │
        │    idem:internal:{user_id}:{key}                         │
        │                                                         │
        │  Rate Limits (per-minute counter)                        │
        │    rl:tenant:{tenant_id}:{minute}    INT (TTL 70s)      │
        │    rl:user:{user_id}:{minute}                            │
        │                                                         │
        │  Sessions (Eve widget)                                   │
        │    session:{user_id}    HASH {token, lastActivity}       │
        │                                                         │
        │  SSE Pub/Sub                                             │
        │    PUBLISH chan:{user_id} <event_json>                  │
        │                                                         │
        │  Auth Cache (API key resolution)                         │
        │    auth:{api_key_prefix}    HASH {tenant_id, tier, ...}  │
        │                                                         │
        │  Cron Leader Election                                    │
        │    cron:lock:{job_name}    STRING (SETNX + EXPIRE 60s)   │
        │                                                         │
        │  Hub Response Cache (optional)                            │
        │    hub_cache:{prompt_hash}   STRING (TTL 5m)             │
        │                                                         │
        └───────────────────────────────────────────────────────┘
```

## Queue framework: `arq`

[arq](https://arq-docs.helpmanual.io/) — async-native Redis queue for Python. Picked over Celery because:

- **Asyncio-first.** Workers are coroutines. Fits FastAPI naturally.
- **No broker abstraction overhead.** Direct Redis. Predictable.
- **Simpler than Celery.** Fewer footguns. Smaller cognitive load.
- **Battle-tested at scale.** Used by Samuel Colvin (Pydantic creator).

Compatibility note: BullMQ (used in Workbench Express) and arq don't share queue keys. They co-exist on the same Redis with different prefixes (`bull:*` vs `arq:*`). No conflict; no cross-language sharing required.

As Workbench server eventually migrates calls to Python `/v1/*`, BullMQ usage in Workbench shrinks. Eventually deprecated.

## Queue tiers

Mirror of the existing Sprint 10b classification. Each tier has its own queue + worker pool.

| Tier | Concurrency per worker replica | Timeout | Default attempts | Use cases |
|---|---|---|---|---|
| `sync-ops` | 10 | 30s | 1 (no retry — fast fail) | retrieve_content, list_outlines, status checks. **Mostly bypasses queue entirely** — direct call from hub. |
| `medium-ops` | 4 | 120s | 3 (exp backoff) | brainstorm, edit_outline, generate_social, qa_chapter, evaluate_genre, scan_drift, research |
| `heavy-ops` | 2 | 1200s (20min) | 3 | write_chapter, rewrite_chapter_with_research, brainstorm_chapter, cross_chapter_continuity, generate_cover_art |
| `background-ops` | 3 | 300s | 5 (exp backoff) | newsletter ingestion, scheduled publisher, eve_reset_greeting (delayed), trial-warning emails |

Concurrency tunable via env var `ARQ_<TIER>_CONCURRENCY`. Auto-scaling scales replica count.

## Job structure

Every job has:

```python
@dataclass
class Job:
    id: str                       # auto-generated UUID
    queue: str                    # 'heavy-ops' etc.
    function_name: str            # 'write_chapter' etc.
    args: tuple                   # positional
    kwargs: dict                  # keyword
    enqueued_at: datetime
    run_after: datetime | None    # for delayed jobs
    attempts: int = 0
    max_attempts: int = 3
    user_id: str | None           # for slot accounting
    tenant_id: str | None         # for B2B
    request_id: str               # for tracing
    chapter_run_id: str | None    # idempotency key (chapter writes)
    webhook_url: str | None       # for B2B completion callback
    metadata: dict
```

Persisted in Redis ZSET (queue) with `score=run_after_unix_timestamp`. Worker BRPOPLPUSH-equivalent dequeues the lowest-score job.

## Job lifecycle

```
1. enqueue
   ┌──────────────────────────────────┐
   │ INSERT job_queue_v2 row          │
   │   status='queued'                 │
   │   payload={...}                   │
   │ ZADD arq:queue:heavy-ops {score} {job_id} │
   └──────────────────────────────────┘
                   │
                   ▼
2. dequeue (worker polls)
   ┌──────────────────────────────────┐
   │ ZPOPMIN arq:queue:heavy-ops       │
   │ HSET arq:in_progress {job_id} {worker_id} │
   │ UPDATE job_queue_v2                │
   │   status='active'                  │
   │   started_at=now()                 │
   └──────────────────────────────────┘
                   │
                   ▼
3. preflight checks
   ┌──────────────────────────────────┐
   │ tryAcquireSlot(user_id)           │
   │   if !ok:                          │
   │     ZADD queue + delay 5s         │
   │     return DelayedError            │
   │ tryReserveAnthropicBudget(model, est_tokens) │
   │   if !ok:                          │
   │     ZADD queue + delay (next minute) │
   │     return DelayedError            │
   └──────────────────────────────────┘
                   │
                   ▼
4. execute
   ┌──────────────────────────────────┐
   │ try:                              │
   │   result = await handler(args, kwargs) │
   │ except RetryableError:            │
   │   raise (BullMQ-style retry)       │
   │ except FatalError:                │
   │   move to DLQ                      │
   │ finally:                          │
   │   releaseSlot(user_id)             │
   │   releaseAnthropicBudget(actual_tokens) │
   └──────────────────────────────────┘
                   │
                   ▼
5. completion / failure
   ┌──────────────────────────────────┐
   │ ON SUCCESS:                       │
   │   UPDATE job_queue_v2              │
   │     status='completed'              │
   │     result_json=...                 │
   │     duration_ms=...                 │
   │   SETEX arq:result:{job_id} TTL 1h │
   │   PUBLISH chan:{user_id} {type:job-status,status:completed} │
   │   if webhook_url:                   │
   │     enqueue webhook_dispatch job    │
   │                                    │
   │ ON FAILURE (retryable, attempts < max): │
   │   ZADD queue + exp backoff delay   │
   │   UPDATE attempts=attempts+1        │
   │                                    │
   │ ON FAILURE (non-retryable OR max): │
   │   UPDATE job_queue_v2 status='failed' │
   │   PUBLISH chan:{user_id} {type:job-status,status:failed,error:...} │
   │   if webhook_url:                   │
   │     enqueue webhook_dispatch job (failed event) │
   │   move to DLQ for inspection       │
   └──────────────────────────────────┘
```

## Anthropic token budget gatekeeper

The hardest constraint. Anthropic per-minute output token limit at Tier 3: 80k/min for each model. Tier 4: 400k/min. Without a gatekeeper, multiple workers issuing concurrent chapter writes saturate the budget and start hitting 429s.

### Implementation: sliding window via Lua script

```lua
-- KEYS[1] = anthropic:budget:{model}
-- ARGV[1] = current_time_unix
-- ARGV[2] = window_seconds (60)
-- ARGV[3] = budget_limit (80000 for Tier 3 Sonnet)
-- ARGV[4] = requested_tokens

local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

-- Remove expired reservations
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)

-- Sum current reservations
local total = 0
local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
for i = 2, #entries, 2 do
    -- entries[i-1] is value (token_count), entries[i] is score (reserved_at)
    total = total + tonumber(string.match(entries[i-1], "(%d+):"))
end

if total + requested > limit then
    return {0, total, limit}  -- denied
end

-- Reserve
local reservation_id = redis.sha1hex(now .. ':' .. requested .. ':' .. math.random())
redis.call('ZADD', key, now, requested .. ':' .. reservation_id)
redis.call('EXPIRE', key, window * 2)
return {1, reservation_id, total + requested, limit}
```

Worker calls:

```python
async def reserve_budget(model: str, estimated_tokens: int) -> ReservationId | None:
    result = await redis.eval(BUDGET_LUA, 1, f"anthropic:budget:{model}", time.time(), 60, BUDGETS[model], estimated_tokens)
    if result[0] == 0:
        return None  # budget exhausted; caller delays + retries
    return result[1]
```

After Anthropic call completes:

```python
async def release_budget(model: str, reservation_id: str, actual_tokens: int):
    """Trim the reservation if actual < estimated; refund the diff."""
    # Implementation: ZADD with new value (actual_tokens) and same score
    # Or just leave the original reservation; it expires naturally in 60s.
    pass  # natural expiry usually sufficient
```

In practice, release-after-use is unnecessary at our scale — reservations expire in 60s, and over-reservation by ~20% is fine. Skip explicit release for simplicity.

### Per-model budgets

```python
BUDGETS = {
    "claude-sonnet-4-5": int(os.environ.get("BUDGET_SONNET_TPM", 75_000)),  # 80k actual; reserve headroom
    "claude-haiku-4-5":  int(os.environ.get("BUDGET_HAIKU_TPM",  75_000)),
}
```

Headroom (~5k) prevents tipping over due to Anthropic-side counting drift.

### When budget exhausted

Worker:
```python
reservation = await reserve_budget("claude-sonnet-4-5", estimated_tokens=27_000)
if reservation is None:
    log.info("anthropic budget exhausted; delaying", model="claude-sonnet-4-5")
    raise DelayJobError(retry_after_seconds=15)  # arq picks up next iteration
```

`DelayJobError` re-enqueues with delay; doesn't count against retry budget.

## Per-user / per-tenant slots

Prevents one heavy user from starving others.

### Internal users (Workbench)

```python
SLOT_LIMITS_USER = {
    "total": int(os.environ.get("USER_SLOT_TOTAL", 3)),
    "heavy": int(os.environ.get("USER_SLOT_HEAVY", 1)),
}

async def try_acquire_user_slot(user_id: str, kind: str) -> bool:
    """Returns True if slot acquired; False if user is at cap."""
    pipe = redis.pipeline()
    pipe.incr(f"slots:user:{user_id}:total")
    pipe.expire(f"slots:user:{user_id}:total", 1800)
    if kind == "heavy":
        pipe.incr(f"slots:user:{user_id}:heavy")
        pipe.expire(f"slots:user:{user_id}:heavy", 1800)
    results = await pipe.execute()
    total = results[0]
    if total > SLOT_LIMITS_USER["total"]:
        await redis.decr(f"slots:user:{user_id}:total")
        return False
    if kind == "heavy" and results[2] > SLOT_LIMITS_USER["heavy"]:
        await redis.decr(f"slots:user:{user_id}:total")
        await redis.decr(f"slots:user:{user_id}:heavy")
        return False
    return True
```

### B2B tenants

Tenant slots are tier-aware:

```python
SLOT_LIMITS_TENANT = {
    "free":     {"total": 2, "heavy": 1},
    "starter":  {"total": 5, "heavy": 2},
    "pro":      {"total": 20, "heavy": 8},
    "scale":    {"total": 50, "heavy": 20},
    "enterprise": {"total": 200, "heavy": 80},  # configurable
}
```

Same INCR/DECR pattern; key is `slots:tenant:{tenant_id}:total`.

### Slot release

Always in `finally` block:

```python
try:
    result = await handler(args, kwargs)
    return result
finally:
    await redis.decr(f"slots:user:{user_id}:total")
    if kind == "heavy":
        await redis.decr(f"slots:user:{user_id}:heavy")
```

30-min TTL on the slot keys is the safety valve — even if a worker dies before `finally`, slots auto-release after 30 min.

## Idempotency cache

Every async-op request carries (or auto-generates) an idempotency key. Replays return cached result.

```python
async def get_or_set_idempotent(
    key: str,
    namespace: str,  # 'api_key_id' | 'user_id'
    request_body_hash: str,
    handler: Callable,
) -> Any:
    cache_key = f"idem:{namespace}:{key}"
    cached = await redis.get(cache_key)
    if cached:
        cached_dict = json.loads(cached)
        if cached_dict["body_hash"] != request_body_hash:
            raise IdempotencyKeyReusedError()  # 409
        return cached_dict["response"]

    result = await handler()
    await redis.setex(
        cache_key,
        86400,  # 24h
        json.dumps({"body_hash": request_body_hash, "response": result}),
    )
    return result
```

Same key + same body → cached response. Same key + different body → 409. New key → process + cache.

For chapter writes, `chapter_run_id` is the idempotency key. UPSERT on `(content_id, chapter_run_id)` enforces idempotency at the DB layer too — defense in depth.

## Rate limiting

Per-tenant (B2B) sliding-window minute counter:

```python
async def check_rate_limit(tenant_id: str, rpm_cap: int) -> RateLimitResult:
    minute_bucket = int(time.time() / 60)
    key = f"rl:tenant:{tenant_id}:{minute_bucket}"
    count = await redis.incr(key)
    await redis.expire(key, 70)  # slightly > 60 for clock skew
    return RateLimitResult(
        allowed=(count <= rpm_cap),
        remaining=max(0, rpm_cap - count),
        reset_at=(minute_bucket + 1) * 60,
    )
```

Per-user limits same pattern with `rl:user:{user_id}:{minute}` and lower caps.

## Cron leader election

Cron jobs (newsletter ingestion, scheduled publisher, trial check, etc.) must run **exactly once** even if multiple replicas exist. Implementation: Redis SETNX with TTL.

```python
async def run_with_lock(job_name: str, ttl_seconds: int, handler: Callable):
    lock_key = f"cron:lock:{job_name}"
    acquired = await redis.set(lock_key, worker_id, nx=True, ex=ttl_seconds)
    if not acquired:
        log.info("cron lock held by another worker; skipping", job_name=job_name)
        return
    try:
        await handler()
    finally:
        # Lua: only delete if we still own it (don't delete a stale-but-renewed lock)
        await redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1, lock_key, worker_id
        )
```

Allows running cron entry points across multiple worker replicas safely. No singleton container required.

## Webhook delivery (B2B)

When a B2B job completes and `webhook_url` is registered:

```
1. enqueue webhook_dispatch job onto background-ops queue
   payload: {tenant_id, webhook_url, event, data}

2. Worker:
   - Sign body with tenant.webhook_secret (HMAC-SHA256)
   - POST {webhook_url} with X-Author-Agent-Signature header
   - Retry on non-2xx: 3 attempts (5s, 30s, 5m)
   - Log delivery to webhook_deliveries_v2 table

3. After 3 failures: mark delivery as failed.
   Customer can list failed deliveries via /v1/webhooks/{id}/deliveries.
```

## Dead letter queue (DLQ)

Jobs that fail after max retries land in DLQ:

```
arq:queue:heavy-ops:dlq    ZSET (failed jobs)
```

Operator can:
- Inspect via `GET /admin/queues/dlq`
- Replay individually via `POST /admin/queues/dlq/{job_id}/replay`
- Bulk replay
- Permanent delete

DLQ retention: 7 days (TTL on hash entries).

## Observability

Every job lifecycle event emits structured logs + Prometheus metrics:

```python
# Logs
{"event":"job_enqueued","job_id":"...","queue":"heavy-ops","function":"write_chapter","user_id":"+1...","estimated_tokens":27000}
{"event":"job_dequeued","job_id":"...","queue":"heavy-ops","worker_id":"worker-heavy-3"}
{"event":"job_started","job_id":"...","function":"write_chapter"}
{"event":"job_anthropic_budget_reserved","job_id":"...","model":"claude-sonnet-4-5","reserved_tokens":27000}
{"event":"job_completed","job_id":"...","duration_ms":312000,"actual_tokens":24500,"cost_usd":0.367}
```

Metrics:
- `author_agent_jobs_enqueued_total{queue, function}`
- `author_agent_jobs_completed_total{queue, function, status}`
- `author_agent_jobs_failed_total{queue, function, reason}`
- `author_agent_jobs_in_flight{queue}` gauge
- `author_agent_queue_depth{queue}` gauge
- `author_agent_queue_oldest_job_age_seconds{queue}` gauge
- `author_agent_anthropic_budget_remaining{model}` gauge
- `author_agent_user_slot_used{user_id}` gauge (sampled — high cardinality concern)
- `author_agent_idempotency_hits_total`
- `author_agent_rate_limited_total{tenant_id}` (sampled)

Grafana dashboard: per-queue depth + p50/p95/p99 latency + failure rate + Anthropic budget over time.

## Worker process model

Each worker container runs N coroutines (`ARQ_<TIER>_CONCURRENCY`). Coroutines share the container's Redis connection pool + Anthropic client.

```
Container: worker-heavy
  Process: arq worker
    ├── Coroutine 1: poll heavy-ops queue
    ├── Coroutine 2: poll heavy-ops queue
    ├── ... up to ARQ_HEAVY_CONCURRENCY (default 2)
    └── Coroutine N: process current job
```

Multiple replicas of `worker-heavy` Docker = total parallelism = `replicas × ARQ_HEAVY_CONCURRENCY`.

Auto-scaling triggers (Railway / K8s):
- Heavy-ops queue depth > 20 → +1 replica
- Heavy-ops queue depth < 5 for 10 min → -1 replica (min 2)
- Worker container CPU > 80% sustained → +1 replica

Min replicas per environment:
- DEV: 1 worker-heavy, 1 worker-light, 0 worker-cron (light handles cron via leader election in DEV)
- PROD initial: 3 worker-heavy, 2 worker-light, 1 worker-cron
- PROD scaled: 5-10 worker-heavy, 3-4 worker-light, 1-2 worker-cron

## Failure modes + recovery

| Failure | Detection | Recovery |
|---|---|---|
| Worker crashes mid-job | arq heartbeat timeout (60s) | Job re-enqueues automatically |
| Redis goes down | Worker / api healthcheck fails | All requests fail; LB returns 503; recovery automatic when Redis returns |
| Anthropic 429 burst | Worker error metric | Token budget gatekeeper backs off; queue depth grows briefly |
| Stuck job (handler hangs) | arq timeout config (per tier) | Worker raises TimeoutError; job retries up to max_attempts |
| Worker process OOM | Container exit | Railway / K8s restarts; jobs re-enqueue |
| Idempotency cache TTL expires before retry | unlikely (24h) | New request body validated normally |
| Cron lock held by dead worker | TTL expires (60s) | Next worker acquires; missed run if TTL > cadence |
| Webhook delivery loop | After 3 attempts | Marked failed; customer alerted via dashboard |

## Capacity model

Per worker replica:
- 2 heavy concurrency × 5min average wall time = 0.4 chapters/replica/min = 24/replica/hour
- 4 medium concurrency × 1min average = 4 medium ops/replica/min = 240/replica/hour
- 10 sync concurrency × 5sec = 120/replica/min = 7200/replica/hour (mostly bypass queue)

3 replicas worker-heavy: 72 chapters/hour ceiling.
5 replicas: 120/hr.
10 replicas: 240/hr — but Anthropic Tier 3 caps at ~178/hr. So 5-7 replicas saturates the budget.

Tier 4: 5-10 replicas can do 480-960/hr.

## Why arq vs alternatives

| Framework | Pros | Cons | Verdict |
|---|---|---|---|
| **arq** | asyncio-native, simple, predictable | smaller ecosystem | ✓ chosen |
| Celery | battle-tested, huge ecosystem | sync-first; asyncio adapter mediocre; broker abstraction adds complexity | rejected |
| RQ | simple, Python-native | sync-only; heavy boilerplate to wrap async work | rejected |
| Dramatiq | good ergonomics, supports asyncio | smaller community | viable alternative |
| Faust | streams + asyncio | more complex than needed for simple queues | overkill |
| Custom Redis Streams | maximum control | reinvents the wheel | rejected |

## Migration notes

During [[python-migration-roadmap|migration]]:
- Workbench Express server keeps BullMQ for `chat-proxy` queue.
- Python services use arq for their internal queues.
- Both on same Redis; different prefix; no conflict.
- Eventually Workbench `chat-proxy` migrates to call Python hub directly (Sprint 22 hub migration); BullMQ usage in Workbench shrinks.
- Post-migration: BullMQ in Workbench can be deprecated entirely if Workbench no longer queues async work itself.

## Cross-references

- [[scaling-architecture]] — visual deployment topology + scaling math.
- [[hub-architecture]] — hub uses these queues.
- [[api-contracts]] — async-op endpoints reference queue tiers.
- [[multi-tenancy]] — tenant slots + rate limits are queue-layer concerns.
- [[observability-deployment]] — operational dashboards.
