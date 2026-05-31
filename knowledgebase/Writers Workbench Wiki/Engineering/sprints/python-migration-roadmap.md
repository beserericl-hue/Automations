---
name: Python migration roadmap
description: Multi-quarter sprint plan to migrate from n8n workflow tree to Python backend (author-agent-api). Phases A-E covering internal migration, capability additions, and B2B platform launch. Replaces Sprints 16-18 in planned-sprints.
type: concept
tags: [sprints, roadmap, python-backend, migration, sprints-16-26]
last_reviewed: 2026-05-09
---

# Python migration roadmap

The plan to move from n8n workflow tree to the Python backend described in [[architecture/python-backend/master-plan]]. Reframes Sprints 16-18 from the prior plan + adds Sprints 19-26 for full backend + B2B productization.

## Phases

| Phase | Sprints | Pts | Calendar weeks | Deliverable |
|---|---|---|---|---|
| **A — Foundation + chapter** | 16-17 | ~50 | 6-8 | Backend service running; chapter-write migrated; passes testbed Q/A |
| **B — Heavy modules** | 18 | ~30 | 4 | Brainstorm, research, media, qa migrated. All "heavy-group" complete. |
| **C — Light modules** | 19 | ~25 | 3-4 | Library, story_bible, approval, notify migrated. All "light-group" complete. |
| **D — Newsletter + cron + new capabilities** | 20-21 | ~35 | 4-5 | Newsletter cluster + scheduler migrated; cross-chapter continuity built. |
| **E — Hub migration + n8n decommissioning** | 22 | ~35 | 4-5 | Hub rewritten in Python. n8n eliminated from active path. **Internal migration complete.** |
| **F — B2B productization** | 23-27 | ~70 | 8-12 | API keys, multi-tenancy, billing, docs, SDKs, beta launch, GA launch. |

**Total**: ~245 pts across Sprints 16-27. ~7-10 calendar months.

**Critical gate**: Phase A must ship + run on PROD for ≥30 days before [[planned-sprints|Sprint 9 Stripe]] paid-seat launch enables.

Prerequisite: [[sprint-15-testbed]] completes first. Testbed validates LLM strategy + provides Q/A engine that downstream sprints rely on.

---

## Phase A — Foundation + chapter (Sprints 16-17)

### Sprint 16 — Backend foundation + chapter port (28 pts)

**Goal:** Author Agent API service running. Chapter writer migrated and passing testbed Q/A.

#### S16-1 — Python project skeleton (3 pts)

- Create `author-agent-backend` repo (or monorepo subdir).
- FastAPI app + Poetry/uv dependency management.
- Module structure per [[service-decomposition]].
- Pre-commit hooks: ruff + mypy + pytest.
- README with setup instructions.
- `Dockerfile.heavy` / `.light` / `.cron` building three images.

**Acceptance:** `docker build` produces three images. Local `docker compose up` runs all three. `/admin/health` returns 200 on each.

#### S16-2 — Shared infrastructure (5 pts)

- `app/shared/auth.py` — `requireServiceSecret` middleware + `requireApiKey` middleware.
- `app/shared/supabase_client.py` — service-role client + tenant-aware wrapper.
- `app/shared/anthropic_client.py` — async client with retry + token-counting.
- `app/shared/redis_client.py` — async ioredis-equivalent (`redis.asyncio`).
- `app/shared/idempotency.py` — Redis cache decorator.
- `app/shared/rate_limit.py` — sliding window.
- `app/shared/audit.py` — INSERT api_usage_v2 / tenant_audit_log_v2.
- `app/shared/telemetry.py` — structlog + Prometheus + OTel setup.
- `app/shared/prompts.py` — load from app_config_v2 with hot-reload.

**Acceptance:** Each module has unit tests covering happy path + failure modes. >80% coverage.

#### S16-3 — Chapter module: core write path (8 pts)

- `app/modules/chapter/write.py` — `write_chapter(req) → response` orchestrator.
- `app/modules/chapter/context.py` — `build_chapter_context()` (LOCKED CHARACTER ROSTER builder).
- `app/modules/chapter/sub_chapter.py` — async parallel sub-chapter writes.
- `app/modules/chapter/continuity.py` — continuity merge LLM call.
- `app/modules/chapter/extract_bible.py` — defensive JSON parse + UPSERT.
- `app/modules/chapter/persist.py` — idempotent UPSERT keyed on `chapter_run_id`.
- HTTP route `/internal/chapters/write`.

