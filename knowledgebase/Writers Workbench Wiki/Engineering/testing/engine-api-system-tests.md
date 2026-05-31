---
name: Engine API system tests
description: Automated system/integration test plan against the Python Writer Engine API (per-step microservices + orchestrators + gateway). Rewrites the 114-test manual newsletter UI plan as API-level system tests; adds contract, HITL, SSE, parity, scalability, and failure-injection suites.
type: concept
tags: [testing, system-tests, api, python, engine, newsletter, scalability]
last_reviewed: 2026-05-29
---

# Engine API system tests

Rewrites the manual, UI-click [[newsletter-test-plan]] (114 tests) into **automated system tests that exercise the
Python [[engine-framework|Writer Engine]] API directly** — the per-step microservices, the orchestrators, and the
gateway — end to end. The newsletter suite is the first comprehensive instance; the same harness extends to the
write-workshop services. These run in CI and against the DEV engine deployment; they are the parity + scalability
gate before any PROD cutover (per [[engine-framework]] §6 F3) and supersede the manual newsletter plan for the API
era (the manual plan stays valid only until the n8n compose path is archived).

## Scope & layers

| Layer | What it proves | Tooling |
|---|---|---|
| **L0 Contract** | Each step service honors the uniform `POST /run {execution_id}` contract + Pydantic I/O schemas; `/admin/health`, `/metrics` up | pytest + httpx (async) + schemathesis on each `/openapi.json` |
| **L1 Step unit-via-API** | Each step service produces the correct output for a fixed input (golden fixtures) | pytest + httpx against a single service |
| **L2 Orchestrated E2E** | Full pipelines run end-to-end through the orchestrator + gateway (newsletter; chapter; research…) | pytest + httpx against the gateway |
| **L3 HITL / state-machine** | Pause→resume, the 3 newsletter gates, revision loops, expiry | pytest driving approvals API |
| **L4 SSE contract** | Progress events match the UI's expected shapes | pytest SSE client asserting the `nl:exec:{id}` event stream |
| **L5 Parity vs n8n** | Output artifact field-equivalent to the n8n version on the same input (LLM stochasticity allowed) | pytest diff harness + [[sprint-15-testbed]] rubric ≥0.95 |
| **L6 Scalability / load** | Throughput to the customer-bandwidth goals; independent per-step autoscale; token-budget gatekeeper; p95 latency | k6 / locust + Prometheus assertions |
| **L7 Failure injection** | Step crash, retry/idempotency, provider 429, Redis down, scrape failures | pytest + toxiproxy / fault env |
| **L8 Security / tenancy** | `/internal` shared-secret; `/v1` API-key + cross-tenant 404; approval-token expiry → 404 | pytest |

## Environment & auth

- Target: DEV engine deployment (gateway + step services) → DEV Supabase `gvbvwcnmjkdpclcisqrr`, DEV Redis, Postal
  sandbox; `ARCHIVE_BASE_URL` dev host. Never PROD.
- Auth: `/internal/*` with `X-Service-Secret`; `/v1/*` with a test API key; approvals via the resolve endpoint.
- Fixtures: a seeded `ai-news` edition + ≥1 subscriber + a known `content_ingestion_v2` day (so `gather` is
  non-empty); a deliberately empty day (for the skip test). Idempotency keys per run.
- Determinism: pin `PICKER_MODEL` (Gemini 2.5 Pro) + writer model; record/replay LLM where a byte-diff is needed,
  else assert on structure + rubric.

## A. Newsletter API system suite (rewrite of the 114-test plan)

Mapping the manual sections (T-NN) → automated API system tests (S-NN). Each S-test is an assertion against the API,
not a UI click.

