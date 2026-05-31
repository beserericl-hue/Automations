---
name: Design feasibility — chapter writer multi-instance architecture
description: Evaluation of the proposed 10-instance load-balanced chapter writer architecture against scaling targets (100+ daily users). Surfaces gaps in the existing Sprints 16-18 plan and recommends concrete refinements.
type: concept
tags: [sprints, design, chapter-writer, scalability, sprint-16-18]
last_reviewed: 2026-05-09
---

# Design feasibility — chapter writer multi-instance architecture

Captured 2026-05-09 in response to a user-driven evaluation request: scaling target 100 daily users minimum, with a proposed architecture of 10 n8n instances behind a load balancer + external queue + lock-to-instance + self-contained queue payload + chaos testing.

This page evaluates the feasibility + scalability of that architecture against the existing [[planned-sprints|Sprints 16-18 plan]] and recommends concrete refinements.

## What the user proposed

1. Queue write_chapter calls **outside n8n**.
2. **10 instances** of `Worker - Write Chapter` running load-balanced.
3. **10 workflow requests queued outside n8n**, executing in queue order.
4. Reduce wall time per chapter execution.
5. Preserve story arc + character data through the queue (no loss).
6. **Lock chapter to a single instance** so all data needed for the chapter is part of the queue package.
7. Test for error compensation.
8. **N number of n8n servers connected via load balancer** (multi-server, not just multi-workflow-on-one-server).

## Where the existing design is right

The Sprints 16-18 plan in [[planned-sprints]] already has these bones:

- Workbench-side dispatcher (BullMQ heavy-ops queue, exists since Sprint 10b — see [[sprint-10b-bullmq]]).
- Redis-backed `AnthropicTokenBudget` reserve/release.
- N parallel `Worker - Write Chapter` instances behind round-robin selection.
- Shadow mode + 10/50/100% traffic shift + zero-429 enforcement.

## Where the existing design was underspecified

Five gaps the user correctly identified:

1. **Token budget is the bottleneck, not n8n compute.** It was listed as a bullet; not made the spine of the architecture.
2. **Multi-server vs multi-workflow-on-one-server distinction was missing.** "10 instances of the workflow" can mean (a) 10 concurrent executions on one n8n or (b) 10 separate n8n servers. (a) shares host Node process + memory + DB-pool limits; (b) is true horizontal scaling. User is asking for (b).
3. **Self-contained queue package was not in the plan.** Current BullMQ payload is `{user_message_request, user_id}` — minimal. If a chapter is mid-flight when an instance dies, the surviving infra has nothing to resume from.
4. **Lock-to-instance was implied but not explicit.** Once the hub on instance-3 calls `executeWorkflow` for `Worker - Write Chapter`, n8n keeps it on instance-3 (workflow execution is host-local). That's free — but only if the LB pins inbound webhook to that instance for the duration. Never said this.
5. **Error compensation tests were not detailed.** "Zero-429 enforcement" gates rollout phases but doesn't enumerate the failure modes or the chaos-test matrix.

## Feasibility — math against 100 daily users

Concrete numbers, not hand-waving.

### Demand model

- 100 users/day, 1-3 chapters per active user → ~200 chapters/day.
- Burst: 4× concentration in peak 4 hours → **50 chapters/hour peak**.
- 5 min wall time/chapter (current baseline) → 250 chapter-minutes/hour needed at peak.
- Capacity: 60 min × N instances × 1 chapter/instance = 60N chapter-minutes/hour.
- Need N ≥ 4.2. **5 instances meets demand. 10 instances = 2× headroom for spike + instance-loss.**

### Anthropic token budget at the bottleneck

Per chapter (current architecture, post-Sprint 12 hotfix):
- 5 sub-chapters × 4k output tokens = 20k
- continuity merge ≈ 5k
- extract_bible ≈ 2k
- **Total ≈ 27k output tokens per chapter**

At 50 chapters/hour: 1.35M output tokens/hour ≈ 22.5k tokens/min average.

| Anthropic Tier | Output tokens/min ceiling | Average utilization | Verdict |
|---|---|---|---|
| Tier 3 (current) | 80,000 | 28% | Fine on average |
| Tier 4 | 400,000 | 5.6% | Massive headroom |

But **peak concurrent in-flight** is the real risk:
- ~4-5 chapters running concurrently at 5-min wall time + 50/hr arrival.
- If all 5 sub-chapters fire simultaneously per chapter (the Sprint 12 Track A goal): 5 chapters × 5 sub-chapters × 4k = **100k tokens reserved instantaneously**.
- **Exceeds Tier 3's 80k/min limit.**
- **Tier 4 (400k/min) gives 5× headroom.** This is the actual architectural unlock.

### The verdict

**10 n8n instances on Tier 3 will throttle each other via the budget gatekeeper.**

The token budget — not n8n CPU — is the gate. **Buying more instances past ~5 doesn't help unless we also raise the Anthropic tier.** This is the inconvenient truth at the heart of the design.

## Evaluating the proposed architecture point-by-point

