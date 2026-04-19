# The Writers Workbench — Sprint Plan v2 (Sprints 10+)

**Version:** 1.0
**Date:** 2026-04-19
**Scope:** Infrastructure scaling, workflow governance, and multi-tenant readiness. Covers Sprints 10–15 plus the pre-existing Sprint 8/9 plans that were drafted but never executed.
**Methodology:** Scrum — 2-week sprints, story points (Fibonacci), Definition of Done includes tests
**Predecessor:** [`sprint_document.md`](sprint_document.md) covers Sprints 0–9 (Sprints 0–7 completed; Sprints 8 and 9 still planned).

> **Why a new document:** the first sprint doc captured the Writers Workbench product build (Sprints 0–7 done, 8–9 planned). The work this document covers is a different concern: **infrastructure scaling, workflow governance, and migrating off single-tenant shortcuts.** Keeping it separate preserves clarity. Sprints 8 and 9 are referenced here for sequencing but their detailed stories live in the original doc.

---

## Cross-cutting decisions

### Workflow governance going forward

Once V2 workflows are in front of real customers, **they become the immutable production baseline** — the same protection rule currently applied to V1. All further development goes on parallel **Dev** workflows. This is the n8n analogue of the `main`/`develop` git model we established in Sprint 10.

| Tier | Purpose | Who uses it | Modification rule |
|------|---------|-------------|------------------|
| **V1 (Orig)** | Historical baseline, original system | No one (inactive) | NEVER modify without explicit user permission |
| **V2 (Prod)** | **Current production** — live users | Production Writer's Workbench at `writers-workbench.up.railway.app` | NEVER modify without explicit user permission once users are on system |
| **Dev** | Active development | Development Writer's Workbench at `writers-workbench-dev.up.railway.app` | Free to modify during sprints |

