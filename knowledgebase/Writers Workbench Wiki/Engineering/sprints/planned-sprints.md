---
name: Planned sprints
description: Sprint 9 (Stripe), 13 (deprecated), 14 (storage decision), 15 (load test), 16-18 (chapter writer multi-instance architecture). Sequencing now driven by [[work-ordering-2026-05]] — Sprint 9 is held last, Sprint 15 is next after newsletter PROD ship.
type: concept
tags: [sprints, planned]
last_reviewed: 2026-05-25
---

# Planned sprints

Source: `writers-workbench/sprint_document_v2.md` Sprints 9-18 (with the 2026-04-29 rewrite).

Total remaining: **241 firm pts + 34 conditional**.

> **Sequencing (updated 2026-05-25):** see [[work-ordering-2026-05]]. The original `9 → 13 → 14 → 15 → 16 → 17 → 18` order is **superseded**. New order: newsletter PROD ship (Gate 1) → Sprint 15 (Gate 2) → Sprints 16-22 Python rewrite (Gate 3) → Sprints 23-27 B2B platform (Gate 4) → Sprint 9 Stripe last (Gate 5). Story lists on this page remain authoritative for *what's in* each sprint; the ordering page is authoritative for *when*.

## Sprint 9 — Stripe billing (47 pts)

**Prereq:** Sprint 8 ✓ (RBAC + tiers + credits + impersonation done).
**Why next:** highest-leverage remaining product work. Replaces placeholder credit-purchase flow with real money movement.

9 stories:

- **S9-1** Stripe customer onboarding — link `users_v2.user_id` to `stripe_customer_id`. Migration adds a meta table `user_stripe_meta_v2`.
- **S9-2** Subscription Checkout — `POST /api/stripe/checkout/subscription {tier_id, billing_cycle}` returns Checkout Session URL.
- **S9-3** Credit-pack PaymentIntent — `POST /api/stripe/payment-intent/credits {pack_id}` returns client_secret for Elements.
- **S9-4** Webhooks — `POST /api/stripe/webhook` validates signature, handles `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`. Updates `user_subscriptions` accordingly.
- **S9-5** Self-service upgrade/downgrade — UI in CreditsPage / Settings.
- **S9-6** Customer Portal — Stripe-hosted billing portal link.
- **S9-7** Subscription sync cron — `/api/cron/stripe-sync` reconciles state weekly.
- **S9-8** Refunds — admin endpoint + AdminPanel action.
- **S9-9** Admin revenue dashboard — connect to real Stripe data (currently placeholder MRR/ARR).

Webhook signing: `STRIPE_WEBHOOK_SECRET` env var per tier.

## Sprint 13 — n8n queue mode (DEPRECATED)

Originally planned. **Replaced by Sprints 16-18** (multi-instance load balancing) per user mandate 2026-04-29:

> "We are NOT using worker n8n instances (Enterprise v). We have to create multiple write chapter workflows and load balance them to get better performance."

So Sprint 13 is now empty / removed. Sprint 14 follows directly.

## Sprint 14 — Storage strategy decision (3 pts firm + 34 conditional)

User pushback 2026-04-29: *"why are we using R2 storage? We can use storage on Supabase or R2 storage on Railway."*

**S14-0 (NEW, P0, 3 pts)** — Storage strategy decision document. Picks among:
- **Option A** — stay on Supabase Storage. Simplest. (Supabase Storage is built on R2 anyway.)
- **Option B** — Railway native object storage. Same vendor as compute.
- **Option C** — Cloudflare R2 directly. Cheapest at scale.

S14-1..5 (34 pts conditional) execute only if S14-0 picks Option B or C:
- Migration script
- Per-bucket migration
- Verification + cutover
- Cleanup
- Monitoring

## Sprint 15 — Testbed buildout + benchmarking (60 pts)

**See dedicated page: [[sprint-15-testbed]]** for the full sprint plan. This Sprint 15 supersedes the original abstract "Load test + monitoring" scope.

Goal: empirically answer four questions before committing to Sprints 16-18 architecture:

1. Which LLM strategy meets quality bar at scale (Sonnet / Haiku / Hybrid)?
2. Where does the platform break with N concurrent users?
3. How does the system fail under load (graceful vs cascade)?
4. When do we actually need Anthropic Tier 4 — specific user-count threshold?

4 phases / 16 stories / ~4 calendar weeks:

- **Phase 1: Foundation (16 pts)** — Testbed Supabase, schema, orchestrator skeleton, n8n-test-1.
- **Phase 2: Workflows + n8n (18 pts)** — Copy 5 DEV workflows to TEST tier; build 4 LLM variants (Sonnet / Haiku / Hybrid-DraftPolish / Hybrid-Smart).
- **Phase 3: Q/A engine (11 pts)** — Rule-based + Sonnet-as-judge; gold-standard rubric scored on 50 DEV chapters.
- **Phase 4: Multi-instance + collapse + synthesis (15 pts)** — n8n-test-2/3 + sticky LB + k6 load tests + synthesis report.

Replaces the previous abstract spec. The k6 load tests + telemetry are folded into Phase 4. Outputs feed [[design-feasibility]] empirical numbers and refine Sprints 16-18 story counts.

**Net effect:** Sprint 15 (60 pts) replaces ~50 pts of speculative work in 16-18 with empirical work, AND de-risks the remaining ~50 pts.