| Proposal | Verdict | Why |
|---|---|---|
| 10 n8n instances behind LB | **Reasonable as headroom; over-provisioned for raw throughput.** | Need 5; 10 gives margin for spike + instance loss. |
| Queue OUTSIDE n8n with self-contained payload | **Right pattern; refine BullMQ payload.** | The queue exists ([[job-queue|Sprint 10b BullMQ]]); payload needs to fatten so a stuck chapter is restartable. |
| Lock chapter to one instance (data-locality) | **Free at workflow-execution level; explicit at LB.** | n8n executeWorkflow stays host-local. LB needs sticky routing for the webhook duration. |
| Reduce wall time per chapter | **Lever exists; biggest gains from LLM choice + skipping merge.** | Sprint 17 LLM bake-off is the unlock. Haiku 4.5 for routine sub-chapters could 2-3× throughput. |
| Don't lose story arc + character data | **Already addressed; reinforce.** | LOCKED CHARACTER ROSTER ([[chapter-writer-architecture|Sub - Build Chapter Context]]) + extract_bible (post-hotfix) feed each other. Data lives in queue payload + Supabase reads. |
| Error compensation testing | **Needs explicit chaos matrix.** | Sprint 18 mentions zero-429 gating; needs a real test list. |

**Verdict on feasibility**: yes, the architecture works. The math closes for 100 daily users on 5-10 n8n instances, **provided we upgrade to Anthropic Tier 4 and pin chapter-running to a single instance**. Below the 100-user line, even today's single-instance worker handles demand at ~50% utilization; the reason to do this work isn't 100 users — it's headroom for **growth past 500 users** without architectural rework.

## Scalability ceiling

| Tier | Limit | Chapters/hour ceiling | Daily users supported |
|---|---|---|---|
| **Anthropic Tier 3** (80k output/min) | 80k × 60 / 27k ≈ 178/hr | 25-50 active at peak burst | **100-200 daily** |
| **Anthropic Tier 4** (400k output/min) | 400k × 60 / 27k ≈ 889/hr | 125-250 active at peak burst | **500-1000 daily** |
| **Multi-LLM strategy** (Haiku for routine, Sonnet for critical) | Effective tokens drop ~40% | Tier 4 + multi-LLM ≈ 1500/hr | **1500-3000 daily** |

Past **1000 daily users**, the next bottleneck shifts:
- Postgres connection pool (currently default Supabase ~30) — needs PgBouncer / pooling.
- BullMQ Redis ops/sec (manageable to ~10k/sec on small Redis).
- Postal queue (Postal handles thousands/min — fine).

The architecture described is **scalable to ~1000 daily users without further structural change** if paired with the multi-LLM strategy.

## Concrete refinements to Sprints 16-18

### Sprint 16 — refine analysis harness (was 26 pts → 34 pts)

Add to existing stories:

- **S16-5 (NEW, 3 pts)** — Per-chapter token-cost profiler. Run 50 representative chapters, record `(input_tokens, output_tokens, wall_time_s)` per sub-call. Output: empirical distribution feeding the budget gatekeeper's reserve estimates. We're guessing 27k tokens/chapter; real distribution could be 15-40k. Real numbers shift "5 or 10 instances" decisively.

- **S16-6 (NEW, 5 pts)** — Anthropic tier upgrade evaluation. Budget request to upgrade to Tier 4. Wait time / deposit requirements from Anthropic. Cost-per-token at each tier. **This is the single biggest unlock**; everything else in Sprint 18 is downstream of this number.

### Sprint 17 — central the token budget (was 29 pts → 37 pts)

Restructure S17-3 around the token budget:

- **S17-3a (NEW, 5 pts)** — `AnthropicTokenBudget` Lua-script implementation in Redis. Sliding window over current minute; reserve operations atomic; release on completion or timeout. Failure mode: if budget can't be reserved within 30s, fail-fast and let BullMQ retry.

- **S17-3b** — ChapterDispatcher (was S17-3). Now downstream of token budget — only selects an instance after `reserve()` succeeds. Round-robin least-busy among healthy instances.

- **S17-3c (NEW, 3 pts)** — Self-contained queue payload schema. Pre-built sub-chapter prompts + LOCKED CHARACTER ROSTER + research findings + project metadata. Payload size budget: 256 KB max. If exceeded, store in S3-style blob and queue the URL.

### Sprint 18 — chaos test matrix (was 34 pts → 39 pts)

Add to existing stories:

- **S18-X (NEW, 5 pts)** — Error compensation test suite. Required tests:
  - Kill instance N mid-chapter → BullMQ retry on instance M, idempotent re-write.
  - Anthropic 429 during sub-chapter → budget held, exponential backoff, retry succeeds.
  - Postgres connection drop → Supabase auto-reconnect; chapter completes.
  - Postal API down → email queues separately; chapter row marked complete; email retried offline.
  - Redis flaps → BullMQ workers reconnect; in-flight reservations recovered from `job_queue_v2` audit.
  - Cloudflare 524 on inbound webhook → LB retries against another instance.
  - LB picks dead instance → health-check intercept; route around.
  - **Idempotency keys**: every chapter run carries `chapter_run_id` UUID; every external write keyed to it. `UPSERT published_content_v2 ON CONFLICT (id, chapter_run_id) DO UPDATE`. Storage upsert with `chapter_run_id` in path. Re-runs don't double-write.

