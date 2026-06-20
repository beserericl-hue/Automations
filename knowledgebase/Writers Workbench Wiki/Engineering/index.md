---
name: Index
description: Catalog of every page in this wiki, organized by topic. Read first when answering a query.
type: index
last_reviewed: 2026-05-09
---

# Index

The catalog. One line per page. When answering a question, scan this first to find candidate pages, then drill into 1–3 of them rather than re-reading source material.

## At the top

- [[marketing-copy]] — production sales copy: tagline, 90-word elevator pitch, 3-min video script, B-roll suggestions. Generated 2026-05-10.

## Read first

- [[overview]] — system synthesis. **Start here.**
- [[CLAUDE]] — wiki schema and workflows.
- [[glossary]] — domain terms + identifiers.
- [[log]] — chronological activity record.

## Architecture

- [[architecture/_index]]
- [[system-overview]] — full system diagram + components.
- [[tier-separation]] — V1 / DEV / PROD model. Most-referenced rule.
- [[data-flow]] — request → server → queue → n8n → DB → callback.
- [[code-relationships]] — module dependency graph.
- [[frontend-stack]] — React + Vite + TipTap + TailwindCSS.
- [[backend-stack]] — Express + BullMQ + Postal.
- [[deployment-railway]] — Railway services + env vars + build pipeline.
- [[security-model]] — Auth + RLS + RBAC + impersonation + secrets.

### Future direction — Python backend (Author Agent API)

- [[architecture/python-backend/_index|Python backend index]]
- [[python-backend/master-plan|Python backend master plan]] — architectural rewrite + dual-product positioning (Workbench internal + B2B platform). **n8n eliminated from active path.**
- [[python-backend/service-decomposition|Service decomposition]] — 11 modules incl. hub. Every n8n workflow → Python module.
- [[python-backend/hub-architecture|Hub architecture]] — Python rewrite of `PROD - The Author Agent`. Webhook + agent loop + tool dispatch.
- [[python-backend/api-contracts|API contracts]] — full HTTP endpoint spec.
- [[python-backend/queueing-architecture|Queueing architecture]] — Redis + arq workers + token budget gatekeeper + slot management.
- [[python-backend/scaling-architecture|Scaling architecture]] — visual deployment topology + capacity math + multi-region future state.
- [[python-backend/productization|Productization]] — B2B platform layer.
- [[python-backend/multi-tenancy|Multi-tenancy]] — tenant isolation.
- [[python-backend/observability-deployment|Observability + deployment]] — ops model.

## Database

- [[database/_index]]
- [[prod-database]] — PROD Supabase config + applied migrations.
- [[dev-database]] — DEV Supabase config + applied migrations.
- [[base-tables]] — 9 immutable base tables + meta-table extension pattern.
- [[migrations]] — full migration list 001–017.
- [[rls-policies]] — RLS policy template + public-read tables + service-role bypass.
- [[data-relationships]] — FK graph + cascade rules + orphan risks.

## Storage

- [[storage/_index]]
- [[supabase-storage]] — buckets per tier + RLS + content layout.
- [[postal-mail-stack]] — Postal 3.3.5 deployment + mail-server tier isolation.
- [[redis-bullmq]] — Redis instances + BullMQ queue topology + concurrency + sse-pubsub.

## Workflows (n8n)

- [[workflows/_index]]
- [[workflow-tiers]] — V1 / DEV / PROD naming + isolation rules + REST API gotchas.
- [[workflow-id-map]] — PROD↔DEV id table + V1 IDs + Sprint 12 + newsletter cluster.
- [[prod-hub-and-tools]] — `PROD - The Author Agent` + 23 tool sub-workflows.
- [[dev-hub-and-tools]] — DEV equivalents + Sprint 12 + newsletter cluster (DEV-only).
- [[v1-frozen]] — original 2025 baseline. Frozen.
- [[newsletter-workflows]] — newsletter cron + cadence + agent (DEV-only).
- [[chapter-writer-architecture]] — Worker - Write Chapter sub-chapter + continuity merge + bible extraction.
- [[tool-workflow-pattern]] — common shape + `$fromAI()` + activation cycle.

## ElevenLabs (Eve)

- [[elevenlabs/_index]]
- [[agents]] — V1 / DEV / PROD Eve agents.
- [[tools]] — `forward_writing_request_v2` / `_dev`.
- [[voice-and-prompts]] — Eve system prompt sections + voice settings + anti-stage-direction.
- [[callback-architecture]] — web SSE vs phone outbound call routing.

## Frontend

- [[frontend/_index]]
- [[routing]] — full route table + redirects + AuthGuard.
- [[components]] — components by feature area.
- [[auth-and-impersonation]] — AuthContext + UserContext + ImpersonationBanner + apiFetch.
- [[chat-and-eve]] — ChatDrawer + Eve widget + SSE wiring.
- [[editor-and-content]] — TipTap + ContentDetail + side panels + version history.
- [[newsletter-ui]] — newsletter pages + components.
- [[annotations-panel]] — Sprint 12 S12-13 drift + genre annotations UI.

## Backend

- [[backend/_index]]
- [[express-routes]] — every route file + endpoints + auth.
- [[middleware]] — requireAuth + requireAdmin/Superuser + requireCredits + shared-secret.
- [[job-queue]] — BullMQ workers + tracker + concurrency + SSE forwarder.
- [[classifier-and-priority]] — message classifier rules.
- [[session-and-sse]] — session-store + sse-pubsub + EventSource flow.
- [[email-pipeline]] — Postal proxy + rate limit + bounce handling.
- [[ingestion-routes]] — newsletter ingestion shared-secret API.
- [[newsletter-backend]] — newsletter routes + render + approvals + cadence cron callback.