**Acceptance:**
- Smoke test: write a chapter end-to-end against DEV Supabase + Anthropic.
- Output byte-equivalent to n8n version on the same input (allowing for LLM stochasticity).
- Idempotency: replay same `chapter_run_id` returns cached result.

#### S16-4 — Chapter module: Q/A surfaces (5 pts)

- `app/modules/chapter/qa.py` — port `Tool - QA Chapter`.
- `app/modules/chapter/scan_drift.py` — port deterministic regex v4.
- `app/modules/chapter/genre_eval.py` — port `Tool - Evaluate Genre Compliance`.
- `app/modules/chapter/extract_bible.py` standalone endpoint.
- HTTP routes for each.

**Acceptance:** Drift scanner output matches n8n version on same input (deterministic, byte-equal). QA + genre eval scores within 0.05 of n8n version on testbed gold-standard chapters.

#### S16-5 — Hub integration: chapter routing (4 pts)

- DEV n8n hub `ai_tool` for `write_chapter` swapped from `executeWorkflow` to HTTP Request to `/internal/chapters/write`.
- DEV hub `ai_tool` for `qa_chapter`, `scan_character_drift`, `evaluate_genre_compliance` similarly.
- `app_config_v2.python_backend_routing` flag controls which tools route to Python vs n8n. Defaults: chapter operations → python; everything else → n8n.
- Hub system prompt unchanged.

**Acceptance:** End-to-end test from Workbench DEV → DEV hub → Python service → DEV Supabase. Smoke regression: prior n8n-tested chapter inputs produce comparable outputs through Python path.

#### S16-6 — Sprint 15 testbed integration (3 pts)

- Add `TEST - Worker - Write Chapter (Python)` as 5th LLM variant in [[sprint-15-testbed]].
- Run quality bake-off against the Python service: 50 chapters, 7 dimensional scores.
- Compare against `TEST - Worker - Write Chapter (Sonnet)` baseline.

**Acceptance:** Python service scores ≥ 0.95 of Sonnet baseline on every dimension. If not: triage + iterate before continuing.

---

### Sprint 17 — Heavy module ports + research/brainstorm (22 pts)

**Goal:** Brainstorm + research + edit_outline ported. Hub uses Python for all writing-adjacent operations.

#### S17-1 — Research module (5 pts)

- `app/modules/research/derive_questions.py` — chainLlm equivalent.
- `app/modules/research/perplexity.py` — native API client.
- `app/modules/research/synthesize.py` — Claude composes report.
- `app/modules/research/persist.py` — INSERT research_reports_v2.
- `app/modules/research/email_report.py` — calls notify module.
- HTTP routes: `/v1/research/run`, `/v1/research/{id}`, `/v1/research/{id}/email`.

**Acceptance:** Output byte-equivalent to `Sub - Research Pipeline` n8n workflow on same input.

#### S17-2 — Brainstorm module (8 pts)

- `app/modules/brainstorm/story.py` — full story outline.
- `app/modules/brainstorm/chapter.py` — sub-chapter outline for existing chapter.
- `app/modules/brainstorm/edit_outline.py` — targeted edits with character lock per CLAUDE.md sprint 12 rules.
- HTTP routes: `/v1/brainstorm/{story,chapter,edit-outline}`.

**Acceptance:**
- Locked character preservation in revision mode (regression test against [[regression-tests]] R-tests).
- `edit_outline` doesn't trigger full re-brainstorm.
- Story arc loading from `story_arcs_v2` matches n8n version.

#### S17-3 — Chapter rewrite-with-research (5 pts)

- `app/modules/chapter/rewrite_with_research.py` — calls research module + Claude rewrite.
- Citations toggle per `project_type`.
- Idempotent UPSERT.
- HTTP route: `/v1/chapters/{id}/rewrite-with-research`.

**Acceptance:** End-to-end test matches the 2026-04-24 reference run (research_report_id created, content_text updated, metadata.last_rewrite populated, citations_in_prose correctly set per project_type).

#### S17-4 — Hub routing for brainstorm + research (2 pts)

- Update `app_config_v2.python_backend_routing` flags to route brainstorm + research to Python.
- DEV hub HTTP Request nodes wired.

**Acceptance:** All Phase A tools (write_chapter, qa, scan_drift, genre_eval, brainstorm_story, brainstorm_chapter, edit_outline, research, rewrite_chapter_with_research) route through Python in DEV.