### NEW Sprint 18.5 — multi-server n8n provisioning (16 pts)

The existing plan assumes "N parallel workflow instances on the same n8n." Multi-server adds:

- **S18.5-1 (8 pts)** — Provision n8n2..n8n5 (or n8n10) on Railway (or alternative host). Each gets:
  - Own Postgres database (n8n's metadata) — separate, NOT shared.
  - Same n8n version + plugins.
  - Workflow-deploy script that pushes the same `Worker - Write Chapter` to all instances at promotion time (`scripts/promote-dev-to-prod.py` extended to N instances).

- **S18.5-2 (3 pts)** — Sticky-session LB. Cloudflare Load Balancer (already in use) with `chapter_run_id` cookie or path-based routing pinning a chapter to its assigned instance for its duration. Per-instance health checks.

- **S18.5-3 (5 pts)** — Per-instance health monitoring on `/api/health` equivalents (n8n exposes `/healthz`). Grafana dashboard for utilization, queue depth, in-flight chapter count per instance.

**Total Sprint 18 family**: 39 + 16 = 55 pts. The difference between a working architecture and one that survives a real outage.

## Recommendations before writing more spec

1. **Get pricing + lead-time from Anthropic for Tier 4.** Single biggest unlock. If unavailable or costly, architecture pivots toward multi-LLM (Haiku for sub-chapters) — different design.

2. **Run S16-5 (token cost profiler) BEFORE committing to N.** Real numbers shift instance count from 5 to 10 (or vice versa) decisively.

3. **Validate lock-to-instance assumption with one prototype** — single secondary n8n instance behind a sticky LB, route 10% of DEV traffic for a week. Confirms the workflow-execution-host-local hypothesis without committing to 10 instances first.

4. **Decide where `chapter_run_id` idempotency lives.** Two options:
   - Migration ≥018 adds `chapter_run_id uuid` column to `published_content_v2`. New base column = governance review. Indexed lookups.
   - JSONB-only: `metadata.chapter_run_id`. No schema change. Loose. Recommended for speed.

5. **Decide between Cloudflare LB and a self-managed LB.** Cloudflare is already fronting all our traffic; sticky sessions via cookie or path-prefix is a known feature. Self-managed (HAProxy/Nginx) gives more control but adds an ops surface.

## Cross-system implications

| System | Change required |
|---|---|
| [[chapter-writer-architecture|Worker - Write Chapter]] | Accept `chapter_run_id` in payload; thread through every external write for idempotency. |
| [[job-queue|BullMQ]] | Payload schema fattens (256 KB cap). Self-contained: prompts + roster + research pre-built. |
| [[redis-bullmq|Redis]] | Add `AnthropicTokenBudget` Lua-script slot reservations. |
| [[express-routes|/api/chat/proxy]] | Pre-build chapter prompt + character roster server-side before enqueue. |
| [[base-tables|published_content_v2]] | Add `chapter_run_id` column OR JSONB metadata. |
| [[deployment-railway|Railway]] | Provision n8n2..n8n5+ services with separate Postgres each. Same env-var profile as PROD n8n. |
| [[promotion-dev-to-prod|Promotion script]] | Extend to deploy workflows to N instances. |
| [[ci-pipeline|CI]] | Add chaos-test matrix as required check before promoting `Worker - Write Chapter` changes. |
| [[testing/regression-tests|Regression tests]] | New B14: instance crash mid-chapter → idempotent retry. New B15: Anthropic 429 → budget gate retry. |

## Open questions / unknowns

1. **Anthropic Tier 4 application timeline.** Could be days; could be weeks.
2. **n8n self-hosted licensing for 10+ instances.** Community Edition for personal/internal use; commercial-use threshold unclear at scale. Consult license + n8n team if growth past 1000 users.
3. **Cloudflare Load Balancer cost** at the volume we'd push through it.
4. **Multi-LLM quality risk.** Haiku-written sub-chapters may have lower prose quality. Sprint 17 bake-off must include human-grade quality scoring, not just token cost.
5. **Per-instance Postgres for n8n metadata.** 10 separate databases × Postgres connections × cost. Could share via schema-per-instance on a single Postgres.

## Where this conversation should land

- Update [[planned-sprints]] Sprints 16-18 to reflect refined story counts (16 → 34 pts; 17 → 37 pts; 18 → 39 pts; new 18.5 → 16 pts).
- Update [[chapter-writer-architecture]] "multi-instance" section with the budget-as-bottleneck framing.
- Add B14 + B15 entries to [[regression-tests]] for the new failure modes.
- This page (`design-feasibility`) becomes the working document for the multi-sprint design discussion.