## Sprints

- [[sprints/_index]]
- [[completed-sprints]] — Sprint 0-12 + newsletter cluster summary.
- [[sprint-8-rbac]] — RBAC + tiers + credits + impersonation deep dive.
- [[sprint-10a-tier-separation]] — V1/DEV/PROD tier rollout.
- [[sprint-10b-bullmq]] — Redis + BullMQ + concurrency + SSE pub/sub.
- [[sprint-11-postal]] — Postal email migration.
- [[sprint-12-chapter-tools]] — rewrite-with-research + drift scanner + annotations (Track A deferred).
- [[newsletter-cluster]] — multi-user newsletters sprint cluster (DEV-only).
- [[work-ordering-2026-05]] — **CURRENT WORK ORDER** as of 2026-05-25. Five-gate sequencing override.
- [[planned-sprints]] — Sprint 9 (Stripe) + 14 (storage decision) + 15 (load test) + 16-18 (chapter architecture). Story-list reference; sequencing now in [[work-ordering-2026-05]].
- [[design-feasibility]] — chapter-writer multi-instance feasibility evaluation. Token budget is the bottleneck; refines Sprint 16-18.
- [[sprint-15-testbed]] — Sprint 15 testbed buildout + benchmarking (60 pts / 4 phases). Empirical answers before Sprint 16-18.
- [[microservice-alternative]] — (SUPERSEDED) chapter-writer-only Python proposal.
- [[python-migration-roadmap]] — **CURRENT PLAN**: full Python backend rewrite + B2B productization. Sprints 16-26.
- [[releases-and-tags]] — v1.0.0 + v1.1.0 + v1.1.1 + v1.1.2.
- [[hotfixes]] — story-bible extraction + auth Site URL + admin auth-link + JR repair.

## Testing

- [[testing/_index]]
- [[unit-tests]] — Vitest + RTL test inventory.
- [[e2e-tests]] — Playwright projects + spec files + CI gotchas.
- [[engine-chat-e2e-suite]] — functional E2E through the engine chat interface (catalog ops + genres/arcs + gaps).
- [[newsletter-test-plan]] — 114-test manual QA plan.
- [[ci-pipeline]] — GitHub Actions jobs + required status checks + paths filter.
- [[regression-tests]] — sticky bug categories + R-tests R70-R81.
- [[test-conventions]] — CLAUDE.md rules 10-14 + page object pattern + mocking.

## Operations

- [[operations/_index]]
- [[governance]] — CLAUDE.md tier rules + schema governance + branch protection.
- [[promotion-dev-to-prod]] — release-day runbook.
- [[newsletter-prod-ship-runbook]] — concrete newsletter-cluster DEV→PROD steps (current; 2026-05-28).
- [[hotfix-flow]] — direct-to-PROD fix + mirror to DEV.
- [[env-vars-by-tier]] — per-tier env var reference.
- [[credentials-map]] — n8n credentials + secrets locations.
- [[runbooks]] — 17 common operational tasks.

## Quick reference

| Need | Page |
|------|------|
| What's the PROD hub workflow ID? | [[workflow-id-map]] (`roMDypuMXHv6ugaZ`) |
| What's a base table? | [[base-tables]] |
| How do I promote DEV → PROD? | [[promotion-dev-to-prod]] |
| Why is my chat 402-ing? | [[security-model]] credit gating section |
| How do impersonation writes work? | [[auth-and-impersonation]] |
| What's in `outline._scanner_exclusions`? | [[chapter-writer-architecture]], [[annotations-panel]] |
| How do I add a new genre? | [[runbooks]] RB-2 |
| Why does Cloudflare 524 me? | [[runbooks]] RB-5, [[regression-tests]] B8 |
| How do I roll back a release? | [[promotion-dev-to-prod]] Rollback section |
| What does `$fromAI()` do? | [[tool-workflow-pattern]] |
| What credentials does PROD n8n need? | [[credentials-map]] |
| What changed in v1.1.0? | [[releases-and-tags]] |
| Why did Sprint 13 disappear? | [[planned-sprints]] (replaced by 16-18) |
| What's the current work order? | [[work-ordering-2026-05]] |

## Page-type counts

- 1 schema (CLAUDE.md)
- 1 overview
- 1 index (this)
- 1 glossary
- 1 log
- 11 folder indexes (`_index.md`)
- ~58 concept pages

Total: ~73 markdown files. Approximately 6,000 lines of synthesized + cross-linked content.

## How to keep this current

- Whenever a sprint closes: append to [[completed-sprints]] + create a sprint-specific page if it warrants its own.
- Whenever a hotfix lands: append to [[hotfixes]].
- Whenever a release ships: append to [[releases-and-tags]].
- Whenever schema changes: update [[migrations]] + [[base-tables]] (if new meta table) + [[data-relationships]].
- Whenever a new workflow is created: update [[workflow-id-map]] + add a brief note to the appropriate workflow page.
- Whenever a credential rotates: update [[credentials-map]] (location, not value).
- Whenever an env var is added: update [[env-vars-by-tier]] + [[deployment-railway]].

Reference [[CLAUDE]] for the schema rules. Use `/save-obsidian` skill to capture insights from a working session.
