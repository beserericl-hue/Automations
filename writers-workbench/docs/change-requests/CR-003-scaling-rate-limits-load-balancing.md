# CR-003 — Scaling: queue, per-instance concurrency, rate-limit coordination, load balancing

| | |
|---|---|
| **Status** | In progress (core wired) |
| **Opened** | 2026-06-05 |
| **Tier** | DEV (config), applies to PROD at go-live |
| **Goal** | Handle 10 concurrent users per engine instance; scale to 20/100 by adding instances behind a load balancer; never overflow the Anthropic account rate limit. |

## Architecture

```
                 ┌─────────────┐   enqueue (Redis/arq)   ┌──────────────────────────┐
 users  ──LB──>  │  gateway(s) │ ───────────────────────>│  Redis (queue + budget)  │
 (HTTP)          │ stateless   │ <── job_id / poll ──────│  shared by ALL instances │
                 └─────────────┘                          └──────────────────────────┘
                                                              ▲            ▲
                                       ┌──────────────────────┘            └───────────────┐
                                ┌──────────────┐                                   ┌──────────────┐
                                │ engine inst 1│  workers pull jobs, do LLM work   │ engine inst 2│  (add for +10 users)
                                │ ~10 users    │                                   │ ~10 users    │
                                └──────────────┘                                   └──────────────┘
```

- **Queue (already present):** every heavy write (`chapter`, `brainstorm`, `research`) is enqueued to
  **arq on Redis** by the gateway and returns a `job_id`; the worker runs it off the request path (no
  300s edge timeout). The gateway is **stateless** — scale it freely behind a Railway load balancer.
- **Per-instance sizing for ~10 users:** two caps keep one instance healthy —
  - arq `WorkerSettings.max_jobs` (concurrent jobs per worker), and
  - **`MAX_CONCURRENT_LLM`** (default 12) — a per-instance semaphore in the LLM router capping
    simultaneous in-flight LLM calls, so a burst of users can't oversubscribe one instance.
- **Account-wide rate-limit coordination (the key piece, now WIRED):** the LLM router reserves budget
  from the **Redis-shared `AnthropicBudget`** before every Anthropic call (`wait_for_capacity`) and
  records actual usage after (`record_usage`). Because the budget lives in the **shared Redis**, ALL
  engine instances draw from ONE per-minute pool — so adding instances does NOT multiply the call
  rate past the account limit; excess calls **wait** for the next window instead of failing on 429.
- **429 backstop:** the Anthropic SDK is built with `max_retries=ANTHROPIC_MAX_RETRIES` (default 5),
  which retries with exponential backoff honoring `Retry-After` — catches any residual burst.

## Horizontal scaling (10 → 20 → 100 users)

- **+10 users = +1 engine instance** on Railway. New instances connect to the SAME Redis (queue +
  budget), so they coordinate automatically — no per-instance rate-limit config drift.
- **Gateway**: stateless; put it behind a Railway load balancer and scale replicas independently.
- **Redis is the shared coordination point** — it must be sized for the combined queue + budget
  traffic (Railway Redis; watch memory + ops/sec as instances grow). It is the one stateful hinge.

## Capacity math (Anthropic Tier 4 / Scale — baked into `DEFAULT_LIMITS`)

- claude-sonnet-4-6: **450k input TPM, 90k output TPM, 1000 RPM** (per model, true 60s sliding window).
- A chapter write ≈ ~8 LLM calls (research + plan + 5 sub-chapters + drift/QA), each ~8k in / ~6k out,
  spread over ~10 min. The output-TPM (90k) is the tightest limit; the budget gates against it so a
  spike of simultaneous chapters queues smoothly rather than 429ing.
- If the account tier changes, set `ANTHROPIC_BUDGET_OVERRIDES` / `ANTHROPIC_TIER` (per
  `writer_engine.rate_limit.anthropic_budget`).

## Config knobs (env)

| Var | Default | Meaning |
|---|---|---|
| `MAX_CONCURRENT_LLM` | 12 | per-instance simultaneous LLM calls (size for ~10 users) |
| `LLM_BUDGET_MAX_WAIT_S` | 300 | how long a call waits for account budget before proceeding to the 429 backstop |
| `ANTHROPIC_MAX_RETRIES` | 5 | SDK 429 retries w/ backoff |
| `REDIS_URL` | — | shared queue + budget; MUST be the same across all instances |

## Done in this CR
- Wired `AnthropicBudget` (Redis-shared) into `LLMRouter.complete` — reserve + record on every
  Anthropic call.
- Added the per-instance `MAX_CONCURRENT_LLM` semaphore in the router.
- Set `AsyncAnthropic(max_retries=...)` 429 backstop.

## Remaining (follow-ups)
- Load test (L6) at 10 + 20 concurrent users on DEV to tune `MAX_CONCURRENT_LLM` / `max_jobs`.
- Prompt caching (cache the system + chapter header across sub-chapter calls) to cut input TPM/cost.
- A Perplexity RPM limiter (use `sliding_window.allow`) for the research step under load.
- Railway: define the gateway LB + the worker-instance scaling policy.