| Manual (UI) | API system test | Asserts |
|---|---|---|
| T-07.1/2/3 Generate + ExecutionStatus + SSE | **S-07** `POST /internal/newsletter/generate` → `{execution_id}` sync; subscribe SSE `nl:exec:{id}`; assert ordered stages `gathering→picking→awaiting_stories_approval→…→saved` | ack shape, SSE event shapes/order |
| T-07.4 sends row | **S-08** after completion, `newsletter_sends_v2` row exists with `subject`, `markdown_body`, `html_body` containing the Playfair masthead, `metadata.execution_id`, `metadata.permalink` | output contract (§[[newsletter-microservices]] §2) |
| T-08.* Approval flow | **S-09** at `awaiting_stories_approval`, `GET …/executions/{id}/review/stories` returns selected stories + chain_of_thought; `POST …/approvals/{token}/resolve {approve}` resumes → `stories_approved` | gate persists, resume works |
| (new) Subject gate | **S-10** `awaiting_subject_approval` → review returns subject+alternatives+reasoning; approve resumes | gate #2 |
| (new) Image gate (decision #3) | **S-11** `awaiting_image_approval` → review returns per-story proposed images; resolve with chosen images → `render-svc` uses them | gate #3 |
| (revision loops) | **S-12** resolve `{revise, feedback}` on stories → re-runs `pick` with feedback → new approval; bounded by max-revisions | revision loop |
| T-09.* Send flow | **S-13** delivery = BOTH: Postal fan-out to subscribers (sandbox) **and** web permalink published at `ARCHIVE_BASE_URL/...`; `metadata.permalink` set; email body contains "read on web" link | decision #1 |
| T-13.4 empty ingestion | **S-14** generate on the empty day → terminal `skipped_no_content` + SSE message; no send row | edge case |
| T-13.5 approval expired | **S-15** resolve an expired token → 404 (per [[api-contracts]]) | expiry |
| (idempotency) | **S-16** replay same `(edition_id, send_date, execution_id)` → same send row, no duplicate | idempotent persist |
| T-10.* Ingestion browser | **S-17** `gather-svc` reads correct `content_ingestion_v2` rows for the edition/day (`?include_html=0` md-only) | gather correctness |
| T-11.* Cron | **S-18** `POST /internal/newsletter/cron/cadence` (X-Cron-Secret) enqueues generate only for due editions | cadence |
| T-12.* Bounces | **S-19** Postal bounce webhook → `email_bounces_v2` row + subscriber flipped `bounced` | bounce path |

Sections T-01..T-06 (editions/feeds/subscribers/templates CRUD) become **L1 API CRUD tests** against the relevant
endpoints (still asserted, just at API level rather than UI clicks).

## B. Write-workshop API system suite (same harness)

L2 E2E per pipeline, asserting the output contract from [[service-decomposition]]:
- **S-CH** `POST /internal/chapters/write` → content_text, word_count, bible entries; idempotent on `chapter_run_id`;
  L5 parity vs `Worker - Write Chapter`.
- **S-BR** brainstorm story/chapter/edit-outline (locked-character preservation regression).
- **S-RE** research run (Perplexity + synth) parity vs `Sub - Research Pipeline`.
- **S-MED** cover-art/social/scrape-url.
- **S-LIB / S-SB / S-APP / S-NOT** library/story-bible/approval/notify CRUD + lifecycle.

## C. Scalability / load suite (L6 — the bandwidth-goal gate)

Per the hard scalability requirement ([[engine-framework]] §4, [[scaling-architecture]]):
- **S-LOAD-1 throughput**: drive concurrent newsletter + chapter runs at the target rate; assert completion within
  SLA and queue drains; measure runs/min per replica.
- **S-LOAD-2 independent autoscale**: saturate `segment-svc`/`subchapter-write`; assert those replicas scale while
  `library`/`gather` stay flat (per-step isolation).
- **S-LOAD-3 token-budget gatekeeper**: exceed the provider budget; assert throttling (no provider 429s leak), graceful
  queueing.
- **S-LOAD-4 latency**: p95 per step + per pipeline ≤ targets in [[scaling-architecture]]; assert ≥15-25% better than
  the n8n baseline.
- **S-LOAD-5 capacity to bandwidth goal**: ramp to the customer-bandwidth target (e.g. the ~1500 daily-user / target
  RPS figure) and hold; assert error rate <1% and stable memory.

## D. Failure-injection suite (L7)

- **S-FAIL-1** kill a step mid-pipeline → orchestrator retries the step (idempotent) → run completes.
- **S-FAIL-2** Redis down → generation queues/blocks gracefully, no data loss; recovers on restore (cf.
  [[prod-redis-outage-risk]]).
- **S-FAIL-3** external scrape URL 500s → `scrape-svc` per-URL error filter drops it; segment still writes.
- **S-FAIL-4** provider 429 → retry/backoff + multi-LLM fallback; run succeeds.
- **S-FAIL-5** duplicate `resolve` on an already-resolved approval → 409; no double-resume.

## E. Security / tenancy suite (L8)

- **S-SEC-1** `/internal/*` without `X-Service-Secret` → 401.
- **S-SEC-2** `/v1/*` without/with bad API key → 401; valid key scoped to its tenant.
- **S-SEC-3** cross-tenant access on `/v1/*` → **404** (not 403), per [[api-contracts]].
- **S-SEC-4** approval token belonging to another user → 403; expired → 404.

## Tooling, CI, gates

- **pytest + httpx (async)** for L0-L5/L7/L8; **schemathesis** for contract fuzzing off each `/openapi.json`;
  **k6 or locust** for L6 with Prometheus assertions; **toxiproxy** for fault injection.
- **CI**: a `engine-system-tests` job runs L0-L5 + L8 on every PR to the engine repo against an ephemeral
  `docker compose` of the service set; L6 load runs nightly + pre-cutover.
- **Cutover gates** (per [[engine-framework]] F3): a step/pipeline may cut over to PROD only when its L2 E2E + L5
  parity (≥0.95 rubric) + relevant L6 targets are green for 7 consecutive days in DEV shadow.
- **Coverage**: >85% on engine-library + services (cross-cutting requirement, [[python-migration-roadmap]]).

See also: [[newsletter-microservices]] · [[engine-framework]] · [[api-contracts]] · [[scaling-architecture]] ·
[[sprint-15-testbed]] · [[newsletter-test-plan]] (manual predecessor) · [[regression-tests]].