> **REFRAMED 2026-05-09**: Sprints 16-18 below described the n8n multi-instance approach. After [[microservice-alternative]] proposal + user expansion to full-backend rewrite, Sprints 16-26 are now planned per [[python-migration-roadmap]]. The original n8n-multi-instance content is preserved below as historical alternative.

## Sprint 16 — Chapter architecture analysis (26 pts) — SUPERSEDED

Sets up the analysis harness for Sprints 17-18.

**S16-0 (NEW)** — Stand up `DEV - Worker - Write Chapter (TEST)` — clone of live worker, separate workflow ID, never receives real user traffic. Harness in S16-1..4 reads from BOTH live worker (baseline) and TEST worker (experiments). Workflow ID will be recorded in `scripts/workflow-id-map.json` under new `test_workflows` key.

S16-1..4:
- Profile current single-instance baseline.
- Build chapter-quality benchmark suite.
- Identify token-budget bottleneck.
- Identify continuity-merge cost.

## Sprint 17 — LLM bake-off + dispatcher (29 pts) — SUPERSEDED

The architectural pivot.

**S17-1, S17-2** — bench Claude Sonnet vs Opus vs Haiku 4.5 vs Gemini Pro 2.5 on chapter writing. Quality scored against benchmark suite. Token cost tabulated.

**S17-3** — reshaped from "n8n native vs BullMQ vs hybrid" into the actual problem: **N parallel workflow instances + Workbench `ChapterDispatcher` + Redis-backed `AnthropicTokenBudget` gatekeeper**.

The gatekeeper takes over the 120s `rate_limit_delay` Wait node's job by:

1. Reserving estimated output tokens (~5000 tokens × N_sub_chapters per chapter) from a per-minute sliding window before dispatch.
2. Holding/queueing requests when budget is exhausted, retrying on next refill.
3. Selecting an idle worker from N parallel instances (round-robin least-busy).

The Wait node disappears from the per-instance worker because the rate gate now lives in Workbench.

Architecture:
```
ChatProxy → BullMQ heavy-ops (existing)
  → ChapterDispatcher
       → AnthropicTokenBudget.reserve(estimated_tokens)
           - if budget available: proceed
           - else: hold-then-retry
       → Idle worker selector (round-robin least-busy)
       → POST {idle worker webhook}
       → on completion: AnthropicTokenBudget.release(actual_tokens)
```

Architecture diagram in `sprint_document_v2.md` Sprint 17 section. Keep it in sync as design changes.

## Sprint 18 — Multi-instance rollout + safe rollout (34 pts) — SUPERSEDED

Promotes Sprint 17 prototype to DEV-quality (full tests, observability, error handling), deploys N production instances behind dispatcher, runs **shadow mode for a week**, then **10% / 50% / 100% traffic shift**, then archives the legacy single-instance worker.

**Zero-429 enforcement gates each rollout step** — if Anthropic returns a 429 during shadow mode, the rollout pauses for investigation.

S18 steps:
1. Promote dispatcher to DEV-quality.
2. Deploy N=2 then N=4 then N=8 parallel `DEV - Worker - Write Chapter (Instance 1..N)` workflows.
3. Shadow mode (compare output between legacy and new path; both run, only legacy result is returned).
4. 10% → 50% → 100% traffic shift via classifier flag.
5. Archive legacy single-instance worker.

## Sprints 16-26 — ACTUAL CURRENT PLAN

See [[python-migration-roadmap]] for Sprints 16-26: full Python backend rewrite + B2B productization. ~210 pts across 11 sprints / ~6-9 calendar months.

Phases:
- **A** (Sprints 16-17): Foundation + chapter port. **Unblocks Sprint 9 paid-seat launch.**
- **B** (Sprint 18): Remaining heavy modules.
- **C** (Sprint 19): Light modules (library, story_bible, approval, notify).
- **D** (Sprints 20-21): Newsletter + cron + cross-chapter continuity (NEW capability).
- **E** (Sprints 22-26): B2B productization — multi-tenancy, billing, SDKs, beta, GA launch.

The Author Agent backend becomes a sellable B2B product alongside Writers Workbench. See [[architecture/python-backend/master-plan]] for the architectural decision.

## Other open follow-ups (not full sprints)

- **Auto-trial on signup skip.** Currently if user skips tier selection, no `user_subscriptions` row → credits=0 → chat 402s. Pragmatic fix: have onboarding "Skip" auto-create trial subscription.
- **Set Supabase Auth Site URL + Redirect URLs** on both projects so password reset emails work.
- **Set `CRON_SECRET`** on Railway services when external cron scheduler is wired.
- **PROD newsletter cluster promotion** — see [[newsletter-cluster]].
- **Cron health dashboard** for `newsletter_ingestion_runs_v2`.
- **Eve KB cleanup cron** — delete documents older than X days.
- **Annotation `_scanner_exclusions` UI** — currently must edit JSONB directly.

## Recommended next sprint

**See [[work-ordering-2026-05]].** As of 2026-05-25 the next sprint is **not** Sprint 9 — it is the newsletter PROD ship (Gate 1), then Sprint 15 (Gate 2). Sprint 9 is now held last, after Sprints 16-27 in [[python-migration-roadmap]] are complete.

Reasoning (user mandate 2026-05-25):
- Sprint 15 must precede Sprints 16-22 so the bake-off picks the right LLM for the Python hub.
- B2B Author Agent API platform (Sprints 23-27) ships before paid-seat billing.
- Stripe (Sprint 9) waits because it should ride on the tier + metering layer added in Sprint 25.