#### S17-5 — DEV → PROD promotion (2 pts)

- Provision PROD `author-agent-heavy` Railway service.
- Set env vars (PROD Supabase, etc.).
- Deploy heavy image.
- Update PROD hub `python_backend_routing` flags.
- Shadow mode: PROD hub calls both n8n + Python; uses n8n result, compares Python.
- After 7 days clean comparison: cut over Phase A operations to Python.

**Acceptance:** PROD users using Python-served chapters for ≥30 days without rollback. Quality scores match. Latency improved 15-25%.

**This unlocks Sprint 9 paid-seat launch.** ✅

---

## Phase B — Remaining heavy modules (Sprint 18)

### Sprint 18 — Media + final heavy operations (20 pts)

#### S18-1 — Media module (8 pts)

- `app/modules/media/cover_art.py` — KIE.AI client + DALL-E fallback.
- `app/modules/media/social_posts.py` — multi-platform Claude calls.
- `app/modules/media/scrape_url.py` — Firecrawl wrapper.
- `app/modules/media/storage.py` — Supabase Storage upload helpers.
- HTTP routes: `/v1/media/{cover-art,social-posts,scrape-url}`.

**Acceptance:**
- Cover art generated, uploaded, linked in `generated_images_v2`.
- Social posts generated for 4 platforms.
- Scrape URL returns markdown + html + metadata.

#### S18-2 — Format Kindle book (3 pts)

- `app/modules/chapter/format_kindle.py` — KDP-formatted manuscript export.
- HTTP route: `/v1/chapters/{id}/format-kindle`.

**Acceptance:** .docx export byte-equivalent to existing Workbench `/api/export/:contentId` for the same content.

#### S18-3 — Hub routing + cutover (3 pts)

- Switch media + kindle to Python in PROD `python_backend_routing`.
- Shadow + cutover per Sprint 17 pattern.

**Acceptance:** All "heavy" operations now Python-backed in PROD.

#### S18-4 — Capacity tuning (3 pts)

- Profile heavy-group memory + CPU under load.
- Right-size Railway service plan.
- Set up auto-scaling triggers (heavy-ops queue depth > 20 → +1 replica).
- Document baseline metrics in [[chapter-writer-architecture]] (replacing the old n8n description).

#### S18-5 — Decommission n8n heavy workflows (3 pts)

