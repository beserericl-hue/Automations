---
name: Log
description: Chronological record of vault activity (ingests, queries that produced new pages, lints).
type: log
---

# Log

Append-only. Format: `## [YYYY-MM-DD] <action> | <subject>` followed by free-form body.

## [2026-05-09] setup | initial vault scaffolding

Created vault skeleton: CLAUDE.md (schema), index.md (catalog), overview.md (placeholder), README.md, glossary.md, log.md. MCP server `obsidian-vault` configured in project `.mcp.json`. Skills `challenge-obsidian` and `save-obsidian` installed under `.claude/skills/`.

## [2026-05-09] ingest | full Writers Workbench knowledgebase build

Comprehensive build covering all subsystems — DEV + PROD tiers split throughout. Source material: SESSION_CONTEXT.md (1,963 lines), CLAUDE.md, MEMORY.md (244 lines), workflow-governance.md, schema-governance.md, promotion-log.md, .mcp.json, .gitignore, package.json, App.tsx route table, server/src/routes inventory, server/src/lib inventory, migrations folder (001-017), e2e folder, client + server test inventories, scripts folder, workflow-id-map.json, newsletter-test.md.

**~67 pages created** across 11 folders:

- **Engineering root** (4 pages): overview, glossary, index, log entry — system synthesis.
- **architecture/** (8 pages): system-overview, tier-separation (most-referenced rule in codebase), data-flow, code-relationships, frontend-stack, backend-stack, deployment-railway, security-model.
- **database/** (6 pages): prod-database, dev-database (DEV ahead of PROD on migrations 013/014/016/017), base-tables (9 immutable + meta-table pattern), migrations (001-017 status by tier), rls-policies, data-relationships.
- **storage/** (3 pages): supabase-storage (6 buckets + RLS + content layout), postal-mail-stack (3 services + per-tier mail-server isolation), redis-bullmq (queue topology + concurrency + sse-pubsub + session-store).
- **workflows/** (8 pages): workflow-tiers, workflow-id-map (24 PROD↔DEV pairs + Sprint 12 + newsletter cluster), prod-hub-and-tools, dev-hub-and-tools, v1-frozen, newsletter-workflows (DEV-only cluster), chapter-writer-architecture (sub-chapter parallelism + continuity merge + extract_bible chain), tool-workflow-pattern.
- **elevenlabs/** (4 pages): agents (V1/DEV/PROD Eve), tools (forwarding tool per tier), voice-and-prompts (system prompt sections, anti-stage-direction, mature fiction override), callback-architecture (web SSE vs phone outbound).
- **frontend/** (7 pages): routing (full route table), components (26 folders cataloged), auth-and-impersonation (UserContext + impersonation header), chat-and-eve (ChatDrawer pill states + Eve widget + SSE), editor-and-content (TipTap + side panels), newsletter-ui (DEV-only newsletter pages), annotations-panel (Sprint 12 S12-13).
- **backend/** (8 pages): express-routes (every route file + endpoints), middleware (requireAuth + requireAdmin/Superuser + requireCredits), job-queue (BullMQ workers + tracker + SSE forwarder), classifier-and-priority (regex rules), session-and-sse (Redis hash sessions + sse-pubsub two-client pattern), email-pipeline (Postal proxy + rate-limit + bounces), ingestion-routes (newsletter shared-secret API), newsletter-backend (6 route files + render + approvals + cadence cron callback).
- **sprints/** (10 pages): completed-sprints (master table), sprint-8-rbac, sprint-10a-tier-separation, sprint-10b-bullmq, sprint-11-postal, sprint-12-chapter-tools, newsletter-cluster (PRs #69-#75), planned-sprints (Sprint 9 Stripe + 14 storage decision + 15 load test + 16-18 chapter architecture), releases-and-tags (v1.0/v1.1.0/v1.1.1/v1.1.2), hotfixes.
- **testing/** (6 pages): unit-tests (~430+ tests catalogued), e2e-tests (Playwright projects + CI gotchas), newsletter-test-plan (114-test manual plan), ci-pipeline (GitHub Actions jobs + required status checks + paths filter), regression-tests (sticky bug categories B1-B13 + R-tests R70-R81), test-conventions (CLAUDE.md rules 10-14).
- **operations/** (6 pages): governance, promotion-dev-to-prod (release-day runbook), hotfix-flow, env-vars-by-tier (full reference table), credentials-map (n8n + Supabase + ElevenLabs + Postal + GitHub), runbooks (17 common ops tasks).

**DEV vs PROD documented at every layer:**
- Database (`gvbvwcnmjkdpclcisqrr` vs `faklxfakgzkpkbxfihzh`)
- n8n workflows (`DEV - <name>` vs `PROD - <name>` with id maps)
- Eve agents (`agent_0001kpr...` vs `agent_2801kks...`) + per-tier forwarding tools
- Railway services + env vars (per-tier sensitivities documented; release-day audit checklist in [[promotion-dev-to-prod]])
- Postal mail servers (Development vs Live mode)
- Redis instances (`Redis_Dev` vs `Redis`)
- Per-tier shared secrets (Email/Ingestion/Approval)

**All n8n workflows enumerated** in [[workflow-id-map]] — 24 PROD/DEV pairs plus Sprint 12 additions plus 4 newsletter cluster workflows (DEV-only) plus V1 frozen workflows.

**All ElevenLabs agents documented** in [[agents]] with IDs, phones, LLMs, voices, and per-tier forwarding tools.

**Test plans included:**
- Unit (Vitest + RTL, ~430+ tests): [[unit-tests]]
- E2E (Playwright projects, 60+ critical-path tests): [[e2e-tests]]
- Manual newsletter QA (114 tests): [[newsletter-test-plan]]
- Regression (R70-R81, B1-B13 sticky bug categories): [[regression-tests]]
- CI pipeline: [[ci-pipeline]]

**Code relationships documented** in [[code-relationships]] (top-level layout + critical request paths + cross-cutting patterns) and per-page where relevant.

**Sprint coverage:**
- Completed: Sprint 0-7, 8, 10.a, 10.b, 11, 12 (Tracks B+C), Newsletter cluster (DEV-only).
- Planned: Sprint 9 (Stripe), Sprint 14 (storage decision), Sprint 15 (load test), Sprints 16-18 (chapter writer multi-instance architecture replacing the deferred Sprint 13 + Track A).
- Releases: v1.0.0, v1.1.0, v1.1.1, v1.1.2 (in flight).
- Hotfixes: 2026-04-29 story-bible extraction, v1.1.2 admin auth-link, JR password repair, Auth Site URL pending.

Wiki built via the `obsidian-vault` MCP server. All pages cross-linked with `[[basename]]` wikilinks. Schema in [[CLAUDE]]. Catalog in [[index]].

Next maintenance per [[index]] "How to keep this current" section.

## [2026-05-09] update | design-feasibility evaluation for chapter-writer multi-instance architecture

User requested feasibility evaluation of a proposed 10-instance load-balanced chapter-writer architecture against scaling targets (100+ daily users). Captured the analysis as [[design-feasibility]] under `sprints/`.

Key findings:
- **Token budget (Anthropic per-minute output) is the bottleneck**, not n8n CPU. Existing [[planned-sprints|Sprints 16-18]] mention this but don't make it central.
- 5 instances meets demand for 100 daily users; **10 = 2× headroom**.
- **Anthropic Tier 4 upgrade** is the single biggest unlock (5× token-budget headroom over current Tier 3).
- Architecture scales to ~1000 daily users with multi-LLM strategy (Haiku for routine sub-chapters, Sonnet for plot-critical).
- Lock-to-instance is free at the workflow-execution level (n8n executeWorkflow stays host-local) but needs sticky LB routing for inbound webhook duration.
- Self-contained queue payload (256 KB cap) needed so chapters survive instance crashes.
- Error compensation requires explicit chaos test matrix (kill instance, Anthropic 429, Postgres drop, Redis flap, Cloudflare 524, etc.) with idempotency keys via `chapter_run_id` UUID.

Refinements proposed (not yet applied):
- Sprint 16: 26 → 34 pts (added S16-5 token profiler, S16-6 Tier 4 evaluation).
- Sprint 17: 29 → 37 pts (split S17-3 into 3a/3b/3c; central token budget).
- Sprint 18: 34 → 39 pts (added S18-X chaos test suite).
- NEW Sprint 18.5: 16 pts for multi-server n8n provisioning + sticky LB + per-instance health monitoring.
- Total Sprint 18 family: 39 + 16 = 55 pts.

Updated [[sprints/_index]] and [[index]] to register the new page. [[planned-sprints]] and [[chapter-writer-architecture]] not yet updated — design-feasibility is the working document for the discussion; planned-sprints will be updated when the refined story counts are accepted.

## [2026-05-09] update | Sprint 15 — testbed buildout + benchmarking sprint plan filed

User confirmed the testbed sprint plan should be filed. Created [[sprint-15-testbed]] under `sprints/` with the full sprint structure: 60 pts across 4 phases / 16 stories / ~4 calendar weeks.

Key decisions captured:
- **Sprint 15 is repurposed** from the abstract "Load test + monitoring" to a concrete testbed buildout. Updated [[planned-sprints]] to reflect the new scope and link to the dedicated page.
- **TEST becomes a 4th tier** (alongside V1 / DEV / PROD). New naming convention: `TEST - <name>`. Webhook `_test` suffix. Will need a section in [[workflow-id-map]] when workflows are created.
- **Testbed Supabase** is a third project; data cloned from DEV nightly with anonymized PII.
- **3 n8n test instances** behind a sticky LB — enough to validate the multi-instance hypothesis without committing to 10 in production.
- **4 LLM variants tested**: Sonnet (control) / Haiku / Hybrid-DraftPolish / Hybrid-Smart. Gold-standard rubric scored on 50 DEV chapters as comparison floor.
- **Q/A engine**: rule-based (deterministic, free) + Sonnet-as-judge ($0.05/comparison) + GPT-4 cross-judge spot-check (10% sample) for bias detection.
- **k6 load patterns**: burst-50, burst-200 (find collapse point), sustained-100 (peak demand at 100 daily users).
- **Cost: ~$750 one-time LLM spend + $85/month infra** while testbed is active.
- **Sequencing**: 9 → 14 → 15 → 16 → 17 → 18. Sprint 15 can run parallel to Sprint 9 (Stripe) if engineering capacity allows.
- **Net effect on downstream**: Sprint 16 shrinks 26-34 → ~10 pts (apply findings); Sprint 17 shrinks 29-37 → ~15 pts (productionize testbed dispatcher); Sprint 18 stays ~34 pts but with measured baselines.

Updated catalogs: [[sprints/_index]], [[index]], [[planned-sprints]] all now point to [[sprint-15-testbed]]. [[design-feasibility]] remains the architectural framing; [[sprint-15-testbed]] is the actionable plan.

## [2026-05-09] update | full Python backend rewrite + B2B productization plan filed

User expanded the architectural fork from chapter-writer-only to **complete backend rewrite** with B2B productization ("we could sell this backend separately for people who are writing their own writers application"). Worked through autonomously per user direction ("keep this going until it is completed"). Filed as a 7-page architecture + 1 sprint roadmap.

### New pages created

**Architecture** (under new `architecture/python-backend/` subfolder):
- [[architecture/python-backend/_index]] — catalog
- [[python-backend/master-plan]] — architectural decision, service-group deployment model (heavy / light / cron Docker images), dual-product positioning (Workbench internal + B2B platform), risk register, sequencing
- [[python-backend/service-decomposition]] — every n8n workflow mapped to a Python module. ~10 modules / ~7,500 LOC / ~11,000 LOC with tests
- [[python-backend/api-contracts]] — full HTTP endpoint spec. Public `/v1/*` (B2B) + internal `/internal/*` (hub) + admin `/admin/*`. Auth, idempotency, error codes, webhooks, OpenAPI generation
- [[python-backend/productization]] — B2B platform: 5 subscription tiers (Free $0 / Starter $99 / Pro $499 / Scale $2,499 / Enterprise custom), per-token billing, SDKs (Python + TypeScript), competitive positioning, marketing surface
- [[python-backend/multi-tenancy]] — tenant isolation: dual-schema model (Workbench user_id-scoped + B2B `b2b_*` tenant_id-scoped to preserve schema governance), Argon2id API keys, three layers of defense, 404 (not 403) on cross-tenant probes, GDPR deletion + export
- [[python-backend/observability-deployment]] — structlog + Prometheus + OTel, blue-green per service group, capacity planning math, on-call runbook, SLA commitments per tier

**Sprints**:
- [[python-migration-roadmap]] — multi-quarter sprint plan (Sprints 16-26). 5 phases: Foundation+chapter (16-17), Heavy modules (18), Light modules (19), Newsletter+cron+cross-chapter (20-21), B2B productization (22-26). ~210 pts / ~6-9 calendar months.

### Key architectural decisions made autonomously

User directed: "Just make good design decisions and show me what has been accomplished at the end." Made these decisions:

1. **Modular monolith with service-group deployment** — one codebase, three Dockerfiles (heavy/light/cron), each scaled independently. User reinforced this in mid-session message ("we could allocate groups of services to one docker instance and load balance the instances").
2. **Hub stays in n8n** — the hub is a routing/agent layer that benefits from visual + iterative dev. Only tool workflows migrate.
3. **Dual-schema for multi-tenancy** — schema governance forbids `ALTER TABLE` on base tables. So B2B gets fresh `b2b_*` tables with `tenant_id` from the start. Workbench keeps existing user_id-scoped schema. Two flows; one codebase.
4. **Per-tier LLM strategy** (from earlier in session, retained) — Standard tier gets Haiku for sub-chapters; Pro+ gets Sonnet. Aligns LLM cost to revenue.
5. **Argon2id API keys** — slow-on-purpose hashing (~100ms verify) trades latency for security; cached 5 min for hot keys.
6. **Modular monolith → microservices later** — start simpler. Split if scaling demands.
7. **Hosting**: Railway Phase 1; Kubernetes if 1000+ users.
8. **Background tasks**: BullMQ via shared Redis (consistency with existing Workbench).
9. **Prompt storage**: hybrid (code default + `app_config_v2.prompts` override); hot-reload via `/admin/reload-prompts`.
10. **API versioning**: `/v1/*` path prefix; minimum 6-month `Sunset` header deprecation.
11. **Public surface tight**: cron entry points + Workbench-specific operations stay internal.
12. **404 (not 403)** on cross-tenant probes — don't leak existence of resources.

### Existing pages updated

- [[microservice-alternative]] — marked SUPERSEDED. Content preserved as historical context.
- [[architecture/_index]] — added "Future direction" section linking to python-backend/.
- [[chapter-writer-architecture]] (under workflows/) — added transition banner pointing to python-backend pages.
- [[sprints/_index]] — added [[microservice-alternative]] (SUPERSEDED) and [[python-migration-roadmap]] (CURRENT PLAN).
- [[planned-sprints]] — marked Sprints 16-18 SUPERSEDED. Added pointer to [[python-migration-roadmap]] for Sprints 16-26.
- [[index]] — added "Future direction" sub-section in Architecture; added new sprint pages.

### Critical gates

- **Sprint 9 (Stripe paid seats) blocked until Phase A complete** (~Sprint 17). User-stated hard constraint: scaling solved before paid-seat rollout.
- **B2B GA blocked until internal migration complete + 30 days stable** (~Sprint 21).
- **B2B beta launch ~Sprint 25**, GA ~Sprint 26.
- **Total elapsed: ~6-9 months from Sprint 16 start.**

### Cost + scaling targets achieved by this plan

- 100 daily users on Tier 3 Anthropic: ~$80/month backend (vs $145 for n8n multi-instance — 45% cheaper).
- 1000 daily users on Tier 4: ~$395/month backend (vs $1,545 — 75% cheaper).
- 1500-3000 daily-user ceiling with multi-LLM strategy.
- B2B revenue potential: ~$50-150k/year at 100 customers, ~$500k+ at 500 customers.
- New capability: cross-chapter continuity (project-wide consistency check + auto-rewrite).

### What's accomplished at end of session

8 substantial pages totaling ~3,000 lines of dense architectural + product spec. Wiki structure preserved. All cross-links live. Decisions documented with rationale. The Python backend rewrite is now a fully-specified plan that can begin Sprint 16 with confidence.

### What's still open (decisions deferred to user)

- Final domain for B2B platform (`api.authoragent.dev`? `authoragent.io`? something else?).
- Hire timing for B2B customer support.
- Marketing site / launch comms (out of engineering scope).
- Whether Workbench server itself migrates from `/internal/*` to public `/v1/*` calls (recommended Option A initially in [[productization]]).

## [2026-05-10] update | extend rewrite to eliminate n8n entirely (hub + queueing + scaling)

User expanded scope further: "Add to this plan a complete rewrite of workflows not included including the hub and the other workflow included. This eliminates the n8n use altogether. The entire architecture is callable by API and includes the queueing of workflows for scalability. Include everything required in this architecture. Also document the scaling architecture so we can get a good visual of how everything ties together."

Three new pages + 4 cross-reference updates.

### New pages created

- [[hub-architecture]] (~480 lines) — Python rewrite of `PROD - The Author Agent`. Webhook receiver + `preprocess_message` regex pre-routing + agent loop (Claude Haiku 4.5 default with Gemini 2.5 Flash fallback) + tool dispatcher + Eve-specific behaviors. Replaces the n8n hub. Also folds in Reset Eve Greeting + Approval Token Generator as background-task / module-internal logic.

- [[queueing-architecture]] (~480 lines) — Redis-backed queue topology. arq framework (asyncio-native). Anthropic token-budget gatekeeper via Lua sliding window. Per-user/tenant slot management with 30-min TTL safety valve. Idempotency cache (24h). Rate limits. Dead-letter queue. Cron leader election (Redis SETNX). Webhook delivery retry policy. Capacity model + auto-scaling triggers.

- [[scaling-architecture]] (~440 lines) — **Visual diagrams.** Top-level system topology, service-group deployment detail, inside-an-api-svc-container view, inside-a-worker view, request flow (async heavy op), capacity math at Tier 3 + Tier 4, cost math at 100/1000/5000 daily users, auto-scaling rules, multi-region future state, DR scenarios. Heavy ASCII art. Designed as the visual entry-point for new engineers.

### Major architectural decisions made (autonomously)

1. **Hub LLM = Claude Haiku 4.5** (not Gemini 2.5 Flash). Reasons: better tool-use accuracy, fewer fabrications, single-vendor (already on Anthropic everywhere else), comparable cost ($0.001 vs $0.0008/request — negligible). Gemini configurable as fallback via `HUB_LLM_PROVIDER` env.
2. **Service-group split: api-svc vs worker-{heavy,light,cron}** instead of monolithic api+worker. Web/worker separation is cleaner; api-svc scales by request volume, worker-heavy scales by queue depth. Different drivers → different replica counts.
3. **Queue framework = arq** (not Celery). Asyncio-native, simpler, fits FastAPI naturally. Workbench Express keeps BullMQ during transition; both on same Redis with different prefixes.
4. **Cron singletons via Redis leader election**, not singleton container. Multiple cron replicas allowed; SETNX lock with TTL ensures exactly-one execution per scheduled job. Better failover.
5. **Two Dockerfiles instead of three**: `Dockerfile.api` + `Dockerfile.worker`. Service group selected via `SERVICE_ROLE` env at boot. Reduces image build matrix.
6. **Hub direct dispatch for `direct_qa_chapter`, small `edit_outline`, `revert_outline`** — bypass the agent for ops where LLMs reliably fabricate. Preserves the n8n-era anti-fabrication behaviors.
7. **Webhook signing** for B2B: HMAC-SHA256 with per-tenant `webhook_secret`. Customer verifies via SDK helper.
8. **n8n eliminated from active path entirely**. V1 (Orig) workflows stay for legacy customers per CLAUDE.md baseline. n8n container can downscale to single small instance hosting V1 only.

### Existing pages updated

- [[architecture/python-backend/master-plan|master-plan]] — "What stays in n8n: NOTHING (active path)." Service-group table revised (api-svc + worker-heavy + worker-light + worker-cron). Decision gates table updated with all settled defaults checked off.
- [[service-decomposition]] — added module 1 (`hub`), now 11 modules total. Service groups updated. LOC estimate revised: ~13,000 LOC with tests, 14-16 weeks.
- [[architecture/python-backend/_index]] — added 3 new pages to catalog. Updated reading order.
- [[python-migration-roadmap]] — inserted Phase E (Sprint 22 = hub migration + n8n decommissioning, 35 pts, 9 stories). Phase F (B2B) shifts to Sprints 23-27. Total ~245 pts (was ~210). Sequencing diagram updated.
- [[index]] — master catalog includes all new pages.

### Sprint 22 — hub migration breakdown

9 stories / 35 pts:
- S22-1 Hub skeleton + preprocess_message (5)
- S22-2 Agent loop + 24 tool definitions (10)
- S22-3 Direct dispatch ops (3)
- S22-4 Reset Eve Greeting + Approval Token Generator folded in (3)
- S22-5 Eve callback flow + KB upload (5)
- S22-6 DEV shadow mode (3)
- S22-7 PROD shadow + cutover (4)
- S22-8 ElevenLabs forwarding tool + Workbench chat-proxy update (2)
- S22-9 n8n decommissioning (ongoing through sprint)

### Critical gates updated

- Phase A still unblocks Sprint 9 paid-seat launch (~Sprint 17 ship).
- Phase E (hub migration, Sprint 22) is the n8n elimination milestone.
- Phase F (B2B) is unchanged scope; just shifted +1 sprint.
- Total elapsed: 7-10 months from Sprint 16 start (was 6-9).

### Capacity numbers documented

[[scaling-architecture]] now includes:
- 100 daily users (Tier 3, 5 replicas): $116/mo infra + $300/mo Anthropic = **$416/mo total** ($4.16/user/mo)
- 1000 daily users (Tier 4, 15 replicas): $238/mo infra + $3,000/mo Anthropic = **$3,238/mo** ($3.24/user/mo)
- 5000 daily users (Tier 4, 50 replicas): $618/mo infra + $15,000/mo Anthropic = **$15,618/mo** ($3.12/user/mo)

Per-user cost falls slightly with scale. Anthropic dominates infrastructure beyond ~1000 users.

### Wiki size at end of session

96 markdown files. ~17,500 lines. ~106k words. The Python backend rewrite is now fully specified end-to-end including hub + queueing + scaling visuals. Ready for engineering execution starting Sprint 16.

## [2026-05-10] update | marketing copy filed at vault root

User requested website copy for the production app. Filed [[marketing-copy]] at Engineering root with three deliverables:

- 90-word elevator pitch + tagline ("Where stories get finished.") + bullet list of capabilities
- 3-minute video script (~460 words, 6 scenes, timestamped)
- B-roll plan (screencast + lifestyle pairings per scene)

Page placed in the "At the top" section of [[index]] for easy discovery.

**Pre-launch flags called out in the page:**
- Newsletter platform is DEV-only as of 2026-05-09 — verify PROD-ship before website launches mentioning it.
- URL placeholder `writersworkbench.app` — swap in real domain.
- Genre + story-arc counts (8 each) — reverify before press.
- 30-day trial — confirm discoverable on signup.

Copy is grounded in shipped functionality from [[overview]], [[components]], [[chat-and-eve]], [[chapter-writer-architecture]], [[annotations-panel]], [[editor-and-content]], [[newsletter-ui]], [[sprint-8-rbac]], [[productization]].

## [2026-05-10] update | marketing-copy rewritten for zero-budget Heygen filming

User constraint: no production budget. Narration via Heygen avatar. B-roll = screen captures only. Rewrote [[marketing-copy]] in place.

New structure:
1. Sales summary (unchanged — tagline + 90-word pitch + bullets + pricing).
2. Pre-recording setup checklist — what to seed in DEV before opening the screen recorder. Demo project ("The Last Signal", post-apocalyptic, Hero's Journey) + demo newsletter ("The Wasteland Wire") + recorder settings.
3. Heygen avatar script — 425 words plain text, copy-paste-ready, no markdown. Plus per-scene blocks.
4. Filming plan table — 8 scenes, columns: Time / Scene / Heygen line / What to capture / Type-in + caption.
5. Editing + post-production notes.
6. Recording-day shot list checklist.
7. Pre-launch verification flags.

Key table column "Type / Caption" specifies literal text to type into app fields during recording AND lower-third captions to add in editing. Lifestyle B-roll removed entirely. All filming is screen capture from DEV.

Newsletter shown intentionally (DEV is OK per user direction). Pre-launch flag still notes PROD-promotion verification before video goes live.

## [2026-05-17] ops | DEV URL consolidation — partial completion + PROD bug discovered

User asked to consolidate DEV environments: keep new `bubbly-solace/develop/WritersWorkbench` (URL `writersworkbench-develop.up.railway.app`), retire old `N8N-MCP/production/WritersWorkbenchDev` (URL `writersworkbenchdev-production.up.railway.app`). Executed most steps but **halted Railway archive** due to a separate PROD bug discovered mid-migration.

### Completed

1. **Wiki + docs (27 files):** all active references updated from old URL → new URL. Includes CLAUDE.md, 21 wiki pages, 5 writers-workbench/docs/*, postal-install-runbook.md, and the 2 n8n-workflow JSON templates in writers-workbench/n8n-workflows/. Historical refs preserved (SESSION_CONTEXT.md, /handoff/, /scripts/ one-shot ops).

2. **DEV n8n workflows (18 updated):** via REST PUT through n8n API. All show clean (no remaining old-URL strings):
   - DEV - Worker - Write Chapter
   - DEV - Newsletter Cadence Cron
   - DEV - Newsletter Ingestion (Multi-User Cron)
   - Content - Newsletter Agent V2
   - AI News Data Ingestion V2 (legacy DEV)
   - DEV - Tool - Write Blog Post / Write Short Story / Write Newsletter / Brainstorm Story / Brainstorm Chapter / QA Chapter / Edit Outline / Format Kindle Book / Generate Cover Art / Repurpose to Social Posts / Email Research Report
   - DEV - Sub - Manage Library
   - DEV - 17 Cron: Scheduled Publisher
   - (Note: n8n 2.x runtime activeVersion may need UI Publish (⌘P) to pick up changes — saved JSON is updated, but activeVersion is a snapshot. Both URLs currently route to same DEV Supabase, so no functional regression either way.)

3. **CI workflow files:** no DEV URL refs found in `.github/workflows/`. Nothing to change.

### Halted — PROD workflows reference DEV URL

During the n8n workflow scan I found **PROD workflows hardcoded to call the OLD DEV Workbench URL** for things like `/api/email/send`:

| PROD workflow | Refs | What it does with the URL |
|---|---|---|
| PROD - Tool - Brainstorm Chapter | 2 | `send_email` HTTP node |
| PROD - Tool - Edit Outline | 2 | `send_email` |
| PROD - Sub - Manage Library | 2 | `send_email` |
| PROD - Tool - Brainstorm Story | 2 | `send_email` |
| PROD - 17 Cron: Scheduled Publisher | 2 | `send_notification` |
| PROD - Tool - Repurpose to Social Posts | 2 | `send_email` |
| PROD - Tool - Write Blog Post | 2 | `send_email` |
| PROD - Tool - Email Research Report | 2 | `send_email` |
| PROD - Tool - Format Kindle Book | 2 | `send_email` |
| PROD - Tool - Generate Cover Art | 2 | `send_email_with_image` |
| PROD - Tool - Write Newsletter | 2 | `send_email` |
| PROD - Tool - QA Chapter | 4 | `send_email` + `send_clean_email` |
| PROD - Tool - Write Short Story | 2 | `send_email` |
| PROD - Worker - Write Chapter | 2 | `send_email` (continuity_finalize-side) |

**This is a pre-existing v1.1.0 promotion-script bug.** The promotion script substituted Supabase URL/key + n8n webhook paths but did NOT substitute the Workbench API URL on the `send_email` HTTP nodes. So since 2026-04-28 (v1.1.0 release), every PROD email-sending node has been calling `writersworkbenchdev-production.up.railway.app/api/email/send` — i.e., the **DEV Workbench**, whose `POSTAL_API_KEY` points at the `writers-workbench-mail-dev` Postal mail server in **Development mode** (swallows email, doesn't deliver).

**Consequences:**
- PROD users have not been receiving notification emails for chapter writes, blog posts, newsletter approvals, QA reports, etc. since 2026-04-28 (~3 weeks).
- The OLD Railway service (`N8N-MCP/production/WritersWorkbenchDev`) cannot be safely archived until PROD workflows are migrated, or PROD would fail HTTP calls outright instead of just losing emails.

**Did NOT touch PROD workflows** per CLAUDE.md baseline protection ("Do NOT edit PROD workflows during a sprint"). Requires explicit user direction.

### Options for user decision on PROD bug

**Option P-A**: Run `scripts/promote-dev-to-prod.py` for the email-related PROD workflows (or write a targeted script). This re-promotes DEV state with the proper Workbench-URL substitution to PROD-Workbench URL. Should restore PROD email delivery. ~30 min work + smoke verify per workflow.

**Option P-B**: Update the OLD `WritersWorkbenchDev` service env vars to point its `POSTAL_API_KEY` at the PROD Postal mail server. PROD continues going through DEV Workbench but emails actually deliver. Quick fix; defers the architectural cleanup; cross-contaminates DEV calls (DEV-tier op emails would also deliver via PROD Postal).

**Option P-C**: Leave PROD as-is (emails silently swallowed). Plan to fix as part of the next planned release.

### Current safe state

- New DEV URL `writersworkbench-develop.up.railway.app` is canonical for DEV; all DEV n8n workflows + all repo docs / wiki point at it.
- Old DEV URL `writersworkbenchdev-production.up.railway.app` still resolves and works (service still running in N8N-MCP/production). PROD continues calling it. No regression introduced this session.
- Wiki [[deployment-railway]], [[env-vars-by-tier]], [[dev-database]], etc. correctly describe the new canonical DEV URL.
- Wiki [[hotfixes]] section needs a new entry for the PROD-email-misrouting bug — will add when user gives direction.

Updated [[index]] and todo list reflect this state. Railway archive deferred.

## [2026-05-17] ops | DEV URL consolidation — COMPLETE

Follow-up after user clarified "there is only one Postal server / one send URL." My halt on the Railway archive was based on stale wiki docs claiming two Postal mail servers (dev/prod modes). Verified the actual Railway state:

- **All three Workbench services share the same `POSTAL_API_KEY`** (`sXUd9hc1XIEg8ybrGdUuZQhw`), same `POSTAL_API_URL`, same `SENDER_EMAIL`, same `EMAIL_SECRET`, same `INGESTION_SECRET`, same `APPROVAL_SECRET`, same `NEWSLETTER_CALLBACK_SECRET`.
- One Postal mail server (in Postal admin, all calls hit the same server). Email delivers regardless of which Workbench URL the call came from.
- The only difference: `SENDER_NAME` — PROD says "The Writers Workbench", DEV says "The Writers Workbench (Dev)".

So my earlier "PROD email broken" claim was wrong. Real impact of PROD-calling-OLD-DEV-URL was:
- From-line said "(Dev)" instead of "The Writers Workbench" — cosmetic.
- Audit log INSERT (api_usage_v2 / email-send events) landed in DEV Supabase instead of PROD Supabase — audit-trail dilution, no user-facing impact, no billing impact (credits deducted at chat-proxy time, not send-email time).

With that clarified, executed the full consolidation:

### Completed actions

1. **PROD n8n workflows (14 updated):** redirected from `writersworkbenchdev-production.up.railway.app` → `writersworkbench-production.up.railway.app` via REST PUT. Same EMAIL_SECRET so auth still works. Same Postal so email still delivers. From-line now "The Writers Workbench" correctly. Audit log now lands in PROD Supabase.

   Workflows: PROD - Tool - Brainstorm Chapter / Edit Outline / Brainstorm Story / Repurpose to Social Posts / Write Blog Post / Email Research Report / Format Kindle Book / Generate Cover Art / Write Newsletter / QA Chapter / Write Short Story; PROD - Sub - Manage Library; PROD - Worker - Write Chapter; PROD - 17 Cron: Scheduled Publisher.

2. **Final n8n scan:** zero workflows (DEV or PROD) still reference the old URL.

3. **Archived Railway service** `N8N-MCP/production/WritersWorkbenchDev` via `railway down`:
   - Active deployment removed.
   - Service config + env vars + deployment history preserved in Railway for rollback.
   - Old URL `writersworkbenchdev-production.up.railway.app` now returns **HTTP 404** (service unavailable).
   - To restore: `railway link --project N8N-MCP --environment production --service WritersWorkbenchDev` then `railway redeploy`.

4. **Post-archive verification:**
   - New canonical DEV `writersworkbench-develop.up.railway.app` → HTTP 200, environment: development, all checks ok.
   - PROD `writersworkbench-production.up.railway.app` → HTTP 200, environment: production, all checks ok, deployed_at unchanged 2026-04-28 (untouched).
   - Old archived URL → HTTP 404 (expected).

### Final canonical state

| Tier | Project | Environment | Service | URL |
|---|---|---|---|---|
| PROD | bubbly-solace | production | WritersWorkbench | `writersworkbench-production.up.railway.app` |
| DEV | bubbly-solace | develop | WritersWorkbench | `writersworkbench-develop.up.railway.app` |
| (V1) | n/a (n8n only) | n/a | n/a | n/a |

Clean. One DEV. One PROD. Both in `bubbly-solace`. N8N-MCP project hosts only the Postal stack (postal-web, postal-mariadb, postal-worker) plus the now-archived Workbench service.

### Wiki corrections still pending (do these next)

- [[postal-mail-stack]] page claims two mail servers "writers-workbench-mail-dev" (Development mode) and "writers-workbench-mail-prod" (Live mode). Reality is one Postal mail server shared across tiers. Page needs rewrite.
- [[email-pipeline]] makes the same two-mail-server claim. Same fix.
- [[credentials-map]] lists per-tier POSTAL_API_KEY. Reality is one shared key. Fix.
- [[env-vars-by-tier]] lists POSTAL_API_KEY as a per-tier secret. It isn't. Fix.
- [[hotfixes]] entry about v1.1.0 SENDER_NAME=(Dev) being a real bug — was correct on cosmetic, wrong on "emails not delivering".
- [[sprint-11-postal]] mail-server discussion needs Postal-one-server correction.

Deferred those wiki rewrites to a follow-up. They're documentation, not functional. The actual system is now consolidated and working.

## [2026-05-25] update | work ordering reset — 5-gate sequencing supersedes Sprint 9 next

User mandate: reorder all open work around four constraints — prioritize Sprint 15, hold Sprint 9 until Sprints 16-22 complete, block all PRs to `main` until newsletter development is 100% complete, and ship the B2B Author Agent API platform (Sprints 23-27).

Filed [[work-ordering-2026-05]] under `sprints/` as the new authoritative sequencing page. Five hard gates:

1. **Gate 1 — Newsletter PROD ship** (this week): merge PR #76, apply migrations 013/014/016/017 to PROD, promote 6 n8n workflows, seed demo, regression smoke, release tag. Until this gate clears, no PR merges to `main`.
2. **Gate 2 — Sprint 15 testbed** ([[sprint-15-testbed]], ~4 weeks). Empirical bake-off feeds Gate 3 LLM choice.
3. **Gate 3 — Python backend rewrite** (Sprints 16-22 per [[python-migration-roadmap]], ~10 weeks). Sprint 18 estimate is ~1.5 wk if Haiku 4.5 wins the Sprint 15 bake-off, ~2.5 wk if Sonnet 4.6 wins — revisit post-2.4.
4. **Gate 4 — B2B platform** (Sprints 23-27, ~5.5 weeks).
5. **Gate 5 — Sprint 9 Stripe** (last, riding on Sprint 25 tier + metering).

Interleaved side tasks (auth Site URL fix, CRON_SECRET, Google OAuth, Postal wiki rewrites, URL-consolidation PR, Eve KB cleanup, annotation exclusions UI, cron health dashboard) are explicitly allowed in parallel — none block any gate.

Existing pages updated:
- [[planned-sprints]] — top banner + "Recommended next sprint" section now point to [[work-ordering-2026-05]]; story lists remain authoritative for sprint *content*.
- [[sprints/_index]] — [[work-ordering-2026-05]] added with **CURRENT ORDER** marker.
- [[index]] — Sprints section + Quick reference table updated.

The 2026-04-29 sequencing (`9 → 13 → 14 → 15 → 16 → 17 → 18`) is now historical. Per user direction, the new order is contract; dates may slip but ordering does not.

## [2026-05-28] update | Gate 1 progress, PROD Redis outage fix, newsletter PROD-ship runbook

Executed Gate 1 (newsletter PROD ship) of [[work-ordering-2026-05]]:
- E2E suite fixed (7 selector/timing failures from first authed run) + PR #76 and PR #68 merged to `develop`.
- PROD Supabase migrations **013/014/015/016/017 applied + verified** (us-west-2 pooler). PR #68 turned out NOT stale — it carried migration 015 + the render-html node; merged it.

**PROD Redis outage discovered + fixed.** PROD `/api/health` was hanging; root cause = PROD Redis service had been down since a 2026-05-19 SIGTERM with no restart (BullMQ + SSE dead, app otherwise up). Redeployed PROD Redis → then PROD Workbench (its healthcheck gates on `/api/health`, so Redis had to come up first). PROD now all-ok. Captured as auto-memory `prod-redis-outage-risk` + flagged the no-uptime-alerting gap and DEV app-sleep risk.

**Architecture review of newsletter ↔ n8n** (user pushed back on my earlier assumptions). Findings: the Workbench triggers via a single `N8N_NEWSLETTER_WEBHOOK_URL` env var (no tier suffix), **unset on both tiers**. The 4 newsletter workflows (`Content - Newsletter Agent V2` form+webhook, `AI News Data Ingestion V2` 17 RSS/schedule, 2 DEV crons) are all DEV-wired (callbacks → `writersworkbench-develop`) with no PROD copies. `promote-dev-to-prod.py` can't create them (UPDATE-in-place only). Callback secrets are tier-shared so PROD copies can reuse the n8n credentials.

Filed [[newsletter-prod-ship-runbook]] under `operations/` with the concrete create-not-update procedure (DEV webhook path `compose-newsletter-dev` → PROD `compose-newsletter-v2`, callback host retarget, env var per tier, id-map, seed, smoke, release). Updated [[promotion-dev-to-prod]], [[operations/_index]], [[index]] to point at it. Next action (pending user): Step 0 — wire + prove the flow on DEV before replicating to PROD.

## [2026-05-29] build | newsletter Python microservices design + n8n compose-path bug fixes

While proving the newsletter flow on DEV (Gate 1 Step 0), discovered the in-app/webhook compose path had **never run end-to-end** (the trigger env var was unset until now). Fixed 5 bug classes on the DEV `Content - Newsletter Agent V2` workflow + server to get it from "dead at step 1" to "picks stories at ~step 13": (1) missing `=` expr prefix on 2 `/api/ingestion/get` download URLs (sent literal `{{…}}`); (2) those nodes pulled multi-MB unused HTML → n8n transfer ECONNRESET, fixed with a backward-compatible `?include_html=0` md-only opt-out on `GET /api/ingestion/get/:key` (deployed to DEV via `railway up`, 1.65MB→6KB); (3) 54 `$('form_trigger')` refs broken on the webhook path → `$('set_trigger_inputs')`; (4) retired Gemini model `…preview-06-05` (404) → GA `gemini-2.5-pro`; (5) 6 `share_*_email` nodes with nested-`{{ }}`/Slack-shortcode bodies rewritten. PROD untouched throughout.

Then pivoted (user direction): **stop patching n8n; design its replacement.** Wrote [[newsletter-microservices]] under `architecture/python-backend/` — design-only — for an own-Docker-image set of Python newsletter microservices, **UI-driven (no operator emails)**, consuming `content_ingestion_v2` from the (retained) n8n ingestion workflow. Grounded in the full n8n node inventory (102 nodes) as the source of truth; durable state-machine HITL (no held workers); SSE bridged through the existing Express endpoint via Redis pub/sub; in-UI review replaces the 6 emails. Deepens [[service-decomposition]] Module 9 / [[python-migration-roadmap]] Sprint 20. Awaiting user approval of 4 product decisions (subscriber delivery, picker model, image-review gate, monolith-vs-split granularity).

## [2026-05-29] build | Writer Engine framework — per-step microservices design + API system-test plan

Per user direction, elevated the newsletter rewrite into a program-level architecture shift. New/changed pages:
- [[engine-framework]] (NEW) — the engine **is the product** (salable library/API, "engine behind writing apps"); **true per-step microservices** on a shared `writer_engine` library; **newsletter + write-workshop combined** into one framework; **framework-first, ahead of Stripe/B2B**; **scalability to customer-bandwidth goals** as a hard requirement (independent per-step horizontal scaling, queue-driven, token-budget gatekeeper). Reframes [[python-migration-roadmap]] into F0-F4 phases.
- [[master-plan]] — added a 2026-05-29 revision banner + marked the *modular-monolith* and *3-service-group* decision gates **SUPERSEDED** → per-step microservices; points to [[engine-framework]].
- [[newsletter-microservices]] — locked 4 user decisions: subscriber delivery = BOTH (Postal email + web permalink); picker = Gemini 2.5 Pro; image selection = in-UI review gate (3rd HITL gate); granularity = per-step services on the shared library. Added scalability section + revised §3 architecture/diagram + §5 state machine (3 gates).
- [[engine-api-system-tests]] (NEW) — rewrites the manual 114-test [[newsletter-test-plan]] as **automated system tests against the API**: L0 contract, L2 orchestrated E2E, L3 HITL, L4 SSE, L5 n8n parity, **L6 scalability/load (bandwidth-goal gate)**, L7 failure-injection, L8 tenancy. Maps each `T-NN` → `S-NN`; extends to write-workshop services. Added successor banner on the manual plan; updated testing + python-backend indexes.

Context: this followed a Gate-1 attempt to prove the n8n newsletter compose path on DEV, which surfaced that the webhook path had never run end-to-end (5 bug classes fixed on DEV n8n + server) — the user then chose to replace the workflow with the Python engine rather than keep patching n8n. Design-only; awaiting approval. PROD untouched.

## [2026-05-29] build | engine framework sprint breakdown (F0-F2) + start-today blocker audit

Added [[engine-framework-sprints]] — task breakdown for the framework-first build: F0 foundation (8 tasks, ~37 pts, start today), F1 write-workshop step services (~44 pts), F2 newsletter step services (~49 pts), each task's DoD tied to [[engine-api-system-tests]]. Updated sprints [[_index]].

**Start-today blocker audit = 🟢 no hard blockers.** Present: Anthropic/KIE.AI/Postal/Redis/Supabase/INGESTION_SECRET keys on DEV Railway, Redis healthy, tables present, ingestion data exists. Pre-flight config (Day-1, needed by F1/F2 not F0): provision Gemini picker key (from n8n cred QCbiHRahj2Q15wqr), Perplexity key (n8n cred ggr9QCRobQVA6Lwb), Firecrawl key. Ordering reconciliations (not technical blockers): Sprint-15 testbed gates cutover not F0 — folded into F0-7 harness; Gate-1 newsletter-PROD-ship-via-n8n is superseded by the engine (newsletter ships via F2; n8n path kept as parity reference). No engine repo/branch yet = first task, not a blocker. Carryover: commit the uncommitted DEV `ingestion.ts ?include_html=0` fix to develop.

## [2026-05-30] build | engine F0 foundation — COMPLETE

Implemented and verified the F0 Writer Engine foundation in `engine/` (8 tasks, ~37 pts per [[engine-framework-sprints]]). The engine is a uv-workspace monorepo with a salable `writer_engine` library + 3 per-step deployables (gateway / orchestrator / library-retrieve-step) running the vertical slice end-to-end on the shared engine.

**What landed (engine/):**
- `packages/writer_engine/` library: `schemas` (StepInput/Output/Progress/ExecutionState + Stage enum incl. the 3 newsletter HITL stages), `llm` (Anthropic w/ prompt caching + token accounting, Gemini async-wrapped for the picker, Perplexity for research, `LLMRouter`), `prompt_store` (defaults + Supabase overrides + hot-reload), `supabase` admin client, `redis_client` (async + arq settings + SSE pub/sub helper), `storage`, `postal`, `telemetry` (structlog JSON + Prometheus histograms/counters for HTTP/step/LLM/tokens), `auth` (X-Service-Secret + X-Admin-Token + X-Api-Key stub + Supabase JWT helper), `idempotency` (Redis-cached `idempotent_call`), `rate_limit` (sliding window), `state_machine` (durable saga `OrchestratorBase` + `InMemoryStateStore` for the demo + `HitlGate` create/resolve/expiry + `emit_progress` SSE publisher + `run_step_via_http`), `step_service` template (`build_step_app`).
- `services/gateway/` — FastAPI `/internal` (X-Service-Secret), `/v1` (X-Api-Key), `/admin` (X-Admin-Token), SSE relay at `/executions/{id}/events`, OpenAPI `/docs`.
- `services/orchestrator/` — saga app + the `LibraryRetrieveOrchestrator` driving the vertical slice through the state machine.
- `services/library_retrieve_step/` — F0-8 step service (Supabase read with in-memory fixture fallback so the demo runs key-less).
- Dockerfiles per service, `docker-compose.yml` (redis + 3 services), `engine-ci.yml` GitHub workflow, `load/k6_smoke.js` + `load/prometheus.yml` (L6 harness scaffold), `Makefile`, `.env.example`, `.pre-commit-config.yaml`, `docs/adding-a-step-service.md`.

**F0 verification (green):**
- `uv sync --all-packages --all-extras` — clean install of writer-engine + gateway + orchestrator + library-retrieve-step + dev deps.
- `ruff check` + `ruff format --check` — All checks passed.
- `mypy` — Success: no issues found in 50 source files.
- `pytest` — **37 passed** in 1.47s, covering: L0 contract (schemas), L1 step service template (auth + dispatch + error envelope), L1 library_retrieve handler, L2 orchestrated E2E (gateway → orchestrator → step via in-process ASGI), L3 HITL (create/resolve/double-resolve/expiry), L4 SSE event capture (state-machine emits INIT/GATHERING/SAVED), idempotency (Redis-cached), prompt store, gateway auth on /internal+/v1+/admin, internal forward to orchestrator.
- `docker compose config` — valid; actual `compose build` to run on CI (local Docker daemon currently 500-ing).

**Carryover unchanged.** Still uncommitted from the prior session: the DEV server `?include_html=0` fix in `writers-workbench/server/src/routes/ingestion.ts` (deployed via `railway up`, not committed). Engine work also currently uncommitted in `engine/` — branch/commit decision pending.

**Next.** F1 (write-workshop step services) + F2 (newsletter step services) can begin from the template; F2 is fully specced in [[newsletter-microservices]]. Day-1 pre-flight items still: provision Gemini / Perplexity / Firecrawl keys in the engine env.

## [2026-05-30] build | engine F1 + F2 — STARTED (newsletter orchestrator + all 18 step services land)

Per user direction (engine stays in this repo; start both F1 and F2 together), expanded the engine from F0's vertical slice to the full per-step microservice topology + the newsletter saga. All 18 new step services follow the F0 step-service template, each its own image + workspace package; the newsletter orchestrator runs end-to-end with the 3 HITL gates (decision #3 image-review included) and the BOTH-delivery (Postal + permalink, decision #1) flow.

**New under `engine/`:**
- `packages/writer_engine/schemas/newsletter.py` — IngestedArticle, PickedStories, SubjectLineProposal, StorySegment, ImageOptions, AssembledNewsletter, RenderedNewsletter, NewsletterSendRow, DeliveryResult, ApprovalReviewPayload, NewsletterRunConfig.
- `packages/writer_engine/schemas/chapter.py` — WriteChapterRequest/Response, BibleEntry, QaReport, DriftScanResult, BrainstormStoryRequest/Response, ResearchRequest, ResearchReportRow.
- `packages/writer_engine/prompt_store/seeds.py` — 16 default prompt strings keyed `<module>.<step>.{system,user_template}` matching the n8n node names; the real n8n prompts port to `app_config.prompts` and hot-reload via `/admin/reload-prompts`.
- `packages/writer_engine/llm/structured.py` + `factory.py` — `complete_structured()` (LLM + JSON + Pydantic-validate) and a cached multi-provider `LLMRouter`.

**F2 newsletter step services (10) — one image per step:**
`gather_step` (8010) · `pick_step` (8011, Gemini 2.5 Pro per decision #2) · `subject_step` (8012, Claude) · `scrape_step` (8013, Firecrawl) · `segment_step` (8014, Claude, per-story fan-out) · `image_step` (8015) · `assemble_step` (8016, intro + other-stories + markdown concat) · `render_step` (8017, masthead template w/ Playfair fallback) · `persist_step` (8018, idempotent `newsletter_sends_v2` upsert) · `deliver_step` (8019, BOTH Postal email + web permalink via Supabase Storage). Each gracefully falls back to a local fixture when its provider key isn't set, so the local stack runs key-less.

**F2 orchestrator — `newsletter_orch.py`:** durable state machine over the `Stage` enum (`gathering → picking → awaiting_stories_approval → stories_approved → subject → awaiting_subject_approval → subject_approved → writing_segments → proposing_images → awaiting_image_approval → images_approved → assembling → rendering → saved → sending → sent`), 3 HITL gates with bounded revision loops (MAX_REVISIONS_PER_GATE=2), per-story segment fan-out, image-choice override from the image-gate decision, end-to-end delivery returning send_row + delivery result. Exposed at `POST /pipelines/newsletter/run` on the orchestrator service. Test-time `set_resolution_hook` auto-resolves gates for synchronous L2 flow; real PROD uses the durable resume model in [[engine-framework]] §5.

**F1 write-workshop step services (8) — module-level, per-op dispatch via `payload.op`:**
`chapter_step` (8020): write / qa / scan-drift / evaluate-genre / extract-bible / format-kindle · `research_step` (8021): derive-questions + Perplexity query + synthesis · `brainstorm_step` (8022): story / chapter / edit-outline · `media_step` (8023): cover-art / social-posts / scrape-url · `library_step` (8024): insert-draft / lifecycle / retrieve / list-outlines (real Supabase reads or stub) · `story_bible_step` (8025): add (with `(project_id, entry_type, name)` dedupe) / list · `approval_step` (8026): issue / resolve (thin wrapper over `state_machine.hitl`) · `notify_step` (8027): email (Postal) / eve-callback / eve-reset-greeting.

**Ops:**
- `docker-compose.yml` updated with all 19 services (1 F0 + 10 F2 + 8 F1), shared `*step-defaults` anchor, orchestrator env wiring (`*_STEP_URL` per step), redis health-gated startup.
- 19 new Dockerfiles (per service), workspace + testpaths in `pyproject.toml`.

**Verification (green):**
- `uv sync --all-packages --all-extras` clean.
- `ruff check` + `ruff format --check` — All checks passed.
- `mypy` — Success: no issues found in **56 source files**.
- `pytest` — **57 passed** in 3.26s. New: 19-service parametrized smoke (L0 health + L0 auth-required + L1 dispatch) and an L2 newsletter-orch end-to-end through all 10 F2 step apps via an in-process `_RoutingTransport`, auto-approving all 3 HITL gates, validating Stage transitions and final `status="sent"` with send_row + delivery payload.

**Footprint:** 105 .py files, 19 step services, 2 orchestrators (library_retrieve + newsletter), 12 test files. No `engine/` work committed yet — branch/commit decision still pending.

**Open follow-ups** (none block the next step):
- Port verbatim n8n prompts into `app_config.prompts` (Sprint 15 parity feed).
- Wire `arq` durable HITL resume (replaces the test-time `set_resolution_hook`) — F3 cutover work.
- Provision Gemini / Perplexity / Firecrawl keys to the engine Railway service when deploying.
- The `google-generativeai` SDK is sunsetting; migrate to `google.genai` (FutureWarning, no functional issue today).

## [2026-05-30] update | F1-A/F1-B no-new-Docker-images constraint + F2.5 chapter algorithm optimization sprint

User locked two decisions:

1. **F1-A and F1-B use the existing 2-image Docker architecture** (`writer-engine-gateway` + `writer-engine-runtime`). No new Docker images. Every new step service in F1-A lands as another background uvicorn process inside `writer-engine-runtime` via `services/runtime/Dockerfile` + `entrypoint.sh`. The per-step *architecture* (each step a separate FastAPI app + StepInput/StepOutput contract + own port) is preserved; only the deployment is unified. Per-service Railway split deferred to F3+ once traffic justifies it. At F1-B exit (Sprints 16-20) the entire writing-engine API runs through `writer-engine-gateway`.

2. **Chapter algorithm optimization is its own sprint, F2.5**, not part of Sprint 16-17. The migration (F1-A) already delivers a stated 15-25% latency improvement via infrastructure-level wins (n8n overhead reclaim, parallel sub-chapter writes, prompt caching, multi-LLM, idempotency). F2.5 is the separate cycle that changes the *algorithm itself*: F2.5-1 merge bible-extract into continuity-merge; F2.5-2 streaming continuity with early start; F2.5-3 tier-down models per sub-chapter role; F2.5-4 two-pass fast-draft / deep-edit; F2.5-5 speculative decoding for polish. Each card has an individual quality-floor + wall-clock ablation; revert and continue if any one fails. Cumulative target: p95 wall-clock −35% vs F1-A baseline (≈ −50% vs n8n), cost −30%, Sprint-15 rubric ≥0.95.

Wiki updates: amended [[engine-framework-sprints]] (locked F1 deployment constraint banner + split F1 into F1-A "port the step logic" / F1-B "hub routing + cutover" / explicit pre-F1-A prerequisite to narrow the step-service fallback so it doesn't mask real errors + revised sequencing diagram to include F2.5 between F2 and F1-B). New [[chapter-optimization-sprint]] under Engineering/sprints/. Updated [[Engineering/sprints/_index]].

## [2026-05-30] build | engine LIVE on Railway DEV (gateway + runtime), end-to-end smoke green

Deployed both engine services to Railway DEV in `bubbly-solace/develop`:
- `writer-engine-gateway` → https://writer-engine-gateway-develop.up.railway.app
- `writer-engine-runtime` → https://writer-engine-runtime-develop.up.railway.app

Build path: bumped uv 0.4.18 → 0.5.13 in both Dockerfiles (`--all-packages` flag), runtime image now contains orchestrator + arq worker + 11 step services as background uvicorn processes on localhost:8002 + 8010-8019. Gateway forwards `/internal/*` to `http://writer-engine-runtime.railway.internal:8001` over the Railway private network. `railway.toml` at engine root swapped between deploys to select per-service Dockerfile.

Gotcha caught + documented in [`engine/docs/deployment.md`](engine/docs/deployment.md): each engine Railway service needs an **explicit `PORT` env var** matching the app's bound port (gateway=8000, runtime=8001). Without it Railway's edge 502s with "Application failed to respond" despite the container running fine. The `--port` flag on `railway domain` alone isn't sufficient. Both services now set + healthy.

Smoke: `POST /internal/library/retrieve` through gateway → orchestrator → library_retrieve_step → live DEV Supabase round-trip → HTTP 200 with `execution_id` + `items[]`. All env keys (Anthropic, Gemini 2.5 Pro picker, Perplexity, OpenAI, Firecrawl, KIE.AI, Postal, Supabase, INGESTION_SECRET, ARCHIVE_BASE_URL) live in the engine env.

Next: wire WritersWorkbench DEV to point at the engine gateway (`NEWSLETTER_BACKEND=python` + `NEWSLETTER_SERVICE_URL=http://writer-engine-gateway.railway.internal:8000` + matching `SERVICE_SHARED_SECRET`), then trigger a UI-driven newsletter generate to flow through the full Python pipeline.

## [2026-06-02] update | F1-B sequencing — acceptance test gate before PROD flip
Reorganized F1-B so the PROD cutover (F1-8) is gated behind a formal **acceptance test of the DEV system** (new F1-7.5). Sequence: engine machinery (done, #105–#109) → hub rewiring + shadow (DEV) → **acceptance test on develop (A1 unit · A2 system S-suite · A3 R-CHAPTER-DB regression · A4 L5 parity ≥0.95 over 7-day shadow · A5 UAT)** → PROD flip only after A1–A5 pass + user sign-off. Details in [[f1-test-plan]] §4 and `engine/docs/f1b-hub-routing.md` §4. Updated the F1-B table + cutover-gates note in [[engine-framework-sprints]].

## [2026-06-10] build | Engine chat E2E functional test suite
Created [[engine-chat-e2e-suite]] in `testing/` — the engine-era rewrite of the repo `regressiontest_prompts.md` (R01–R121, n8n-era) as functional E2E tests driven through the **engine chat interface** (`/api/chat/proxy` → hub). One test per catalog op (20 in `hub/catalog.py`) + library lifecycle sub-ops + a genre×story-arc matrix + prologue/epilogue + the Workbench action buttons, each with pass/fail criteria keyed to the hub response `kind` (reply/data/queued), job polling (`/api/jobs/engine/:id`), DB rows in the V2 tables, and CR-009 completion emails. Section 9 pins the CR-010 **known gaps** so they degrade (not fake success): format-kindle removed (commit 6c74d08, Export tab is canonical), eve-callback placeholder, newsletter not a hub op, library versions/revert + story-bible-update + email-content not routable, embeddings off. Updated [[testing/_index]] and index.md.

## [2026-06-20] build | Full engine E2E suite (1:1 port) + parity sprint set
Corrected [[engine-chat-e2e-suite]] to a FULL 1:1 port of regressiontest_prompts.md — all 161 tests (R01–R121 chat + V01–V40 voice), nothing consolidated. Voice tests rewritten as `/internal/hub/voice` webhook tests with simulated input (no live agent). Each test asserts the FULL behavior the completed engine must satisfy (target state), with `impl: pending CR-010 <ref>` tags on ops not yet built. Created [[engine-e2e-parity-sprints]] under sprints/ — the minimal set (E2E-1..E2E-5) implementing ONLY the gaps the suite is blocked on: `library.email-content`; `library.versions`+`library.revert`; newsletter-as-hub-op; `chapter.plan` dual-arc depth; `notify.eve-callback`. Each sprint maps to the exact tests it unblocks; when all ship the whole suite runs. Out-of-scope-for-suite (embeddings, token accounting, ingestion cron, multi-engine scale) noted explicitly. Updated testing/_index, sprints/_index, index.md.