**Promotion flow** (Dev → Prod), executed on every release:
1. Dev workflow is proven through QA cycles on dev environment
2. Release branch cut from `develop` in git
3. Workflow change applied to the corresponding V2 workflow via n8n API (content copied Dev → V2, keeping V2's workflow ID stable)
4. V2 redeployed: deactivate → PUT → reactivate cycle to rebuild activeVersion
5. Repo workflow JSON updated to match new V2 state

Sprint 10.a below builds this governance. All subsequent sprints MUST do their workflow changes on Dev, not V2.

### Sprint 8 and 9 (carried forward)

These were designed in the original sprint doc but never executed:
- **[Sprint 8](sprint_document.md#sprint-8-multi-tenant-rbac-subscription-tiers--credits-2-weeks):** Multi-Tenant RBAC, Subscription Tiers & Credits (10 stories, 55 pts)
- **[Sprint 9](sprint_document.md#sprint-9-stripe-integration--payment-processing-2-weeks):** Stripe Integration & Payment Processing (9 stories, 47 pts)

They remain planned. Recommended sequencing: **10 (done) → 10.a → 10.b → 11 → 12 → 8 → 9 → 13 → 14 → 15**. Sprints 8 and 9 benefit from the queue (10.b) for billing events and the email infrastructure (Newsletter Agent sprint's S7 + Sprint 11) for payment receipts / trial expiry notifications.

---

## Sprint 10: Production Baseline, Environment Separation & CI/CD

**Status:** ✅ COMPLETE (executed 2026-04-17)
**Points delivered:** 34
**Branch state at close:** `main` = `develop` = `v1.0.0` = `36bb61f` initially; now both at `9be0273` after hotfix PRs #2 and #4 merged

### Completed stories

| Story | Points | Result |
|-------|--------|--------|
| **S10-1** Commit all outstanding work to `develop` | 3 | Commit `193a997` — lazyRetry refactor, migration 007, race tests, Sprint 8/9 planning notes |
| **S10-2** Create `release/v1.0` branch + merge to `main` + tag v1.0.0 | 5 | PR #1 merged as `36bb61f`, tag `v1.0.0` pushed |
| **S10-3** GitHub branch protection rules | 3 | `main` requires PR + `TypeScript & Lint`, `Unit Tests`, `Production Build` checks + `enforce_admins: true`. `develop` blocks force-push and deletion. CONTRIBUTING.md, PR template, CLAUDE.md branching section added |
| **S10-4** Railway dual-environment setup | 13 | Production deploys from `main`, dev deploys from `develop`. Separate Railway services, separate env vars. |
| **S10-5** Hotfix and release process validation | 5 | PR #2 (cover art binary fix) and PR #4 (genre-from-DB fix) successfully executed the hotfix process end-to-end |
| **S10-6** Workflow sync tooling | 5 | Not yet formalized as scripts — workflow fixes in PRs #2, #4 established the manual pattern; scripts to be built in Sprint 10.a |

### Follow-ups filed

- **Issue #3** — E2E test suite fails to render login page in CI. Temporarily removed from required status checks on `main` during PR #2; must be fixed and re-added.
- **S10-6 workflow sync scripts** — manual pattern worked for hotfixes; deferred to Sprint 10.a for automation.

### Infrastructure currently in place

- Production Railway: auto-deploys from `main`
- Development Railway: auto-deploys from `develop`
- `main` and `develop` branches configured on GitHub with protection rules
- CI runs on pushes to both branches and PRs to both branches
- Release workflow auto-generates GitHub Release on `v*.*.*` tag
- PR template enforces type selection and test checklist

---

## Sprint 10.a: Workflow Dev/Prod Separation

**Status:** Planned | **Points:** 13 | **Duration:** 1 week (short sprint) | **Priority:** P0

**Goal:** Establish parallel Dev workflows on n8n so active development never touches the V2 workflows customers depend on. Create a Dev hub webhook. Wire the dev Writer's Workbench to it. Build minimal tooling to promote Dev changes → V2 on release.

**Why now:** The next several sprints (10.b, 11, 12, 13) all make significant changes to the worker and hub workflows. Without separation, any mistake breaks production. This sprint is the workflow analogue of the git dev/main protection we just added.

### Stories

#### S10a-1: Freeze V2 as production baseline (2 pts) | P0

**Developer Tasks:**
- [ ] Update `CLAUDE.md` baseline protection section:
  - Add V2 workflows to the "never modify without permission" list, on par with V1
  - Specifically list the 24 V2 workflow IDs (from the current `workflows/` folder)
  - Add rule: "Development work goes on Dev workflows only. V2 workflows are modified only via the Dev → V2 promotion process (see runbook)."
- [ ] Update `MEMORY.md` — move V2 workflow IDs from "actively developed" to "baseline/frozen"
- [ ] Communicate the change in a `docs/workflow-governance.md` document

**QA Tasks — Unit Tests:** n/a
**QA Tasks — System Tests:** n/a (documentation change)
**QA Tasks — E2E:** n/a

**Definition of Done:**
- [ ] CLAUDE.md updated with V2 freeze rule
- [ ] MEMORY.md updated
- [ ] `docs/workflow-governance.md` committed explaining the model

**Depends on:** nothing

---

#### S10a-2: Clone all V2 workflows to Dev counterparts (5 pts) | P0

**Developer Tasks:**
- [ ] Write script `scripts/clone-v2-to-dev.sh` using n8n API:
  - For each V2 workflow in `workflows/` (24 workflows), fetch from n8n, clone with name suffix ` - Dev` (e.g., `Tool - Write Chapter V2 Dev`)
  - Preserve all node configs, credentials references, connections
  - Dev workflows start deactivated
  - Script is idempotent (skip if `-Dev` version already exists)
  - Capture mapping of V2 ID → Dev ID, write to `scripts/workflow-id-map.json`
- [ ] Run the clone script; verify 24 Dev workflows created
- [ ] Name convention:
  - V1: `AI News Data Ingestion Orig`, `Content - Newsletter Agent` (legacy)
  - V2 (prod): `The Author Agent_V2`, `Tool - Write Chapter V2` (current)
  - Dev: `The Author Agent V2 Dev`, `Tool - Write Chapter V2 Dev` (NEW)
- [ ] Activate all Dev workflows (but they're not reachable until Dev hub exists — S10a-3)

**QA Tasks — System Tests:**
- [ ] Count Dev workflows: exactly 24, matching V2 count
- [ ] Spot-check 3 Dev workflows: node count matches V2 counterpart
- [ ] Script re-run: doesn't create duplicates

**Definition of Done:**
- [ ] 24 Dev workflows created and active on n8n
- [ ] ID map persisted in `scripts/workflow-id-map.json`
- [ ] Script checked into `scripts/clone-v2-to-dev.sh`

**Depends on:** S10a-1

---

#### S10a-3: Create Dev hub + dev webhook (3 pts) | P0

**Developer Tasks:**
- [ ] Clone `The Author Agent_V2` (hub, ID `roMDypuMXHv6ugaZ`) to `The Author Agent V2 Dev`
- [ ] In Dev hub: change every `executeWorkflow` tool definition's workflow ID from the V2 workflow to the corresponding Dev workflow (using the ID map from S10a-2)
- [ ] Change webhook path: `/webhook/author_request_v2` → `/webhook/author_request_dev`
- [ ] Activate Dev hub
- [ ] Verify Dev hub is fully isolated: sending a chat to dev webhook triggers only Dev workflows, never V2

**QA Tasks — System Tests:**
- [ ] Send a test message to `/webhook/author_request_dev` with a simple operation (e.g., "list my projects")
- [ ] Verify the Dev sub_retrieve_content workflow was called (check execution log for Dev workflow ID)
- [ ] Verify NO V2 workflows executed during the test
- [ ] Send identical message to `/webhook/author_request_v2` → verify V2 workflows execute, Dev workflows don't

**Definition of Done:**
- [ ] Dev hub exists, active, wired to Dev tool workflows
- [ ] Dev webhook reachable and responsive
- [ ] Isolation verified — zero cross-tier execution

**Depends on:** S10a-2

---

#### S10a-4: Point dev Writer's Workbench at Dev hub (1 pt) | P0

**Developer Tasks:**
- [ ] Update Railway dev environment env vars on `writers-workbench-dev` service:
  - `VITE_N8N_WEBHOOK_URL=https://n8n.agileadautomation.com/webhook/author_request_dev`
  - `N8N_API_URL` unchanged
- [ ] Trigger dev redeploy
- [ ] Update `.env.example` to show both production and development webhook URLs with clear comments

**QA Tasks — E2E Tests:**
- [ ] From `writers-workbench-dev.up.railway.app`, submit a chat message → request hits `/webhook/author_request_dev` → Dev workflow executes
- [ ] From production URL: same message hits `/webhook/author_request_v2` → V2 workflow executes
- [ ] No cross-environment bleed

**Definition of Done:**
- [ ] Dev URL uses Dev webhook
- [ ] Prod URL uses V2 webhook
- [ ] `.env.example` documents both

**Depends on:** S10a-3

---

#### S10a-5: Promotion tooling (Dev → V2) (3 pts) | P1

**Developer Tasks:**
- [ ] Write `scripts/promote-dev-to-v2.sh`:
  - Takes a workflow name or ID as arg (e.g., `Tool - Write Chapter V2`)
  - Fetches corresponding Dev version
  - Applies Dev's nodes and connections to V2 (deactivate → PUT → activate cycle to rebuild activeVersion)
  - V2 workflow ID stays stable (hub references don't change)
  - Preserves V2's metadata (tags, owner, etc.)
  - Dry-run flag shows what would change without applying
  - Writes a promotion record to `workflows/promotion-log.md` with date, workflow, git SHA
- [ ] Write companion `scripts/diff-dev-vs-v2.sh` — shows node-level diff between Dev and V2 for a given workflow (useful pre-promotion check)
- [ ] Document promotion process in `docs/workflow-governance.md`:
  - When to promote (after PR merges to main)
  - How to handle credentials that differ between Dev and V2
  - How to roll back a bad promotion (V2's previous activeVersion snapshot)
  - Who approves promotion (reference the release PR reviewer)

**QA Tasks — Unit Tests:**
- [ ] Dry-run on an identical Dev/V2 pair → reports "no changes"
- [ ] Dry-run on a Dev workflow with a modified Code node → reports the specific node diff
- [ ] Script aborts with clear error if V2 workflow doesn't exist
- [ ] Script aborts with clear error if Dev workflow doesn't exist

**QA Tasks — System Tests:**
- [ ] Make a trivial change to `Tool - Retrieve Content V2 Dev` (add a comment to a Code node)
- [ ] Run dry-run → see the change
- [ ] Run promotion → V2 workflow updated, executions test-successful afterwards
- [ ] Spot-check V2 workflow ID unchanged — hub references still work
- [ ] `promotion-log.md` has an entry

**Definition of Done:**
- [ ] Both scripts working and documented
- [ ] Governance document committed
- [ ] One practice-promotion executed and logged

**Depends on:** S10a-2, S10a-4

---

### Sprint 10.a totals: 13 pts

### Dependencies
- S10a-1 → all others (rule change)
- S10a-2 → S10a-3, S10a-5
- S10a-3 → S10a-4
- S10a-4 → (unblocks all subsequent sprints' dev work)
- S10a-5 → (enables promotion for all subsequent sprints)

---

## Sprint 10.b: Redis + BullMQ Job Queue Foundation

**Status:** Planned | **Points:** 34 | **Duration:** 2 weeks | **Priority:** P0

**Goal:** Stand up Redis on Railway, add BullMQ to the Express server, migrate async operations from direct n8n webhook calls to queued jobs. This sets the foundation for horizontal scaling and makes long-running writes reliable.

**Why now:** Chapter writes currently take 10–20 minutes and tie up n8n execution slots. Without a proper queue, concurrent users get queued behind each other inside n8n with no visibility or recovery. BullMQ gives us observability, retries, per-user concurrency limits, and the ability to run multiple workers later.

### Stories

#### S10b-1: Deploy Redis + BullMQ library integration (5 pts) | P0

**Developer Tasks (all on Dev workflows only — per S10a rule):**
- [ ] Add Railway Redis service to `writers-workbench` project (redis:7-alpine, 256 MB, 1 GB volume)
- [ ] Add `REDIS_URL` (uses Railway's `REDIS_PRIVATE_URL` on prod) to `.env.example` and Railway env
- [ ] Install `bullmq` + `ioredis` in `server/package.json`
- [ ] Create `server/src/lib/redis.ts` — lazy-initialized IORedis connection with reconnect strategy, graceful shutdown
- [ ] Create `server/src/lib/queue.ts` — BullMQ Queue factory, default job options (attempts: 3, exponential backoff), queue registry
- [ ] Add Redis check to `/api/health` (`checks.redis: ok/error/skipped`)
- [ ] Update `server/src/index.ts` shutdown handler: close Redis + drain queues before exit

**QA Tasks — Unit Tests (server/src/test/queue.test.ts):**
- [ ] `createRedisConnection()` returns IORedis instance (mock ioredis)
- [ ] `createQueue('test')` returns BullMQ Queue with correct default options
- [ ] Queue factory reuses connection (singleton)
- [ ] Health endpoint reports `checks.redis: ok` when connected (mock)
- [ ] Health endpoint reports `checks.redis: error` when connection fails
- [ ] Graceful shutdown calls `queue.close()` and `redis.quit()`

**QA Tasks — System Tests:**
- [ ] Redis reachable from Express via Railway internal DNS
- [ ] BullMQ enqueue and dequeue a test job (`{type: 'ping'}`)
- [ ] Job persists across Express restart
- [ ] Auto-reconnect within 30s after Redis restart

**Definition of Done:**
- [ ] Redis service running on Railway
- [ ] Redis connection + Queue factory tested
- [ ] Health check reports Redis status

**Depends on:** Sprint 10.a complete

---

#### S10b-2: Job queue schema + priority system (8 pts) | P0

**Developer Tasks:**
- [ ] Define job types in `server/src/lib/jobs/types.ts`:
  - `ChatJob`, `EmailJob`, `N8nWebhookJob`, `BackgroundJob` base types
  - Priority levels: `sync` | `medium` | `heavy` | `background`
- [ ] Create 4 named queues in `server/src/lib/queue.ts`:
  - `sync-ops` — retrieve, list, manage_library lookups (concurrency 10, timeout 30s)
  - `medium-ops` — brainstorm, blog, newsletter, social, edit outline (concurrency 4, timeout 120s)
  - `heavy-ops` — write_chapter, write_short_story, QA (concurrency 2, timeout 1200s)
  - `background-ops` — embed, token_track, cover_art, kindle, email sends (concurrency 3, timeout 300s)
- [ ] Create `server/src/lib/jobs/classifier.ts` — classifies incoming chat messages to the right queue (mirrors the hub's `preprocess_message` logic)
- [ ] Create `server/src/lib/jobs/n8n-worker.ts` — BullMQ Worker processes `N8nWebhookJob` by fetching the n8n Dev webhook
- [ ] Migration `migrations/008_job_queue.sql`:
  ```sql
  CREATE TABLE job_queue_v2 (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users_v2(user_id),
    job_id TEXT NOT NULL,
    queue_name TEXT NOT NULL,
    job_type TEXT NOT NULL,
    status TEXT DEFAULT 'waiting',
    priority INTEGER DEFAULT 3,
    payload JSONB,
    result JSONB,
    error_message TEXT,
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER
  );
  CREATE INDEX idx_job_queue_user ON job_queue_v2(user_id, status);
  CREATE INDEX idx_job_queue_status ON job_queue_v2(status, created_at);
  ```
- [ ] Job tracker in `server/src/lib/jobs/job-tracker.ts` — updates `job_queue_v2` on BullMQ lifecycle events

**QA Tasks — Unit Tests:**
- [ ] `classifyJob("list my projects")` → `{queue: 'sync-ops', priority: 1}`
- [ ] `classifyJob("write chapter 3")` → `{queue: 'heavy-ops', priority: 5}`
- [ ] `classifyJob("brainstorm a story")` → `{queue: 'medium-ops', priority: 2}`
- [ ] n8n-worker calls correct Dev webhook with correct payload (mock fetch)
- [ ] n8n-worker retries on 502 (BullMQ retry config)
- [ ] n8n-worker stores result on success
- [ ] Job tracker writes correct statuses at each lifecycle event
- [ ] `duration_ms` recorded correctly

**QA Tasks — System Tests:**
- [ ] Sync job processes within 5s
- [ ] 3rd heavy job waits when concurrency is 2
- [ ] Failed job retries 3× with exponential backoff
- [ ] `job_queue_v2` has correct records after full lifecycle
- [ ] Two users submitting simultaneously get independent job IDs

**Definition of Done:**
- [ ] 4 queues operational
- [ ] Classifier tested for all operation types
- [ ] Migration applied, `job_queue_v2` populated on runs
- [ ] All unit + system tests pass

**Depends on:** S10b-1

---

#### S10b-3: Migrate chat proxy to queue-based dispatch (8 pts) | P0

**Developer Tasks:**
- [ ] Refactor `server/src/routes/chat.ts`:
  - Sync ops: still call n8n Dev webhook directly (via fetch), return immediately
  - Async ops: enqueue to BullMQ, return `{ jobId, status: 'queued' }`
- [ ] Create `server/src/routes/jobs.ts`:
  - `GET /api/jobs` — list user's recent jobs (requires auth)
  - `GET /api/jobs/:id` — single job detail
  - `GET /api/jobs/:id/status` — lightweight status poll
  - `DELETE /api/jobs/:id` — cancel waiting job
  - `GET /api/jobs/stats` — user queue stats
- [ ] Update SSE push in `session.ts`: when n8n-worker job completes, push `job-completed` event
- [ ] Update `client/src/components/chat/ChatDrawer.tsx`:
  - Async submit shows "Queued" → "Processing" → "Complete"
  - Active job IDs in localStorage
  - Poll or listen via SSE

**QA Tasks — Unit Tests:**
- [ ] Sync message ("list my projects") → calls n8n directly
- [ ] Async message ("write chapter 3") → returns `{jobId}`
- [ ] GET `/api/jobs` returns only authenticated user's jobs
- [ ] GET `/api/jobs/:id` returns 404 for another user's job
- [ ] SSE fires `job-completed` when worker finishes
- [ ] Chat drawer shows "Queued" badge after async submit

**QA Tasks — E2E Tests:**
- [ ] Login → chat "list my projects" → response in <10s (sync)
- [ ] Login → chat "write a blog post" → "Queued" → eventually "Complete"
- [ ] /jobs page shows recent jobs with status
- [ ] Two tabs same user: async job in tab 1 → SSE notification in tab 2
- [ ] Submit async → close drawer → reopen → job still visible

**Definition of Done:**
- [ ] All new routes working with auth
- [ ] Chat drawer updated
- [ ] Unit + E2E tests pass

**Depends on:** S10b-2

---

#### S10b-4: Per-user concurrency + admin queue dashboard (5 pts) | P1

**Developer Tasks:**
- [ ] Per-user concurrency enforcement in `n8n-worker.ts`:
  - Max 1 heavy job per user concurrent
  - Max 3 total active jobs per user
  - Excess stays in `waiting` state
- [ ] Admin queue dashboard: `GET /api/admin/queues` returns queue depths, worker status, live stats
- [ ] Admin UI Queues tab — auto-refresh 10s
- [ ] OpenAPI annotations on all job endpoints

**QA Tasks — Unit Tests:**
- [ ] User with 1 active heavy → 2nd heavy stays waiting
- [ ] User with 3 active → 4th stays waiting
- [ ] First heavy finishes → waiting heavy starts automatically
- [ ] Admin endpoint returns 403 for non-admin
- [ ] Admin endpoint returns queue depths

**QA Tasks — E2E Tests:**
- [ ] Submit 2 chapter writes rapidly → 2nd shows "Queued (waiting)"
- [ ] Cancel waiting job from chat drawer → disappears, toast shown
- [ ] Admin → Queues tab shows live stats

**Definition of Done:**
- [ ] Concurrency limits enforced
- [ ] Admin dashboard functional
- [ ] Tests pass

**Depends on:** S10b-3

---

#### S10b-5: Session store migration to Redis (8 pts) | P0

**Developer Tasks:**
- [ ] Refactor `server/src/routes/session.ts`:
  - Replace `activeSessions = new Map()` with Redis hash `sessions:{userId}` (TTL 30 min)
  - Replace `sseClients[]` with Redis pub/sub channel `sse:{userId}`
  - All endpoints updated accordingly
- [ ] This enables multiple Express instances to share session state (prep for horizontal scaling)
- [ ] Fallback to in-memory if `REDIS_URL` unset (development mode)
- [ ] Health check reports active sessions count

**QA Tasks — Unit Tests:**
- [ ] `register` sets Redis hash with 1800s TTL
- [ ] `unregister` deletes Redis key
- [ ] `active` check returns correct status
- [ ] `active` returns false after TTL expiry
- [ ] `content-ready` publishes to correct channel
- [ ] SSE subscribes to correct channel and forwards events
- [ ] Fallback to in-memory works
- [ ] Health check shows session count from Redis

**QA Tasks — System Tests:**
- [ ] Register on Express instance A → check from instance B (shared Redis)
- [ ] Publish content-ready from worker → SSE client receives within 2s
- [ ] Session expires after 30 min inactivity
- [ ] Multiple SSE clients same user all receive event

**QA Tasks — E2E Tests:**
- [ ] Open Eve widget → session registers
- [ ] Close Eve widget → session unregisters
- [ ] Content callback → toast appears in UI < 5s

**Definition of Done:**
- [ ] Redis-backed session store working
- [ ] Fallback to memory for local dev
- [ ] All tests pass

**Depends on:** S10b-1

---

### Sprint 10.b totals: 34 pts

---

## Sprint 11: Postal Email Migration Completion

**Status:** Planned | **Points:** 21 | **Duration:** 1.5 weeks | **Priority:** P1
**Prerequisite:** Newsletter Agent Migration sprint S7 must be complete (Postal installed + configured)

**Goal:** The Newsletter Agent Migration sprint installs Postal and migrates newsletter flows. This sprint **retires Gmail OAuth entirely** by migrating the other 15 V2 workflows (blog, chapter, short story, brainstorm, etc.) to the shared `/api/email/send` → Postal path. Also adds bounce/complaint handling, FBL configuration, and per-user email rate limiting backed by Redis.

### Stories

#### S11-1: Migrate writing-tool workflows (blog, chapter, short story, newsletter existing, brainstorm) (5 pts) | P0

**Developer Tasks (on Dev workflows):**
- [ ] For each of the 5 workflows, replace Gmail node with HTTP Request to `/api/email/send`:
  - `Tool - Write Blog Post V2 Dev`
  - `Tool - Write Chapter V2 Dev` (the chapter worker 11b sends final email)
  - `Tool - Write Short Story V2 Dev`
  - `Tool - Write Newsletter V2 Dev`
  - `Tool - Brainstorm Story V2 Dev`
  - `Tool - Brainstorm Chapter V2 Dev`
- [ ] Preserve all email templates (convert Gmail node config → `/api/email/send` body JSON)
- [ ] Preserve BCC and attachment behavior
- [ ] Test each on dev environment

**QA Tasks — System Tests:**
- [ ] Each of 6 workflows sends via Postal on dev run
- [ ] All arrive at test recipient with correct sender (`eve@courseworx.media`) and SPF/DKIM/DMARC passing
- [ ] Attachments (chapter .md, short story .md) intact

**Definition of Done:**
- [ ] 6 Dev workflows migrated
- [ ] All dev-environment test runs succeed via Postal
- [ ] No Gmail credential in Dev versions of these 6 workflows
- [ ] Promotion to V2 after sprint close

**Depends on:** Newsletter Agent Migration sprint S7

---

#### S11-2: Migrate utility/management workflows (QA, edit_outline, manage_library, scheduled_publisher, manage_research_reports, error_notifier) (5 pts) | P0

**Developer Tasks:**
- [ ] Migrate each to `/api/email/send`:
  - `Tool - QA Chapter V2 Dev`
  - `Tool - Edit Outline V2 Dev`
  - `Sub - Manage Library V2 Dev`
  - `Cron - Scheduled Publisher V2 Dev`
  - `Sub - Manage Research Reports V2 Dev`
  - `Error Notifier - Write Chapter V2 Dev`

**QA Tasks — System Tests:**
- [ ] Each workflow sends via Postal on dev
- [ ] Error notifier: simulate chapter failure → error email arrives via Postal

**Definition of Done:**
- [ ] 6 Dev workflows migrated
- [ ] All via Postal

**Depends on:** S11-1

---

#### S11-3: Migrate image/social/Kindle workflows (generate_cover_art, repurpose_social_posts, format_kindle_book, email_research_report) (3 pts) | P1

**Developer Tasks:**
- [ ] Migrate each:
  - `Tool - Generate Cover Art V2 Dev` (final email with image attachment)
  - `Tool - Repurpose to Social Posts V2 Dev`
  - `Tool - Format Kindle Book V2 Dev`
  - `Tool - Email Research Report V2 Dev`
- [ ] Image attachment path: base64 in `/api/email/send` body

**QA Tasks — System Tests:**
- [ ] Cover art workflow → email with inline image arrives
- [ ] Social posts → email arrives
- [ ] Kindle manuscript → email with .docx arrives
- [ ] Research report → email arrives

**Definition of Done:**
- [ ] 4 Dev workflows migrated
- [ ] All tests pass

**Depends on:** S11-1

---

#### S11-4: Redis-backed email rate limiting (3 pts) | P1

**Developer Tasks:**
- [ ] Upgrade `/api/email/send` rate limiter from in-memory to Redis-backed (per-user, per-minute sliding window)
- [ ] Default: 30 emails/min/user (existing limit); admin-overridable per user
- [ ] Error response: 429 with `Retry-After` header

**QA Tasks — Unit Tests:**
- [ ] 31st email in 1 min → 429
- [ ] Rate limit resets after window
- [ ] Counter shared across Express instances (via Redis)

**Definition of Done:**
- [ ] Rate limit enforced reliably across multiple Express replicas
- [ ] Tests pass

**Depends on:** Sprint 10.b (needs Redis)

---

#### S11-5: Bounce + complaint webhook handling (5 pts) | P1

**Developer Tasks:**
- [ ] Configure Postal to send bounce + complaint webhooks to `/api/email/webhook/postal`
- [ ] Implement endpoint: validates webhook signature, updates relevant `newsletter_sends_v2` rows or logs to `email_bounces_v2` table (new)
- [ ] Migration `migrations/010_email_bounces.sql`:
  ```sql
  CREATE TABLE email_bounces_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id TEXT NOT NULL,
    to_address TEXT NOT NULL,
    bounce_type TEXT NOT NULL,
    bounce_reason TEXT,
    timestamp TIMESTAMPTZ DEFAULT now()
  );
  ```
- [ ] Admin dashboard: show recent bounces / complaints

**QA Tasks — System Tests:**
- [ ] Send to an invalid address (e.g., `bounce@simulator.amazonses.com`) → bounce webhook fires → row in `email_bounces_v2`

**Definition of Done:**
- [ ] Bounces captured automatically
- [ ] Admin visibility
- [ ] Tests pass

**Depends on:** Newsletter Agent sprint S7 (needs Postal up)

---

### Sprint 11 totals: 21 pts

---

## Sprint 12: Chapter Writer Parallelization

**Status:** Planned | **Points:** 34 | **Duration:** 2 weeks | **Priority:** P0

**Goal:** The chapter writer currently takes 10–20 minutes because of a 120-second rate delay between sub-chapters, plus strictly sequential LLM calls. This sprint removes the delay, adds a pre-computed context document, and fans out sub-chapter writes in parallel with a final merge/continuity pass. Target: chapter write time drops to 3–5 minutes.

**Why now:** Immediately unlocks 3× throughput for the most painful user-facing operation. Gates scaling — without this, 10 concurrent chapter writes starve all other operations.

### Stories (summary — full detail in first chat-based plan)

- **S12-1 (3 pts):** Remove 120s rate_limit_delay from chapter worker, add timing instrumentation
- **S12-2 (8 pts):** Context document generator — new sub-workflow that synthesizes character state, plot threads, voice samples from previous chapters
- **S12-3 (13 pts):** Parallel sub-chapter fan-out — rewrite worker to batch-execute all sub-chapters simultaneously using context doc
- **S12-4 (5 pts):** Continuity merge pass — Claude call smooths transitions between parallel sub-chapters
- **S12-5 (5 pts):** Timing telemetry + performance dashboard in admin panel

**Depends on:** Sprint 10.a (do all work on Dev worker, then promote)

---

## Sprint 13: n8n Queue Mode + DB Migration Preparation

**Status:** Planned | **Points:** 34 | **Duration:** 2 weeks | **Priority:** P1

**Goal:** Today's single n8n instance is a bottleneck and single point of failure. This sprint externalizes credentials, runs n8n in queue mode with shared Postgres + Redis, deploys multiple worker processes. Also preps the path for eventually migrating off Supabase to Railway-managed Postgres (still optional — Supabase remains fine at current scale).

### Stories (summary)

- **S13-1 (8 pts):** Externalize all n8n workflow credentials to env vars (remove hardcoded Supabase URLs, API keys, Anthropic/Perplexity/OpenAI credentials from Code nodes — use n8n credential system or `$env.*`)
- **S13-2 (13 pts):** n8n queue mode deployment — shared Postgres for execution data, Redis for queue, 2+ worker processes on Railway
- **S13-3 (8 pts):** Optional: Railway Postgres for Writers Workbench (separate from Supabase) — start with PgBouncer + pgvector image; keep Supabase for now. Prove the path; full cutover is Sprint 14 or later if needed.
- **S13-4 (5 pts):** Deploy GoTrue (if Supabase cutover proceeds) — self-hosted auth that matches Supabase JWT format

**Depends on:** Sprint 10.b (Redis infra), Sprint 10.a (Dev workflow isolation)

---

## Sprint 14: Cloudflare R2 Storage Migration

**Status:** Planned | **Points:** 34 | **Duration:** 2 weeks | **Priority:** P2

**Goal:** Move blob storage from Supabase Storage to Cloudflare R2 (zero egress fees, more control). Supabase stays for Postgres data; only the blobs move.

### Stories (summary)

- **S14-1 (5 pts):** R2 bucket provisioning + S3-compatible client setup
- **S14-2 (8 pts):** Storage service + migration script (S3-compatible client, bulk migration from Supabase Storage → R2)
- **S14-3 (8 pts):** Update n8n workflows (Dev) to read/write R2 instead of Supabase Storage
- **S14-4 (5 pts):** Frontend storage URL migration (image components)
- **S14-5 (8 pts):** Supabase cutover + verification + rollback plan

**Depends on:** Sprint 10.a

---

## Sprint 15: Load Test + Monitoring + Hardening

**Status:** Planned | **Points:** 34 | **Duration:** 2 weeks | **Priority:** P1

**Goal:** Validate the full stack under 2–10 concurrent user load (prototype scale). Add monitoring, alerting, and operational dashboards. Harden for production.

### Stories (summary)

- **S15-1 (8 pts):** Load test harness (k6 or Playwright-based scenarios: concurrent sync, brainstorms, chapter writes, mixed workload, queue saturation, email burst)
- **S15-2 (8 pts):** Monitoring + health dashboard (per-service health cards, queue depth charts, live active jobs, email delivery log, Prometheus-compatible metrics)
- **S15-3 (8 pts):** Alerting + error recovery (queue depth > 10, failure rate > 20%, Redis/Postgres/n8n down, dead-letter queue management, circuit breakers for Claude/Perplexity)
- **S15-4 (5 pts):** Documentation + operational runbook
- **S15-5 (5 pts):** Final regression + sign-off (~575 total tests passing: 250+ client unit, 200+ server unit, 100+ E2E, 6 load scenarios)

**Depends on:** Sprints 10.a, 10.b, 11, 12

---

## Sprint sequencing at a glance

```
Completed: 10 ✓

Next (ordered):
  10.a ────▶ 10.b ───┬──▶ 11 ──┐
                     │         │
                     └─▶ 12 ───┤
                               │
                               ├──▶ 8 ──▶ 9 ──▶ 13 ──▶ 14 ──▶ 15
                               │
                               └─(option to skip 13/14 until pain justifies)
```

**Recommended order:** 10.a → 10.b → 11 → 12 → 8 → 9 → 13 → 14 → 15

**Alternative (product-features-first):** 10.a → 8 → 9 → 10.b → 11 → 12 → 13 → 14 → 15 — if customer demand for multi-tenancy + billing outweighs the need for scaling infrastructure

---

## Total

| Sprint | Status | Points |
|--------|--------|--------|
| 10 | ✅ complete | 34 |
| 10.a | planned | 13 |
| 10.b | planned | 34 |
| 8 | planned (carried) | 55 |
| 9 | planned (carried) | 47 |
| 11 | planned | 21 |
| 12 | planned | 34 |
| 13 | planned | 34 |
| 14 | planned | 34 |
| 15 | planned | 34 |
| **Total remaining** | | **306 pts** |

At 34 pts/sprint (2-week cadence), that's **~18 weeks (9 sprints) of work** to complete all planned infrastructure and feature work. Product-facing sprints (8, 9) can run in parallel with infrastructure sprints since they touch different layers.

---

## Out of scope (future sprint documents)

- **Newsletter Agent calendar-driven release** — companion to the Newsletter Agent Migration sprint; releases `status='scheduled'` newsletters on their `scheduled_send_at`
- **CRM integration** (GoHighLevel or other) — revisit once product is established
- **Multi-region deployment**
- **Web UI for subscriber management**
- **Analytics dashboard** (opens, clicks, unsubscribes, content performance)
- **API for external integrations** (public REST API with API key auth)