- Archive (don't delete) the migrated PROD workflows.
- Remove from active hub `ai_tool` references.
- Update [[workflow-id-map]] with deprecation status.
- Update [[workflow-tiers]] showing TEST + DEPRECATED tier states.

**Acceptance:** Old n8n workflows are no longer hit. Logs confirm zero invocations for 7 days. Then archive.

---

## Phase C — Light modules (Sprint 19)

### Sprint 19 — Library, story bible, approval, notify (25 pts)

#### S19-1 — Library module (10 pts)

- `app/modules/library/insert.py` — INSERT published_content_v2.
- `app/modules/library/lifecycle.py` — approve / publish / reject / schedule / unschedule. State machine validation. Email side-effects.
- `app/modules/library/versions.py` — list / get / save_version / revert.
- `app/modules/library/retrieve.py` — search/filter/list. Stop-words handling.
- `app/modules/library/outlines.py` — list_outlines + outline_versions + revert_outline.
- HTTP routes: `/v1/library/*`.

**Acceptance:** Every operation in `Sub - Manage Library` + `Sub - Retrieve Content` n8n workflows ported and tested.

#### S19-2 — Story bible + research reports (5 pts)

- `app/modules/story_bible/crud.py` — add / edit / delete / list.
- `app/modules/story_bible/dedupe.py` — `(entry_type, lower(name))` dedup logic.
- `app/modules/research_reports/crud.py` — basic CRUD (research module handles the writing path).
- HTTP routes: `/v1/story-bible/*`, `/v1/research-reports/*`.

**Acceptance:** Dedupe behavior matches the n8n hotfix extract_bible logic. Re-extracting same chapter doesn't produce duplicate entries.

#### S19-3 — Approval module (3 pts)

- `app/modules/approval/issue.py` — token generation.
- `app/modules/approval/validate.py` — token resolution + expiry.
- `app/modules/approval/actions.py` — approve / reject / extend.
- HTTP routes: `/v1/approvals/*`.

**Acceptance:** Newsletter approval flow end-to-end via Python service. Token expiry returns 404, not 401 (per [[api-contracts]] spec).

#### S19-4 — Notify module (4 pts)

- `app/modules/notify/eve_callback.py` — web SSE vs phone routing.
- `app/modules/notify/eve_kb_upload.py` — ElevenLabs KB doc upload.
- `app/modules/notify/eve_outbound_call.py` — Twilio via ElevenLabs.
- `app/modules/notify/email.py` — Postal client (or proxies to Workbench `/api/email/send`).
- HTTP routes: `/v1/notify/*`.

**Acceptance:** Eve callback routing identical to n8n version (web → SSE; no web → phone). Reset Eve Greeting workflow folded in or kept simple.

#### S19-5 — Light-group deploy + cutover (3 pts)

- Provision PROD `author-agent-light` Railway service.
- Cutover light operations per pattern.

**Acceptance:** All light operations now Python-backed in PROD.

---

## Phase D — Newsletter + cron + new capabilities (Sprints 20-21)

### Sprint 20 — Newsletter cluster + scheduler (20 pts)

#### S20-1 — Newsletter ingestion (5 pts)

- `app/modules/newsletter/ingestion.py` — single-URL + multi-user cron.
- Cron entry point on cron-group container.
- HTTP route: `/v1/newsletter/ingest` + `/v1/newsletter/cron/ingestion` (X-Cron-Secret).

**Acceptance:** 17 baseline feeds run nightly; rows inserted into `content_ingestion_v2` + `newsletter_ingestion_runs_v2` matches DEV n8n version.

#### S20-2 — Newsletter compose + send (8 pts)

- `app/modules/newsletter/compose.py` — gather → draft → render → save.
- `app/modules/newsletter/render.py` — Jinja2 (Handlebars-equivalent) merge.
- `app/modules/newsletter/fanout.py` — subscriber dispatch.
- `app/modules/newsletter/cadence.py` — cadence cron evaluation.
- HTTP routes for each.

**Acceptance:** End-to-end newsletter generation in DEV. Subscriber fan-out works. Approval flow integrates with approval module.

#### S20-3 — Scheduler module (3 pts)

- `app/modules/scheduler/publisher.py` — port Cron: Scheduled Publisher.
- `app/modules/scheduler/trial_check.py` — port Workbench trial-check cron.
- `app/modules/scheduler/credit_reset.py` — port credit-reset.
- `app/modules/scheduler/trial_warnings.py` — port trial-warnings emails.
- All on cron-group, gated by X-Cron-Secret.

**Acceptance:** Scheduler crons all migrate. Workbench `/api/cron/*` endpoints either deprecate or proxy to Python.

#### S20-4 — Cron-group provisioning + cutover (4 pts)

- Provision PROD `author-agent-cron` Railway service (single replica).
- Configure external scheduler (cron-job.org, Railway cron, etc.) hitting cron endpoints.
- Cutover newsletter + scheduler operations.
- Deactivate replaced n8n workflows.

**Acceptance:** All cron operations Python-backed. n8n cron workflows archived.

---

### Sprint 21 — Cross-chapter continuity (NEW capability) (15 pts)

#### S21-1 — Continuity check pipeline (8 pts)

- `app/modules/chapter/cross_chapter.py` — load all chapters in project, run contradiction detection.
- LLM-powered contradiction finder. Outputs structured `Contradiction[]` per [[api-contracts]].
- Optional auto-rewrite: generates `ProposedRewrite[]`.
- HTTP route: `/v1/projects/{id}/cross-chapter-continuity`.

**Acceptance:** Run on a known-good 7-chapter project: zero false positives. Run on a project with deliberately introduced contradiction: detects it.

#### S21-2 — Frontend integration (5 pts)

- New page in Workbench: `/projects/:id/continuity`.
- Triggers cross-chapter check; shows contradictions; lets user accept/reject proposed rewrites.
- Calls Python service via Workbench `/api/content/cross-chapter-continuity` proxy.

**Acceptance:** UX flow: open project → click "Check continuity" → wait → see findings → apply rewrites → see content_versions snapshot.

#### S21-3 — Promotion + dogfooding (2 pts)

- Run continuity check across all DEV projects to validate.
- Use findings to clean up existing test data.
- Document the new capability in [[chapter-writer-architecture]] + user guide.

**Acceptance:** Internal validation complete. Capability documented.

---

## Phase E — Hub migration + n8n decommissioning (Sprint 22)

The last piece of n8n elimination. After Sprint 22 ships, the active production path is fully Python; n8n hosts only V1 (Orig) workflows for legacy customers.

### Sprint 22 — Hub migration (35 pts)

**Goal:** Rewrite `PROD - The Author Agent` n8n hub as Python service. Decommission active-path n8n workflows.

#### S22-1 — Hub Python skeleton + preprocess_message (5 pts)

- `app/modules/hub/main.py` — FastAPI router for `/webhook/author_request` + `/v1/agent/run`.
- `app/modules/hub/preprocess.py` — regex pre-routing. Mirrors n8n hub `preprocess_message` Code node.
- `app/modules/hub/regex_rules.py` — all regex constants. Unit-tested.

**Acceptance:**
- 100% test coverage on preprocess_message edge cases (revert vs revise, listing detection, numbered selection, etc.).
- Behavior matches n8n hub on a corpus of 200+ representative messages.
- All sticky bugs from `regression-tests` B-tests covered (e.g. "revert outline" must not trigger brainstorm).

#### S22-2 — Agent loop + tool definitions (10 pts)

- `app/modules/hub/agent.py` — Anthropic tool-use loop with Claude Haiku 4.5 default.
- `app/modules/hub/tools.py` — 24 tool definitions matching n8n hub `ai_tool` list.
- `app/modules/hub/dispatcher.py` — tool name → service module function. In-process for sync; arq enqueue for async.
- `app/modules/hub/system_prompt.py` — system prompt loader; Jinja2 context injection (last_list, current_project, etc.).

**Acceptance:**
- Agent picks correct tool on a 200-message test corpus (≥95% accuracy match vs human-labeled "correct tool").
- All system-prompt sections preserved: TOOL OVERRIDE, Type A/B response, listing rules, mature fiction, genres, story arcs, Prologue/Epilogue, character lock, Eve mode rules, anti-stage-direction.
- Gemini 2.5 Flash configurable as fallback (env var `HUB_LLM_PROVIDER=gemini` flips backend).

#### S22-3 — Direct dispatch ops (3 pts)

- `direct_qa_chapter` — bypass agent for "Q/A report" trigger.
- `edit_outline` for small targeted changes — bypass agent.
- `revert_outline` — direct dispatch.

**Acceptance:** Each direct op tested. No agent fabrication observed.

#### S22-4 — Reset Eve Greeting + Approval Token Generator (3 pts)

- Reset Eve Greeting folded into `app/modules/notify/eve_reset.py` as a delayed background-ops job.
- Approval Token Generator already in `approval` module (Sprint 19); confirm full parity.

**Acceptance:** Both n8n workflows fully replaced. Smoke test passes for each.

#### S22-5 — Eve callback flow + KB upload (5 pts)

- `app/modules/notify/eve_callback.py` — web-vs-phone routing, ElevenLabs KB upload, outbound call orchestration.
- Replaces `Sub - Eve Knowledge Callback` n8n workflow.
- Triggers `Reset Eve Greeting` job after KB upload (30s delay).

**Acceptance:** End-to-end Eve callback test in DEV: web session active → SSE push; web session inactive → outbound call.

#### S22-6 — Shadow mode in DEV (3 pts)

- DEV: both n8n hub + Python hub receive every webhook.
- Response from n8n returned to user; Python response logged.
- Diff dashboard: `(message, n8n_response, python_response, agreement)` for every request.
- Run for 7 days minimum.

**Acceptance:** ≥95% agreement on tool selection and response framing. Disagreements triaged + fixed before cutover.

#### S22-7 — PROD shadow mode + cutover (4 pts)

- Provision PROD `api-svc` Railway service if not already up (might be up from Sprint 16).
- PROD: both hubs receive (via LB rule); n8n primary; Python shadow.
- 14-day shadow period.
- Cutover by user-id hash: 1% → 10% → 50% → 100% with monitoring at each step.

**Acceptance:** PROD on Python hub for ≥30 days without rollback. Quality scores match. Latency p95 ≤ 30% of n8n hub.

#### S22-8 — ElevenLabs forwarding tool update + Workbench chat-proxy update (2 pts)

- ElevenLabs `forward_writing_request_v2` (PROD) + `_dev` (DEV) URLs updated to point at LB hostname (which routes to api-svc).
- Workbench Express `chat-proxy` route updated to call Python hub instead of n8n hub. (Or migrated to call `/v1/agent/run` directly with internal service secret.)

**Acceptance:** Eve voice calls + Workbench chat both route through Python end-to-end. Zero n8n hops.

#### S22-9 — n8n decommissioning (no story — ongoing through Sprint 22)

For each migrated PROD workflow (~22 of them):
- Confirm zero invocations in n8n logs for 7 consecutive days.
- Rename to `[ARCHIVED-2026-XX-XX] PROD - <name>`. Deactivate.
- Keep for 90-day rollback window.

Final n8n state: V1 (Orig) workflows only. n8n container can scale to single small instance.

**Sprint 22 success criteria:**
- Every n8n PROD workflow except V1 archived.
- 100% PROD traffic on Python hub for ≥30 days without rollback.
- Latency improvement measurable (p95 chapter wall time reduced ≥15%).
- ElevenLabs forwarding tools point at Python LB.
- CLAUDE.md baseline-protection rules updated to reflect new tier model.

---

## Phase F — B2B platform launch (Sprints 23-27)

### Sprint 23 — B2B foundation (15 pts)

#### S22-1 — Multi-tenancy schema (5 pts)

- Migration adds `tenants_v2`, `api_keys_v2`, `api_usage_v2`, `tenant_audit_log_v2`, `tenant_prompts_v2`.
- Decision: dual schema (existing for Workbench, new `b2b_*` for B2B) per [[multi-tenancy]].
- Indexes + RLS policies.

**Acceptance:** Schema applied to DEV + PROD. CI schema-governance passes.

#### S22-2 — API key auth flow (5 pts)

- `app/shared/auth.py` extended with `requireApiKey`.
- API key prefix + argon2id hash.
- Redis auth cache (5-min TTL).
- `tenants_v2` resolution + tier loading.

**Acceptance:** End-to-end: create API key → call /v1 endpoint → verify auth → log to api_usage_v2.

#### S22-3 — Tenant-scoped Supabase wrapper (5 pts)

- `app/shared/tenant.py` — wrapper enforcing `tenant_id` on every query.
- Postgres `app.tenant_id` setting per request.
- Lint rule + integration tests for cross-tenant leak prevention.

**Acceptance:** Cross-tenant test: tenant A creates project; tenant B tries to access → 404. All endpoints have parallel test.

---

### Sprint 24 — B2B endpoint surfacing + rate limiting + idempotency (15 pts)

#### S23-1 — Public /v1/* surface (8 pts)

- All existing /internal/* endpoints get /v1/* equivalents with multi-tenancy.
- OpenAPI auto-spec at /docs.
- 404 (not 403) on cross-tenant access.

**Acceptance:** Customer can call /v1/chapters/write end-to-end with their tenant data only.

#### S23-2 — Rate limiting + tier feature gating (4 pts)

- Per-tenant rate limit (Redis sliding window).
- Tier-based feature gates (cross-chapter requires Pro+, etc.).
- 429 + 403 responses with proper error envelopes.

**Acceptance:** Free tenant hitting 6 RPM → 429. Free tenant calling /cross-chapter → 403 FORBIDDEN with FEATURE_NOT_IN_TIER.

#### S23-3 — Idempotency + webhooks (3 pts)

- Idempotency-Key handling for mutating endpoints.
- Webhook registration + delivery + signature verification helpers.
- Webhook delivery retry (3 attempts).

**Acceptance:** Replay same idempotency key → cached response. Webhook delivery includes proper signature; verify locally.

---

### Sprint 25 — B2B billing + customer dashboard (15 pts)

#### S24-1 — Stripe B2B integration (8 pts)

- Separate Stripe products from Workbench user-tier billing.
- Subscription tiers: Free / Starter / Pro / Scale / Enterprise.
- Metered usage records (nightly aggregation from `api_usage_v2`).
- Webhook handlers (`invoice.paid`, `invoice.payment_failed`, etc.).
- Customer portal link.

**Acceptance:** Customer can sign up for Starter, see invoice with token usage, upgrade to Pro mid-month, prorated correctly.

#### S24-2 — Customer dashboard (5 pts)

- New domain or subdomain (`api.authoragent.dev/dashboard` or `dashboard.authoragent.dev`).
- API key management.
- Usage charts.
- Billing portal link (Stripe-hosted).
- Audit log viewer.

**Acceptance:** All self-service flows work end-to-end. Customer never needs to email us for routine ops.

#### S24-3 — Documentation site (2 pts)

- mkdocs-material at `docs.authoragent.dev`.
- Quickstart, API reference (auto-generated from OpenAPI), webhooks, SDKs.
- Deploy via GitHub Actions on docs/ folder change.

**Acceptance:** New customer can sign up + reach first successful API call in < 10 minutes using only docs.

---

### Sprint 26 — SDK generation + beta launch (15 pts)

#### S25-1 — Python SDK (5 pts)

- Generated via openapi-generator-cli + hand-curated wrappers (sync helpers, retry, webhook verifier).
- Publish to PyPI as `authoragent`.
- Type-safe client; mypy + pyright clean.
- Quickstart README + jupyter notebook.

**Acceptance:** `pip install authoragent`; quickstart runs successfully against beta endpoint.

#### S25-2 — TypeScript SDK (5 pts)

- Same pattern. Publish to npm as `@authoragent/sdk`.

**Acceptance:** `npm install @authoragent/sdk`; quickstart runs.

#### S25-3 — Beta launch (5 pts)

- Recruit 5-10 design partners.
- Free Pro tier for beta period (3 months).
- Dedicated Slack channel for feedback.
- Weekly "office hours" with engineering.

**Acceptance:** ≥3 design partners successfully integrate. Bug reports tracked + fixed within 7 days.

---

### Sprint 27 — GA launch (10 pts)

#### S26-1 — Marketing site + pricing page (3 pts)

- Static marketing site (Vercel / Netlify).
- Pricing page with all 5 tiers.
- Case studies from beta customers.

#### S26-2 — Status page + SLA dashboard (2 pts)

- `status.authoragent.dev` with uptime + incident history.
- Public-visible per-endpoint health.

#### S26-3 — Self-service signup (3 pts)

- Email-verified signup creates Free tenant.
- First API key auto-issued on confirmation.
- Welcome email with quickstart link.

#### S26-4 — Launch comms + support flow (2 pts)

- Press release / Hacker News / Product Hunt launch.
- Customer support email + response SLA.
- On-call rotation for Scale + Enterprise tiers.

**Acceptance:** Public GA. First 100 paying customers within 30 days target.

---

## Cross-cutting requirements (every sprint)

### Testing

Every module port has:
- Unit tests covering happy + edge paths.
- Integration test against testbed Supabase.
- Quality regression test in [[sprint-15-testbed]].
- Cross-tenant test (Phase E onward).

### Documentation

Every shipped module has:
- Inline docstrings on every public function.
- Module-level README with API + examples.
- Updates to [[architecture/python-backend/_index]] catalog.

### Observability

Every endpoint:
- Structured log emission.
- Prometheus metric.
- OTel span.
- api_usage_v2 row.

## Sequencing within phases

```
Sprint 15 (testbed) ──→ Sprint 16 (foundation + chapter)
                          │
                          ↓
                       Sprint 17 (research + brainstorm)
                          │
                          ↓ ✅ Sprint 9 paid-seat launch unblocks
                       Sprint 18 (media + remaining heavy)
                          │
                          ↓
                       Sprint 19 (light modules)
                          │
                          ↓
                       Sprint 20 (newsletter + cron)
                          │
                          ↓
                       Sprint 21 (cross-chapter continuity)
                          │
                          ↓ ✅ Active workflows fully Python (hub still n8n)
                       Sprint 22 (HUB MIGRATION + n8n decommissioning)
                          │
                          ↓ ✅ n8n eliminated from active path
                       Sprint 23 (B2B foundation)
                          │
                          ↓
                       Sprint 24 (B2B surface + rate limit)
                          │
                          ↓
                       Sprint 25 (B2B billing + dashboard)
                          │
                          ↓
                       Sprint 26 (SDKs + beta)
                          │
                          ↓
                       Sprint 27 (GA launch)
```

Phase A (Sprints 16-17) is critical-path. Phase B-D can have minor parallelism if multiple engineers. Phase E follows internal migration complete.

## Risk register

| Risk | Sprint(s) | Mitigation |
|---|---|---|
| Quality regression on chapter port | 16, 17 | Sprint 15 testbed Q/A bake-off must pass before cutover |
| n8n hub HTTP Request reliability under load | 16-21 | Idempotency keys + retry; testbed validates |
| Multi-tenancy data leak | 22, 23 | Mandatory cross-tenant test per endpoint; dual-schema isolation |
| Stripe integration bugs | 24 | Use Stripe test mode end-to-end before live; reconcile usage records |
| SDK adoption requires support burden | 25 | Beta period builds support knowledge before GA |
| Anthropic Tier 4 not granted in time | 18+ | Stay on Tier 3; multi-LLM strategy compensates; B2B tier-based throttling |
| n8n decommissioning prematurely | 18-20 | Archive don't delete for ≥30 days; confirm zero invocations first |
| Customer integration support load at GA | 26 | Hire CSM before scaling B2B tier |

## Dependencies on other planned work

| Other sprint | Dependency direction | Notes |
|---|---|---|
| Sprint 9 (Stripe paid seats) | **BLOCKED until Phase A complete** | Hard gate per user direction |
| Sprint 14 (storage decision) | Independent | Storage decision affects bucket strategy in S18-1 |
| Sprint 15 (testbed) | **PREREQUISITE** | Q/A engine + gold rubric used throughout |
| Sprint 12 hotfixes | Already done | Story-bible extractor in Python from day 1 |
| Newsletter cluster (DEV-only) | Folded into Sprint 20 | DEV cluster is the prototype; PROD comes via this migration |

## Success metrics

### Per phase

- Phase A: Python service serving chapters in PROD ≥30 days; quality scores match baseline.
- Phase B: All heavy operations in Python; latency improved 15-25% measured.
- Phase C: All light operations in Python; CRUD throughput unchanged.
- Phase D: Newsletter + cron in Python; cross-chapter continuity validated on internal corpus.
- Phase E: ≥10 paying B2B customers within 60 days of GA.

### Overall

- Backend infrastructure cost: ≤ $500/mo at 100 daily Workbench users + 10 B2B customers.
- Backend latency p95: ≤ 6 minutes for chapter writes.
- Anthropic 429 rate: < 1% during peak.
- Test coverage: > 85% on backend code.
- Customer NPS at 6 months post-GA: > 40.

## Decommissioning n8n workflows

After Phase D complete + 30 days stable:

- Archive (rename with `[ARCHIVED]` prefix; deactivate) the migrated `PROD - <name>` workflows.
- Keep V1 (Orig) workflows untouched per CLAUDE.md baseline.
- Hub stays in n8n indefinitely.
- A handful of low-volume workflows stay (Reset Eve Greeting, etc.).

Final state of n8n: hub + ~3-5 small tools. Drastically simplified.

## What this enables

| Capability | Pre-migration | Post-migration |
|---|---|---|
| Daily user ceiling | ~100 (Tier 3 + n8n overhead) | ~1500 (multi-LLM + Python efficiency) |
| Cost at 100 daily users | $145/mo backend | $80/mo backend |
| Cost at 1000 daily users | $1,545/mo | $395/mo |
| Cross-chapter continuity | Not possible | Native |
| B2B revenue stream | Not possible | Yes (~$50-150k/yr at 100 customers) |
| Vendor independence | Locked to n8n | Standard Python |
| Idempotency guarantees | Partial | Full |
| Multi-LLM strategy | Hard | Trivial |

## When this plan would change

- If Sprint 15 testbed reveals Python service can't match n8n quality on rubric → fall back to n8n multi-instance plan ([[design-feasibility]]).
- If Anthropic Tier 4 becomes available + cheap → less urgency on Haiku/multi-LLM; could simplify Phase A.
- If team capacity drops → defer Phase E (B2B); ship internal migration only.
- If a competitor launches a similar B2B API that wins the market → reconsider B2B viability.

But default plan: full execution.

## Cross-system implications

| System | Major change |
|---|---|
| [[chapter-writer-architecture]] | Rewritten to describe Python service; n8n version becomes "legacy reference" |
| [[workflow-tiers]] | Add DEPRECATED status for migrated workflows |
| [[workflow-id-map]] | Annotate which workflows were migrated; archive timestamps |
| [[deployment-railway]] | Add author-agent-{heavy,light,cron} services |
| [[security-model]] | Add API-key auth + tenant isolation |
| [[base-tables]] | New tables (tenants_v2, api_keys_v2, etc.) — all meta tables, governance-compliant |
| [[testing/_index]] | New pytest suite for backend |
| [[ci-pipeline]] | Add Python lint/test/build job |
| [[planned-sprints]] | Sprints 16-26 are this roadmap |
| [[design-feasibility]] | This roadmap supersedes the n8n multi-instance proposal |
| [[microservice-alternative]] | This roadmap supersedes that page |
| [[sprint-15-testbed]] | Testbed integrates Python service as 5th LLM variant |
