# The Writers Workbench — Sprint Plan v2 (Sprints 10+)

**Version:** 1.1
**Date:** 2026-04-20
**Scope:** Infrastructure scaling, workflow governance, and multi-tenant readiness. Covers Sprints 10–15 plus the pre-existing Sprint 8/9 plans that were drafted but never executed.
**Methodology:** Scrum — 2-week sprints, story points (Fibonacci), Definition of Done includes tests
**Predecessor:** [`sprint_document.md`](sprint_document.md) covers Sprints 0–9 (Sprints 0–7 completed; Sprints 8 and 9 still planned).

> **Why a new document:** the first sprint doc captured the Writers Workbench product build (Sprints 0–7 done, 8–9 planned). The work this document covers is a different concern: **infrastructure scaling, workflow governance, and migrating off single-tenant shortcuts.** Keeping it separate preserves clarity. Sprints 8 and 9 are referenced here for sequencing but their detailed stories live in the original doc.

### Testing infrastructure inherited from Sprints 0–7

All sprints in this document assume the testing stack set up in Sprint 0 is operational: **Vitest** (client + server unit tests, ~330 passing), **Playwright** (E2E, chromium-noauth + chromium-authenticated projects), **GitHub Actions CI** (TypeScript, Unit Tests, Production Build required; E2E present but not required on `main` pending Issue #3 fix), **Railway auto-deploy** from `main` (prod) and `develop` (dev). See [`sprint_document.md`](sprint_document.md) Sprint 0 for details. Every story's QA section adds tests on top of this baseline.

### Revision history

- **1.0** (2026-04-19) — Initial v2 doc covering Sprints 10 (done), 10.a (13 pts), 10.b–15 planned.
- **1.1** (2026-04-20) — Sprint 10.a expanded to 49 pts (added S10a-0 CI/CD verification prerequisite). Sprint 12 expanded to 57 pts (added S12-0 Eve max-iterations hotfix + composite rewrite tool). Sprint 13 refreshed from queue-mode architecture → independent standalone instances with Workbench-side routing. S10-5 and S10-6 marked retroactively complete (validated via PRs #2 and #4, and consolidated into Sprint 10.a promotion tooling respectively).

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
| **S10-5** Hotfix and release process validation | 5 | ✅ VALIDATED via PR #2 (cover art binary fix) and PR #4 (genre-from-DB fix) — both hotfix branches cut from `main`, merged through the protected-branch process, cherry-picked/merged to `develop`. Process proven end-to-end with real bugs. |
| **S10-6** Workflow sync tooling | 5 | ✅ CONSOLIDATED into Sprint 10.a — the `scripts/promote-dev-to-v2.sh` and `scripts/diff-dev-vs-v2.sh` (S10a-10) cover the workflow sync / drift-detection story. Manual sync via MCP tools worked for PRs #2 and #4; automated scripts arrive with 10.a. |

### Follow-ups filed

- **Issue #3** — E2E test suite fails to render login page in CI. Temporarily removed from required status checks on `main` during PR #2; must be fixed and re-added.
- **CI/CD pipeline end-to-end verification** — addressed by new prerequisite story **S10a-0** in Sprint 10.a (confirm dev Railway auto-deploy works, add deploy markers to /api/health).

### Infrastructure currently in place

- Production Railway: auto-deploys from `main`
- Development Railway: auto-deploys from `develop`
- `main` and `develop` branches configured on GitHub with protection rules
- CI runs on pushes to both branches and PRs to both branches
- Release workflow auto-generates GitHub Release on `v*.*.*` tag
- PR template enforces type selection and test checklist

---

## Sprint 10.a: Full Tier Separation — DB, Workflows, Agent

**Status:** In progress (S10a-1 done 2026-04-19) | **Points:** 49 | **Duration:** ~3 weeks | **Priority:** P0

**Goal:** Establish a three-tier architecture (V1 baseline / V2 production / Dev) across every layer customers touch: Supabase database, n8n workflows, ElevenLabs Eve agent. Cement the coding discipline that makes this sustainable: base tables are immutable; all schema extensions go in meta tables.

**Why now:** The V2 workflows have their first real user. Any sprint that changes a workflow, schema, or agent going forward risks breaking that user's production without this isolation. This sprint is the analogue, across all production-facing layers, of the git `main`/`develop` protection from Sprint 10.

### Scope expansion (rev 2, 2026-04-19)

Originally scoped as 13 pts for workflow branching only. User direction expanded to cover:
1. DB cutover — current "Writers Assistant V2" Supabase renamed to V1 (frozen baseline); new V2 Supabase created as a clone; production Workbench cut over to new V2
2. Schema governance rule — **base tables are frozen; extensions go in meta tables** (CI-enforced)
3. Full blue-green DB deployment pattern (each release cycle creates a new prod DB)
4. Dev Supabase as 3rd tier, refreshed on each release cycle
5. Eve agent duplicated for Dev tier

### Coding guideline (MANDATORY, established in this sprint)

**Base tables** (7 core entities carried from V1):
`users_v2`, `writing_projects_v2`, `published_content_v2`, `story_bible_v2`, `research_reports_v2`, `genre_config_v2`, `story_arcs_v2`

**Rules:**
1. NEVER add, rename, or drop a column on a base table
2. NEVER add or change a CHECK / UNIQUE / FK constraint on a base table
3. NEVER rename or drop a base table
4. NEVER drop an RLS policy defined in migrations 001–007
5. If a feature needs an attribute on a base entity, create a new **meta table** with an FK back to the base entity's primary key
6. Meta tables belong to migrations 008+; they may be altered, dropped, or evolved freely

Full spec: `writers-workbench/docs/schema-governance.md` (created in S10a-5).

### Release cycle (how schema changes reach production going forward)

At any point in time, exactly **three tiers** exist:
- **V1** (frozen baseline — no writes)
- **V2** (current production — active user writes)
- **Dev** (development — active feature work on meta tables only)

At release time, **Dev DB is promoted to become the new V2**. Critically: before the promotion, **the latest user data from current V2 is synced into Dev** so nothing a user wrote between the last Dev-refresh and the cutover gets lost. Meta tables from Dev stay (they're the new feature); base data gets overwritten with current prod's latest.

```
Start of release (t-0):
  V1 (old baseline — about to be archived)
  V2 (current production — users still writing)
  Dev (has new meta tables + stale base data)

Pre-cutover sync (t-1):
  Pause V2 writes briefly (reviewer + any active user sessions)
  pg_dump --data-only of V2's 7 base tables
  pg_restore those base tables into Dev (overwriting Dev's stale base data)
  Dev now has: LATEST V2 base data + NEW meta tables
  Storage delta sync V2 → Dev (only objects new since last sync)

Promotion (t-2, ~30 seconds of downtime):
  Flip Railway prod env vars:
    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_URL /
    VITE_SUPABASE_ANON_KEY → Dev's values
  Flip n8n V2 workflow Supabase URLs/keys → Dev's values
  Rename Supabase project labels:
    - old V1 → archive (delete after 60d retention)
    - old V2 → "Writers Assistant V1" (frozen baseline)
    - Dev → "Writers Assistant V2" (new production)
  Users see brief reload; re-login (auth JWTs are per-project).

Post-cutover (t-3):
  Create new Dev project from scratch
  Clone base tables + storage from new V2 → new Dev
  Meta tables migrate forward as sprint work happens
```

**Key invariants:**
- User data is NEVER destroyed at cutover — the base-data sync in pre-cutover ensures Dev has current data before it takes over the prod role
- Base table schema is identical across V1, V2, Dev at all times (enforced by S10a-5 CI check)
- Meta tables in Dev are what carries new features forward

**Cost:** ~$25/mo per Supabase Pro project. Steady state = 3 active + up to 1 in 60-day retention = ~$75–100/mo for DB tier.

**Why not just additive migrations?** This approach gives us atomic rollback — if the new V2 has any problem, revert the env vars to the old V2 (still intact, just renamed). No ALTER TABLE to unwind. The immutable-base-tables rule + promote-Dev-to-V2 pattern is the tightest possible safety net for a customer-facing DB.

### Stories

#### S10a-0: CI/CD end-to-end verification + deploy markers (2 pts) | P0 | PREREQUISITE

Verify both the production (`main` → `writers-workbench.up.railway.app`) and development (`develop` → `writers-workbench-dev.up.railway.app`) CI/CD pipelines are working end-to-end before executing the DB cutover and workflow splits. Sprint 10's S10-4 configured both environments, but the dev pipeline was never exercised with a real push-and-observe. Any broken auto-deploy, missing env var, or stale config needs to be caught here — Sprint 10.a's subsequent stories depend on dev being reliably deployable.

**Developer Tasks:**

**Part A — add deploy markers to `/api/health`:**
- [ ] Update `writers-workbench/server/src/routes/health.ts` to include:
  ```json
  {
    "status": "ok",
    "service": "writers-workbench",
    "environment": "production|development",
    "version": "<git sha at build time>",
    "deployed_at": "<build timestamp>",
    "timestamp": "<request time>",
    "checks": { "supabase": "ok|error|skipped" }
  }
  ```
- [ ] In `writers-workbench/Dockerfile`, capture the git SHA and build timestamp as build args → expose as env vars in the final stage:
  ```dockerfile
  ARG GIT_SHA=unknown
  ARG BUILD_TIMESTAMP=unknown
  ENV GIT_SHA=${GIT_SHA}
  ENV DEPLOY_TIMESTAMP=${BUILD_TIMESTAMP}
  ```
- [ ] Railway auto-injects `RAILWAY_GIT_COMMIT_SHA` and `RAILWAY_DEPLOYMENT_ID` into deployed services — health endpoint should read those as fallback if `GIT_SHA` isn't set

**Part B — verify develop → dev Railway:**
- [ ] Merge `feature/sprint-10a-workflow-separation` to `develop` via PR (closes out the 10-commit feature branch sitting there, which needs to land)
- [ ] Watch PR CI runs on `develop` — TypeScript + Unit Tests + Production Build should all pass
- [ ] After merge, within 5 minutes visit `https://writers-workbench-dev.up.railway.app/api/health` → confirm `environment: "development"` and `version` matches the latest develop commit SHA
- [ ] If auto-deploy isn't working: check Railway dashboard → `writers-workbench-dev` service → Settings → Source → verify branch is set to `develop` and auto-deploy is enabled

**Part C — verify main → prod Railway (via release PR):**
- [ ] Cut release branch: `git checkout -b release/v1.0.1 develop`
- [ ] Push + open PR to `main`, title "Release v1.0.1 — deploy markers + Sprint 10.a start"
- [ ] Watch CI pass (TypeScript, Unit Tests, Production Build — all required)
- [ ] Merge PR with merge commit
- [ ] Tag `v1.0.1` on main, push tag
- [ ] Within 5 minutes visit `https://writers-workbench.up.railway.app/api/health` → confirm `environment: "production"` and `version` matches the main SHA at merge time
- [ ] Verify the release workflow created a GitHub Release for tag `v1.0.1`
- [ ] Merge main back to develop

**Part D — fix anything that's broken:**
- [ ] If dev auto-deploy failed: diagnose and fix (env vars, branch config, webhook hooks)
- [ ] If main pipeline had surprises: document for future sprints
- [ ] Report final pipeline state

**QA Tasks:**
- Unit Tests: `/api/health` endpoint returns the new fields (add test)
- System Tests: both URLs (`writers-workbench.up.railway.app/api/health` and `writers-workbench-dev.up.railway.app/api/health`) return fresh deploy info
- E2E Tests: not applicable (infra verification)

**Definition of Done:**
- [ ] Deploy markers visible in both prod and dev health responses
- [ ] Both auto-deploy pipelines confirmed working with fresh SHAs post-merge
- [ ] `v1.0.1` tag released on main
- [ ] Develop and main in sync after release flow
- [ ] Any pipeline issues documented or fixed

**Depends on:** nothing — runs first in this sprint

---

#### S10a-1: Freeze V2 as production baseline (2 pts) | P0 | ✅ COMPLETE

**Result:** CLAUDE.md updated with three-tier baseline protection; `writers-workbench/docs/workflow-governance.md` committed. Commit `cb96b03` on `feature/sprint-10a-workflow-separation`.

---

#### S10a-2: Clone Writers Assistant V1 → V2 Supabase (data) (8 pts) | P0

The current V2 Supabase (`faklxfakgzkpkbxfihzh`) has been renamed to **Writers Assistant V1** in the dashboard — this makes it the frozen baseline. A new empty Writers Assistant V2 project is created, and we clone V1's schema + data into it. Production Workbench stays pointing at V1 until S10a-4 cutover.

**Developer Tasks:**

**Part A — new V2 Supabase project**
- [ ] Create Supabase project "Writers Assistant V2" in the same org
- [ ] Capture new V2 project URL, anon key, service role key, JWT secret
- [ ] Enable `pgvector`, `uuid-ossp` extensions on V2
- [ ] Store credentials in Railway + update `.env.example`

**Part B — schema clone**
- [ ] Run all existing migrations (001–007 + anything merged from Newsletter sprint) against V2 in order
- [ ] Script `scripts/clone-supabase-schema.sh` handles this: reads migration files, applies to target via `psql`
- [ ] Verify every table, index, function, trigger, RLS policy from V1 exists on V2

**Part C — data clone**
- [ ] `scripts/clone-supabase-data.sh`:
  - `pg_dump --data-only` from V1 (session pooler connection string)
  - `pg_restore` into V2
  - Excludes `auth.*` schemas (those are per-project; users re-login after cutover)
  - Excludes storage (handled separately in S10a-3)
- [ ] Verify row counts match between V1 and V2 for every base table

**QA Tasks — System Tests:**
- [ ] `SELECT COUNT(*) FROM users_v2`, `writing_projects_v2`, `published_content_v2`, `story_bible_v2` match between V1 and V2 byte-for-byte
- [ ] Randomly sample 5 `published_content_v2` rows in V2 — content_text matches V1
- [ ] RLS policies active on all tables (anon key cannot SELECT without JWT)
- [ ] pgvector extension working: `SELECT * FROM writing_embeddings_v2 LIMIT 1` succeeds

**Definition of Done:**
- [ ] New V2 Supabase project exists with all migrations applied
- [ ] Data matches V1 row-for-row
- [ ] Service role credentials saved in password manager + Railway

**Depends on:** nothing (can start immediately)

---

#### S10a-3: Migrate storage buckets V1 → V2 (5 pts) | P0

Supabase Storage isn't in `pg_dump`. Buckets and objects need a separate copy.

**Developer Tasks:**
- [ ] `scripts/migrate-storage.py`:
  - Lists all buckets on V1 via `storage.buckets` query
  - Creates matching buckets on V2 (same `public` flag, MIME allowlist, size limit)
  - For each object in every bucket: download from V1, upload to V2 (preserves path, MIME type, metadata)
  - Progress output (# objects copied, byte count)
  - Idempotent: skips already-copied objects (compares object key + size)
  - Rate limit: 5 concurrent transfers max (avoid hammering either project)
- [ ] Buckets on V1 as of sprint start: `author-content`, `cover-images`, `social-images`, `writing-samples` (plus Newsletter sprint's `newsletter-ingestion` if merged)
- [ ] Apply storage RLS policies from migration files to V2's `storage.objects`

**QA Tasks — System Tests:**
- [ ] V1 and V2 bucket lists match
- [ ] Object counts match per bucket
- [ ] Total byte size matches per bucket
- [ ] Random sample download: byte-identical between V1 and V2

**Definition of Done:**
- [ ] All buckets replicated
- [ ] All objects copied, verified by checksum
- [ ] Storage RLS applied

**Depends on:** S10a-2 (needs V2 project to exist)

---

#### S10a-4: Cutover prod Railway + n8n workflows to new V2 Supabase (3 pts) | P0

Switch the live production Writer's Workbench and all V2 n8n workflows to point at the new V2 Supabase. V1 becomes frozen after this.

**Developer Tasks:**

**Pre-cutover window:**
- [ ] Announce brief downtime (<5 min) to the single user (Eric) — or coordinate quiet moment
- [ ] Final data sync: re-run S10a-2 data clone one more time to capture anything written since last sync
- [ ] Run S10a-3 storage sync one more time (delta)

**Cutover:**
- [ ] Update Railway production env vars on `writers-workbench` service:
  - `SUPABASE_URL` → new V2 URL
  - `SUPABASE_SERVICE_ROLE_KEY` → new V2 service key
  - `VITE_SUPABASE_URL` → new V2 URL
  - `VITE_SUPABASE_ANON_KEY` → new V2 anon key
- [ ] Railway auto-redeploy kicks in (build from main branch)
- [ ] For every V2 n8n workflow with hardcoded `faklxfakgzkpkbxfihzh` in Code node:
  - Update to new V2 URL
  - Update service key (new V2 key)
  - `deactivate → PUT → activate` cycle
- [ ] GitHub secrets: update `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` to new V2 values

**Post-cutover verification:**
- [ ] User re-logs in (old JWT from V1 no longer valid on V2)
- [ ] Dashboard loads, shows correct projects/content counts
- [ ] Chat drawer works (sync + async ops)
- [ ] Create a test project → write a chapter → verify end-to-end

**Freeze V1:**
- [ ] Change V1 Supabase project: disable auth, or restrict service role access
- [ ] Update CLAUDE.md: V1 Supabase URL is now "Tier 1 baseline (frozen)"

**QA Tasks — E2E Tests:**
- [ ] Login flow works on production
- [ ] All existing user data accessible
- [ ] All 15 email-sending V2 workflows work against new V2 DB
- [ ] Ingestion workflows succeed
- [ ] Chapter write succeeds end-to-end

**Definition of Done:**
- [ ] Prod Workbench serving from new V2
- [ ] All n8n V2 workflows pointing at new V2
- [ ] V1 frozen (read-only or credential-restricted)
- [ ] End-to-end flow verified in production

**Depends on:** S10a-2, S10a-3

---

#### S10a-5: Schema governance — base vs meta tables + CI check (3 pts) | P0

Codify the mandatory coding guideline.

**Developer Tasks:**
- [ ] Create `writers-workbench/docs/schema-governance.md`:
  - Formal definition of base tables (7 entities from migrations 001–007)
  - Rule list (no ALTER, no DROP, no ADD COLUMN on base tables)
  - Meta table pattern with examples (good/bad)
  - Migration classification: migrations 001–007 are "base"; 008+ are "meta"
  - Procedures for genuinely-new-attribute-on-base-entity case (requires new Supabase generation)
- [ ] Update `CLAUDE.md` with a reference to the governance doc + a summary rule block
- [ ] Create `scripts/check-base-table-immutability.py`:
  - Parses every file in `writers-workbench/migrations/`
  - For files 008+, scans for `ALTER TABLE users_v2`, `ALTER TABLE writing_projects_v2`, etc. on any of the 7 base tables
  - Fails with error if found
  - Also checks that migrations 001–007 haven't been modified since baseline commit (compares against git blame)
- [ ] Add to CI (`.github/workflows/ci.yml`): new job `Schema Governance Check` runs the script on every PR
- [ ] Add to required checks on `main` and `develop` (via branch protection API)

**QA Tasks — Unit Tests (the check script itself):**
- [ ] Run check against known-good migrations → passes
- [ ] Fake a violation (e.g., add `ALTER TABLE users_v2` to migration 010) → check fails
- [ ] Modify migration 002 → check fails (base migration drift)

**Definition of Done:**
- [ ] Governance doc committed
- [ ] CI check integrated and required on PRs
- [ ] CLAUDE.md referenced

**Depends on:** nothing (can run in parallel with S10a-2 through 4)

---

#### S10a-6: Create Dev Supabase (clone of V2 after cutover) (5 pts) | P0

Third-tier DB for development. Created AFTER S10a-4 cutover so it's a copy of the new V2 state.

**Developer Tasks:**
- [ ] Create Supabase project "Writers Assistant Dev" in same org (Pro plan accommodates 3+ projects)
- [ ] Run `scripts/clone-supabase-schema.sh` + `scripts/clone-supabase-data.sh` against Dev target
- [ ] Run `scripts/migrate-storage.py` for buckets
- [ ] Seed additional test data (optional): dummy users for testing RBAC, known project for E2E tests
- [ ] Store Dev credentials in Railway (for dev Workbench service — applied in S10a-9)
- [ ] Note: Dev DB exists but isn't wired to anything until S10a-7 through S10a-9

**QA Tasks — System Tests:**
- [ ] Dev Supabase is a valid, working clone of new V2 (row counts match as of clone time)
- [ ] Service role credentials work

**Definition of Done:**
- [ ] Dev Supabase project running and cloned
- [ ] Credentials saved
- [ ] Governance CI check passes on Dev

**Depends on:** S10a-4 (needs new V2 as the authoritative source)

---

#### S10a-7: Clone all V2 n8n workflows to Dev counterparts (5 pts) | P0

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

#### S10a-8: Create Dev hub + dev webhook (3 pts) | P0

**Developer Tasks:**
- [ ] Clone the current V2 hub (`The Author Agent_V2`, ID `roMDypuMXHv6ugaZ`) to `The Author Agent V2 Dev`
- [ ] In Dev hub: change every `executeWorkflow` tool definition's workflow ID from the V2 workflow to the corresponding Dev workflow (using the ID map from S10a-7)
- [ ] Change webhook path: `/webhook/author_request_v2` → `/webhook/author_request_dev`
- [ ] Update any hardcoded Supabase URLs in Dev hub's Code nodes → Dev Supabase URL (from S10a-6)
- [ ] Activate Dev hub
- [ ] Verify Dev hub is fully isolated: sending a chat to dev webhook triggers only Dev workflows, never V2

**QA Tasks — System Tests:**
- [ ] Send a test message to `/webhook/author_request_dev` with a simple operation (e.g., "list my projects")
- [ ] Verify the Dev sub_retrieve_content workflow was called (check execution log for Dev workflow ID)
- [ ] Verify NO V2 workflows executed during the test
- [ ] Verify the Dev workflows hit Dev Supabase, not V2 Supabase (check connection logs)
- [ ] Send identical message to `/webhook/author_request_v2` → verify V2 workflows execute and hit V2 Supabase

**Definition of Done:**
- [ ] Dev hub exists, active, wired to Dev tool workflows + Dev Supabase
- [ ] Dev webhook reachable and responsive
- [ ] Isolation verified — zero cross-tier execution or cross-DB reads

**Depends on:** S10a-6, S10a-7

---

#### S10a-9: Point dev Writer's Workbench at Dev hub + Dev Supabase (2 pts) | P0

**Developer Tasks:**
- [ ] Update Railway dev environment env vars on `writers-workbench-dev` service:
  - `VITE_N8N_WEBHOOK_URL=https://n8n.agileadautomation.com/webhook/author_request_dev`
  - `VITE_SUPABASE_URL` → Dev Supabase URL
  - `VITE_SUPABASE_ANON_KEY` → Dev Supabase anon key
  - `SUPABASE_URL` → Dev Supabase URL
  - `SUPABASE_SERVICE_ROLE_KEY` → Dev Supabase service role key
- [ ] Trigger dev redeploy
- [ ] Update `.env.example` with clear comments separating production and development vars

**QA Tasks — E2E Tests:**
- [ ] From `writers-workbench-dev.up.railway.app`:
  - Login works against Dev Supabase (create a test user on Dev DB first)
  - Dashboard shows Dev data (not V2 data)
  - Chat hits Dev webhook, Dev workflows execute, Dev Supabase is read/written
- [ ] From production URL: all routes still hit V2 Supabase + V2 webhook
- [ ] No cross-environment data bleed

**Definition of Done:**
- [ ] Dev URL uses Dev webhook + Dev Supabase
- [ ] Prod URL uses V2 webhook + V2 Supabase
- [ ] `.env.example` documents both clearly

**Depends on:** S10a-8

---

#### S10a-10: Workflow promotion scripts (Dev → V2) (3 pts) | P1

**Developer Tasks:**
- [ ] Write `scripts/promote-dev-to-v2.sh`:
  - Takes a workflow name or ID as arg (e.g., `Tool - Write Chapter V2`)
  - Fetches corresponding Dev version from n8n
  - Applies Dev's nodes and connections to V2 (deactivate → PUT → activate cycle to rebuild activeVersion)
  - V2 workflow ID stays stable (hub references don't change)
  - Preserves V2's metadata (tags, owner, etc.)
  - **IMPORTANT:** swaps Dev-specific values back to V2-specific ones:
    - Supabase URLs: Dev URL → V2 URL
    - Webhook paths: `/webhook/*-dev` → `/webhook/*-v2`
    - Any executeWorkflow references: Dev ID → V2 ID (using id-map inverted)
  - Dry-run flag shows what would change without applying
  - Writes a promotion record to `workflows/promotion-log.md` with date, workflow, git SHA
- [ ] Write companion `scripts/diff-dev-vs-v2.sh` — shows node-level diff between Dev and V2 for a given workflow (useful pre-promotion check)
- [ ] Document promotion process in `docs/workflow-governance.md`:
  - When to promote (after PR merges to main, before release tag)
  - How Dev↔V2 config swaps are handled automatically
  - How to roll back a bad promotion (V2's previous activeVersion via n8n UI history)
  - Who approves promotion (the release PR reviewer)

**QA Tasks — Unit Tests:**
- [ ] Dry-run on an identical Dev/V2 pair → reports "no changes"
- [ ] Dry-run on a Dev workflow with a modified Code node → reports the specific node diff
- [ ] Script aborts with clear error if V2 workflow doesn't exist
- [ ] Script aborts with clear error if Dev workflow doesn't exist
- [ ] Dev→V2 swap: Dev Supabase URL is replaced with V2 Supabase URL in the promoted workflow

**QA Tasks — System Tests:**
- [ ] Make a trivial change to `Tool - Retrieve Content V2 Dev` (add a comment to a Code node)
- [ ] Run dry-run → see the change
- [ ] Run promotion → V2 workflow updated, executions test-successful afterwards
- [ ] Spot-check V2 workflow ID unchanged — hub references still work
- [ ] V2 workflow points at V2 Supabase (not Dev) after promotion
- [ ] `promotion-log.md` has an entry

**Definition of Done:**
- [ ] Both scripts working and documented
- [ ] Governance document updated
- [ ] One practice-promotion executed and logged

**Depends on:** S10a-7, S10a-9

---

#### S10a-11: Duplicate Eve agent + rename + update dev env (3 pts) | P0

Create the third Eve agent tier. **Manual steps on ElevenLabs dashboard** since there's no public duplication API.

**Developer Tasks (manual in ElevenLabs dashboard):**
- [ ] Rename current agent `agent_2801kks580vnf5q80j3bd0n0x45v` from "Beta Writing Assistant" → "Writing Assistant V2"
- [ ] Duplicate this agent in ElevenLabs dashboard → name the duplicate "Writing Assistant V2 Dev"
- [ ] Verify the duplicate carries: system prompt, knowledge base, voice config (aMSt68OGf4xUZAnLpTU8), tools, LLM config (gemini-2.5-flash)
- [ ] Capture new Dev agent ID

**Developer Tasks (code):**
- [ ] Update Railway `writers-workbench-dev` env:
  - `VITE_ELEVENLABS_AGENT_ID` → new Dev agent ID
- [ ] `writers-workbench.up.railway.app` keeps `VITE_ELEVENLABS_AGENT_ID=agent_2801kks580vnf5q80j3bd0n0x45v` (the renamed V2 agent)
- [ ] Update MEMORY.md with the new agent tier IDs
- [ ] Update CLAUDE.md baseline protection — V2 Eve is also frozen production

**QA Tasks — System Tests:**
- [ ] Dev Workbench opens Eve widget → connects to Dev agent (check ElevenLabs conversation log)
- [ ] Prod Workbench → connects to V2 agent
- [ ] Dev agent knowledge base updates don't affect V2 agent

**Definition of Done:**
- [ ] V1 agent (frozen): `agent_6401kjwqy66nfhabj82dvy8pnh2b`
- [ ] V2 agent (prod): `agent_2801kks580vnf5q80j3bd0n0x45v` (renamed to "Writing Assistant V2")
- [ ] Dev agent (new): captured ID, in use on dev env
- [ ] Documentation updated

**Depends on:** nothing (can run in parallel)

---

#### S10a-12: Automate release-cycle promotion (Dev → V2) for future cycles (5 pts) | P1

After this sprint's one-time initial setup (S10a-2 through S10a-6 clone V1 → V2 + Dev from scratch), every **subsequent** release cycle follows the **promote-Dev-to-V2** pattern described in the Release Cycle section. Automate it.

**Developer Tasks:**
- [ ] Create `scripts/release-promote-dev.sh`:
  - Step 1: Sanity checks — Dev has expected meta tables; V2 and Dev both reachable; no active long-running workflows
  - Step 2: Announce and begin downtime window (~30s-2min)
  - Step 3: Sync latest V2 base data → Dev:
    - pg_dump --data-only the 7 base tables from V2
    - TRUNCATE base tables in Dev (keeping meta tables intact)
    - pg_restore into Dev
    - Verify row counts V2 == Dev for each base table
  - Step 4: Sync storage delta V2 → Dev:
    - List objects in each V2 bucket
    - For each, check if exists in Dev; if not or size differs, copy
    - No deletions in Dev (Dev-only test objects preserved)
  - Step 5: Flip Railway + n8n env vars:
    - Railway prod service → Dev's Supabase URL/keys
    - Every V2 n8n workflow's hardcoded Supabase URL/key → Dev's
  - Step 6: Rename Supabase project display names:
    - Old V1 (archive label) — schedule deletion in 60 days
    - Old V2 → "Writers Assistant V1" (new frozen baseline)
    - Dev → "Writers Assistant V2" (new production)
  - Step 7: Post-cutover verification:
    - Health check against new V2 endpoints
    - Create-read-delete roundtrip on a scratch row to confirm writability
    - User re-login works
  - Step 8: Write promotion record to `writers-workbench/docs/release-log.md` with git SHA, timestamp, project IDs, approver
  - Dry-run flag shows every step without mutating anything

- [ ] Create `scripts/release-create-new-dev.sh`:
  - Step 1: Create a new Supabase project "Writers Assistant Dev" (via Supabase Management API if available, else document as manual step)
  - Step 2: Clone schema + base data from new V2 → new Dev (re-uses S10a-2 scripts)
  - Step 3: Clone storage (re-uses S10a-3 scripts)
  - Step 4: Update Railway dev service env vars → new Dev URL/keys
  - Step 5: Re-run n8n clone-v2-to-dev.py against n8n to recreate Dev workflows pointing at new Dev Supabase (or update existing Dev workflows' Supabase URLs)

- [ ] Create `scripts/release-retire-baseline.sh`:
  - Parameterized: `--project-id`, `--retention-days=60`
  - Tags old baseline project with retire date
  - Revokes service role key (prevents writes)
  - Emails admin 7 days before retire date
  - Optional: exports final snapshot to S3/Cloudflare R2 for cold archive

- [ ] Document in `docs/schema-governance.md` → "Release cycle runbook" section

**QA Tasks — System Tests:**
- [ ] Dry-run `release-promote-dev.sh` against scratch test projects → all steps execute without errors, row counts match
- [ ] `release-create-new-dev.sh` creates valid Dev project
- [ ] `release-retire-baseline.sh` correctly revokes writes on a test project

**Definition of Done:**
- [ ] All 3 scripts committed, documented
- [ ] Dry-runs verified against test projects
- [ ] Runbook section in `docs/schema-governance.md`

**Depends on:** S10a-2 through S10a-6 (scripts used as building blocks)

**NOTE — This sprint's initial setup (S10a-2 through S10a-6) is a ONE-TIME pattern different from future cycles.** Initial: create new V2 from frozen V1. Future: promote current Dev to become new V2 (with latest prod data synced in first).

---

### Sprint 10.a totals: 49 pts across 13 stories

### Dependencies

```
S10a-0 (CI/CD verification) ──────┐
                                  │
S10a-1 ✓ ────────────────────────┤
                                  │
                                  ▼
           S10a-2 → S10a-3 → S10a-4 ──────┐
                                          │
                                          ▼
                                     S10a-6 (Dev DB) ──┐
                                                       │
S10a-5 (schema governance) ──────────────────────────── │
                                                       ▼
                             S10a-7 → S10a-8 → S10a-9 → S10a-10
                                                             │
                         S10a-11 (Eve clone, parallel) ──────┤
                                                             ▼
                                                         S10a-12
```

### Recommended execution order (solo)
1. **S10a-0** (CI/CD verification + deploy markers) — prerequisite, validates both pipelines
2. **S10a-5** (schema governance + CI check) — fast, parallelizable, unblocks everything
3. **S10a-2** (new V2 Supabase + schema + data clone) — biggest single piece
4. **S10a-3** (storage migration)
5. **S10a-4** (prod cutover to new V2) — brief downtime
6. **S10a-6** (Dev Supabase from new V2)
7. **S10a-11** (Eve agent Dev clone — fully manual in ElevenLabs)
8. **S10a-7** (clone V2 workflows → Dev, pointing at Dev Supabase)
9. **S10a-8** (Dev hub + /webhook/author_request_dev)
10. **S10a-9** (dev Railway env vars → Dev hub + Dev Supabase + Dev Eve)
11. **S10a-10** (promotion scripts + one practice promotion)
12. **S10a-12** (release-cycle automation for future use)

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

## Sprint 12: Chapter Writer — Parallelization + Research/Rewrite Tool

**Status:** Planned | **Points:** 57 | **Duration:** ~3 weeks | **Priority:** P0

**Goal:** Two co-shipped improvements to the chapter pipeline:
1. **Parallelization (34 pts):** Chapter writer currently takes 10–20 minutes because of a 120-second rate delay and strictly sequential LLM calls. Remove the delay, build a pre-computed context document, fan out sub-chapter writes in parallel, add a merge/continuity pass. **Target: 3–5 minutes per chapter.**
2. **Research/Rewrite Tool (23 pts):** A quick `maxIterations` hotfix to unblock multi-step requests today + new composite tool so the user can say one natural-language sentence to Eve and get a revised chapter that:
   - Researches a topic you specify (saved as its own `research_reports_v2` row AND integrated into the rewrite)
   - Fixes FAIL/NEEDS_REVIEW items from the chapter's last Q/A consistency report (default on)
   - Applies freeform style directives per character, scene, or moment ("make Craig and his associates highly exaggerated buffoons; Mason stumbles around trying to follow them")
   - All of the above stacked in a single invocation

**Why now:** Parallelization gates all concurrent usage (10 chapter writes can't happen simultaneously without it). Rewrite tool addresses the main creative control gap — right now rewrites re-invoke the full writer with the same inputs and produce essentially the same output; the user has no way to inject research, Q/A fixes, or targeted style directives.

**Governance:** All work on Dev workflows per Sprint 10.a. Promoted to V2 at release.

### Track A — Parallelization (34 pts)

#### S12-1: Remove rate delay + timing instrumentation (3 pts) | P0

**Developer Tasks:**
- [ ] In `Worker - Write Chapter V2 Dev`: delete the `rate_limit_delay` Wait node (120s between sub-chapters)
- [ ] Reconnect the loop: `Loop Over Sub-Chapters` done → `write_sub_chapter` directly
- [ ] Add timing Code nodes: capture `Date.now()` at start and end, store breakdown in `metadata.timing` on `published_content_v2`
- [ ] Run 3 benchmark chapters (3, 5, 7 sub-chapters) and record times

**QA — System Tests:**
- [ ] 3-sub-chapter chapter < 5 min (was ~8.5 min)
- [ ] 5-sub-chapter chapter < 8 min (was ~13.5 min)
- [ ] No Anthropic rate-limit errors
- [ ] `metadata.timing` populated with breakdown
- [ ] Chapter content quality unchanged (manual review)

**Definition of Done:** All 3 benchmarks complete without errors + chapter quality confirmed unchanged.

#### S12-2: Context document generator (8 pts) | P0

**Developer Tasks:**
- [ ] New sub-workflow `Sub - Build Chapter Context V2 Dev`
- [ ] Input: `project_id`, `chapter_number`, `user_id`
- [ ] Loads book outline, story bible, genre config, previous chapter summaries (`published_content_v2` WHERE `chapter_number < current`), story arc prompts
- [ ] LLM call (Claude Sonnet 4, 4096 max tokens, temp 0.2) synthesizes a single context document containing:
  - Character states as of this chapter (who knows what, where they are)
  - Active plot threads
  - Setting details
  - Voice/tone samples (first 500 chars of 2 previous chapters)
  - Story arc beat for this chapter
  - Continuity notes (any QA flags from previous chapters)
- [ ] Returns context string
- [ ] Register workflow; capture new ID; add to `workflow-id-map.json`

**QA — System + Unit Tests:**
- [ ] Context doc includes all character names from story bible
- [ ] Context doc includes current chapter's arc beat
- [ ] Context doc includes previous chapter summaries (not full text)
- [ ] Stays under 4000 tokens (tiktoken count)
- [ ] Works for Chapter 1 (no previous chapters — graceful empty state)
- [ ] Works for Prologue (`chapter_number=0`)
- [ ] Callable via `executeWorkflow` in under 30 seconds

**Definition of Done:** Sub-workflow runs < 30s, output validated across 3 chapter scenarios.

#### S12-3: Parallel sub-chapter fan-out (13 pts) | P0

**Developer Tasks:**
- [ ] Rewrite `Worker - Write Chapter V2 Dev` core loop:
  - Before: `Loop → delay → write → memory → loop`
  - After: `build_chapter_context → generate all sub-chapter prompts → SplitInBatches (batch=N) → write_sub_chapter (parallel) → Merge → sort by sub-chapter number → concat → QA`
- [ ] Each sub-chapter prompt includes the full context document (identical across all — Anthropic cache hit) + its sub-chapter brief, arc beat, characters, setting
- [ ] Remove `chapter_memory` (memoryBufferWindow) — replaced by context document
- [ ] Keep vector store tool available for each sub-chapter (independent retrievals are fine in parallel)
- [ ] Error handling: if any sub-chapter fails after 3 retries, save partial chapter with `[SECTION FAILED]` marker + notify user

**QA — System Tests:**
- [ ] 3-sub-chapter chapter < 3 minutes
- [ ] 5-sub-chapter chapter < 4 minutes
- [ ] 7-sub-chapter chapter < 5 minutes
- [ ] All sub-chapters present in correct order
- [ ] Character names consistent across parallel sub-chapters
- [ ] No duplicate content between sub-chapters
- [ ] Partial failure: 1 sub-chapter fails → chapter saved with marker → user notified
- [ ] 2 users writing chapters simultaneously → both complete without interference
- [ ] Vector store queries from parallel sub-chapters don't conflict
- [ ] QA pass still runs on complete chapter

**Definition of Done:** All timing targets hit on Dev; quality regression test passes (manual review of 2 chapters before/after).

#### S12-4: Continuity merge pass (5 pts) | P1

**Developer Tasks:**
- [ ] New Claude call after concatenation, before QA:
  - Model: Claude Sonnet 4, 8192 maxTokens, temp 0.3
  - Prompt: "Review these N sub-chapters written in parallel. Fix: transition sentences between sub-chapters, character state inconsistencies, repeated phrases, tone shifts. Do NOT rewrite — only fix seams."
  - Input: full concatenated chapter + context document
  - Output: revised chapter text
- [ ] Skip merge pass if chapter has ≤ 2 sub-chapters (seamless enough)
- [ ] Store pre-merge and post-merge in `metadata.versions.pre_merge`

**QA — System Tests:**
- [ ] Merge pass runs < 60 seconds
- [ ] 5-sub-chapter chapter shows smoother transitions (manual)
- [ ] Merge doesn't significantly change word count (< 5% delta)
- [ ] Merge skipped for 2-sub-chapter chapter
- [ ] `metadata.versions.pre_merge` contains unmerged text

**Definition of Done:** Merge pass improves one benchmark chapter's readability score (manual) without changing word count > 5%.

#### S12-5: Timing telemetry + performance dashboard (5 pts) | P1

**Developer Tasks:**
- [ ] Add timing metrics to `token_usage_v2`: `execution_time_ms`, `queue_wait_ms`, `llm_time_ms`
- [ ] New endpoint `GET /api/admin/performance`:
  - Avg chapter write time (last 7 days)
  - P95 chapter write time
  - Avg sub-chapter write time
  - Queue wait time distribution
  - Job success/fail rates by queue
- [ ] Admin UI Metrics tab → Performance section:
  - Chapter time chart (before vs after parallelization)
  - Queue depth over time
  - Active workers count

**QA — Unit + E2E Tests:**
- [ ] Performance endpoint returns correct averages from test data
- [ ] P95 calculation correct
- [ ] Empty data → zeros (not errors)
- [ ] Admin-only access enforced
- [ ] E2E: Admin → Metrics → Performance section shows charts

**Definition of Done:** Dashboard live, showing real data from at least 10 chapter writes.

### Track B — Research / Rewrite Tool (23 pts)

#### S12-0: Eve multi-step task hotfix (2 pts) | P0 | Early-win — ships before rest of Track B

Small, immediate fix to let Gemini complete chains like "retrieve → research → rewrite" RIGHT NOW, without waiting for the full composite tool. When a user issues multi-step requests (sequential tasks, or a single sentence with "and then"/"using"/"based on"), the Author Agent currently hits its `maxIterations` limit of ~3 and returns "Agent stopped due to max iterations." Evidence: execution ID #12539 on 2026-04-20.

**Developer Tasks (Dev hub — per Sprint 10.a governance, applies to Dev hub first, then promotes via S10a-10):**
- [ ] In `The Author Agent V2 Dev`, bump the Author Agent node's `options.maxIterations` from **3 → 10**. Gemini only consumes what it needs; higher limit has no cost for simple requests.
- [ ] In `preprocess_message` (Code node): detect multi-step patterns and **skip** the `[TOOL OVERRIDE — retrieve_content]` prefix when found. Heuristics:
  - Message contains "Task 1:", "Task 2:", or any numbered task list
  - Message contains ". Then", ". After", "using that", "based on" bridging two verbs
  - Message contains multiple imperative verbs ("research and rewrite", "get the chapter and rewrite it")
- [ ] When multi-step is detected, let Gemini plan the chain itself (no forced tool call). The existing TOOL OVERRIDE logic still fires for simple single-intent retrieves.
- [ ] Promote via S10a-10 to V2 at end of this sprint's release (or hotfix earlier if urgent).

**QA Tasks — System Tests:**
- [ ] "Get chapter 6 and rewrite it with research on constitutional law" → Gemini calls retrieve → then write_chapter or rewrite_chapter_with_research (when S12-6 lands), without hitting max iterations
- [ ] "Rewrite chapter 6" (single intent) → TOOL OVERRIDE still applies correctly if matched
- [ ] Sequential task format ("Task 1:... Task 2:...") → no TOOL OVERRIDE, Gemini plans freely
- [ ] maxIterations ceiling: 10 calls max before agent stops; logged for visibility

**Definition of Done:**
- [ ] Dev hub completes execution ID #12539-style prompt end-to-end without max-iterations error
- [ ] All single-intent patterns (just retrieve, just write, just brainstorm) still work unchanged

**Depends on:** Sprint 10.a S10a-8 (Dev hub must exist)

---

#### S12-6: `Tool - Rewrite Chapter with Research V2 Dev` — main workflow (8 pts) | P0

**Developer Tasks:**
- [ ] New n8n workflow. Dev-tier naming per Sprint 10.a.
- [ ] Trigger: `executeWorkflowTrigger` with $fromAI inputs:
  ```
  project_title        required
  chapter_number       required
  research_focus       optional  freeform text
  use_qa_report        optional  boolean, default true
  style_directives     optional  freeform text (per-character, per-scene, or global)
  user_prompt          always    passthrough of original Eve/chat request
  recipient_email, bcc_email, user_id    standard V2
  ```
- [ ] Flow:
  1. `settings` — load project from Supabase via `project_title`, read genre_slug, load genre writing_guidelines, load app_config email recipients
  2. `load_chapter` — fetch current chapter from `published_content_v2` by project_id + chapter_number
  3. `load_qa_report` — if `use_qa_report` is true, parse `metadata.qa_report`, extract FAIL / NEEDS_REVIEW items
  4. Branch: if `research_focus` present → call S12-7 research sub-flow → receive findings
  5. `build_rewrite_prompt` — compose massive prompt combining all inputs (see prompt skeleton below)
  6. `rewrite_llm` — Claude Sonnet 4, 16000 maxTokens, temp 0.4
  7. `snapshot_old_chapter` — insert row in `content_versions_v2` with current chapter text
  8. `update_chapter` — PATCH `published_content_v2` with rewritten text, increment updated_at
  9. `optional_qa_recheck` — if enabled, call QA chapter V2 workflow on the rewrite (follow-up)
  10. `send_email` — via Postal (`/api/email/send`) with the rewritten chapter + diff summary + updated Q/A delta
  11. Async: track_token_usage, re_embed_project (fire-and-forget)

**Prompt skeleton (S12-6 developer reference):**
```
SYSTEM: You rewrite existing book chapters. You receive the current chapter, 
its outline, genre guidelines, and optional directives. Produce a rewritten 
chapter that: follows the outline structure exactly, maintains character names 
and plot points, applies the style and research directives provided, and 
preserves what works.

CHAPTER OUTLINE (must be followed):
{chapter_outline}

CURRENT CHAPTER:
{current_chapter_text}

GENRE BASELINE STYLE:
{genre_config.writing_guidelines}

{{if qa_report has FAILs}}
Q/A ISSUES TO FIX:
The previous audit flagged these specific failures — address each:
- {check_name}: FAIL — {detail}
- {check_name}: NEEDS_REVIEW — {detail}
{{/if}}

{{if research_focus provided}}
RESEARCH ACCURACY:
User directive: "{research_focus}"
Research findings (from Perplexity with citations):
{research_results}

Weave these findings naturally into dialogue or narration. Do not dump research;
incorporate it as characters would plausibly know or cite it.
{{/if}}

{{if style_directives provided}}
STYLE DIRECTIVES (user-specified):
"{style_directives}"

These instructions apply across the chapter. Figure out which characters, scenes,
or moments they refer to based on the chapter content. If a directive references
a specific movie, book, or creative work, use it only as a stylistic anchor —
NEVER name-drop the reference in the prose itself.
{{/if}}

PRESERVE:
- Character names as they appear in the story bible
- Plot beats from the outline
- Scene locations from the outline
- Dialogue that already works

OUTPUT: the rewritten chapter text only. No commentary, no preamble.
```

**QA — Unit + System Tests:**
- [ ] Workflow executes end-to-end on a test chapter with all 3 input modes off → produces a baseline rewrite using just Q/A fixes + genre baseline
- [ ] With `research_focus` only → research pipeline runs, findings appear in prompt
- [ ] With `style_directives` only → LLM applies directives visibly in output
- [ ] With `use_qa_report=true` and a chapter that has FAILs → rewrite addresses each specific FAIL
- [ ] Chapter version snapshotted to `content_versions_v2` before overwrite (verify new row exists)
- [ ] Email arrives with diff summary

**Definition of Done:** All 4 modes exercised; each mode produces visibly different output from control; chapter versioned correctly.

#### S12-7: Research pipeline sub-workflow (5 pts) | P0

**Developer Tasks:**
- [ ] New sub-workflow `Sub - Research Chapter Topics V2 Dev`
- [ ] Input: `chapter_text`, `research_focus` (user directive), `chapter_number`, `project_title`, `user_id`
- [ ] LLM step 1: Claude 4, temp 0.2, `Extract up to 5 specific research questions from this chapter matching the user's focus`. Returns JSON array of questions.
- [ ] For each question: call Perplexity (native node, `sonar-pro` model) — accumulate findings + citations
- [ ] LLM step 2: Claude summarizes findings into a structured research report (markdown with citations)
- [ ] Persist to `research_reports_v2`:
  - `title`: "Research for Chapter N of {project_title}: {research_focus[:50]}"
  - `content`: the markdown report
  - `genre_slug`: from project
  - `metadata.source`: `'chapter_rewrite'`, `metadata.chapter_number`, `metadata.project_id`
- [ ] Return: `{research_markdown, research_id}` to caller (S12-6)

**QA — Unit + System Tests:**
- [ ] Extracts 3–5 reasonable research questions from a sample chapter + focus
- [ ] Each question runs through Perplexity successfully
- [ ] Compiled report has citations
- [ ] Row written to `research_reports_v2` with correct metadata
- [ ] Report appears in Writer's Workbench Research Reports list after creation

**Definition of Done:** End-to-end run against Chapter 6 of The Invisible Wall with focus="constitutional arguments Lucia uses" produces a saved report with ≥3 Supreme Court citations.

#### S12-8: Q/A report integration (3 pts) | P0

**Developer Tasks:**
- [ ] Add logic to S12-6's `load_qa_report` Code node:
  - Read `published_content_v2.metadata.qa_report` for the chapter
  - Parse the `checks` array
  - Filter items where `status IN ('FAIL', 'NEEDS_REVIEW')`
  - Format as bullet list with `check_name`, `status`, `detail`
  - Output as prompt fragment for S12-6's rewrite prompt
- [ ] Default behavior: `use_qa_report=true` unless explicitly passed false
- [ ] If no Q/A report exists for the chapter → skip gracefully (note in prompt: "no prior Q/A")

**QA — Unit + System Tests:**
- [ ] Chapter with 3 FAIL checks → prompt fragment lists all 3
- [ ] Chapter with only PASS → prompt fragment says "no prior issues"
- [ ] Chapter with no Q/A report → prompt fragment says "no prior Q/A"
- [ ] Default (no flag passed) → behaves as `use_qa_report=true`
- [ ] Explicit `use_qa_report=false` → Q/A report skipped entirely

**Definition of Done:** Rewrite prompt correctly reflects Q/A state for 3 test cases (has FAILs / all PASS / no report).

#### S12-9: Hub wiring + tool description + E2E (5 pts) | P0

**Developer Tasks:**
- [ ] In Dev hub (`The Author Agent V2 Dev`): add new `rewrite_chapter_with_research` tool
- [ ] Tool description in hub system prompt explains when to use vs write_chapter vs edit_outline:
  ```
  rewrite_chapter_with_research — use when user says "rewrite chapter N" with
  specific directives about research, Q/A fixes, or style. The tool:
    - accepts research_focus (what to research)
    - accepts style_directives (freeform, per-character or per-scene)
    - uses last Q/A report by default (opt-out via "ignore Q/A")
    - preserves chapter outline structure, character names, plot beats
  ```
- [ ] $fromAI tool inputs documented with descriptions (no default values in $fromAI per CLAUDE.md rule about single quotes)
- [ ] Preprocess_message updates:
  - Detect rewrite-with-directives patterns ("rewrite chapter N with/that/where", "rewrite chapter N and research", "rewrite chapter N. Make X...")
  - Add TOOL OVERRIDE for `rewrite_chapter_with_research`
- [ ] Update `preprocess_message` so sequential-task detection doesn't interfere (Multi-directive rewrite IS one task)

**QA — E2E Tests:**
- [ ] From chat: "Rewrite chapter 6 of The Invisible Wall. Research the constitutional arguments Lucia uses. Make Craig and his associates highly exaggerated buffoons, and Mason stumbles trying to copy them." → Gemini calls `rewrite_chapter_with_research` with all 3 inputs populated
- [ ] Shorter variants resolve correctly:
  - "Rewrite chapter 6 with dark humor" → `style_directives` populated, rest defaults
  - "Rewrite chapter 6 with research on constitutional law" → `research_focus` populated
  - "Rewrite chapter 6" → all optional inputs empty, Q/A default on
- [ ] End-to-end: full chain completes (chapter rewrite + research report saved + email delivered) in < 8 minutes on Dev
- [ ] Research report visible in Research Reports UI
- [ ] New chapter version in `content_versions_v2`

**Definition of Done:** 4 E2E scenarios all pass against Dev; research report saved; chapter versioning working.

---

### Track C — Reviewer/Editor Tools (added mid-sprint)

Two diagnostic-and-fix tools and a shared review surface, added once Track B exposed how often the user wants targeted, evidence-backed feedback on what's already written rather than another full rewrite.

#### S12-11: `Tool - Evaluate Genre Compliance V2 Dev` (8 pts) | P0 | ✅ COMPLETE

**Goal:** Score one chapter against the project's genre writing directive and return a structured per-rule report (scores, evidence quotes, three streams of suggestions: prose adaptations, outline adaptations, observations). Read-only — produces a report, never mutates the chapter or outline.

**Developer Tasks (done):**
- [x] New workflow `DEV - Tool - Evaluate Genre Compliance` (id `e9LEpCM5L7zVpQxl`)
- [x] Computed-before architecture: validator computes context from verified `evidence.quote` position rather than trusting LLM context fields
- [x] Schema enum on `adaptation_target` + fuzzy text match on `evidence.quote` to defend against fabrication
- [x] Required suggestion shape: rule_dimension, score, status, adaptation_target, scope.sub_chapter, evidence (quote + context), exemplar (title + technique), after (rewritten prose), editor_note (60–280 char human voice), proposed_change, preserves
- [x] Three-stream output: `prose_adaptations`, `outline_adaptations`, `observations`
- [x] Persists to `published_content_v2.metadata.genre_eval`
- [x] Wired into DEV hub via `evaluate_genre_compliance` tool node + `ui:evaluate-genre` source bypass for server-dispatched eval jobs
- [x] First successful scan: 7 kept / 1 rejected on Ch7 of *The Invisible Wall*

**QA / DoD:** Smoke run on Ch7 of *The Invisible Wall* shipped a structured report with rejected-suggestion count > 0 (validator did its job). ✅

#### S12-12: `Tool - Scan Character Drift V2 Dev` (8 pts) | P0 | 🟡 IN PROGRESS

**Goal:** Detect character-name drift across every chapter of a project. Aggregates per-character variant tallies, flags forbidden variants and cross-chapter inconsistencies, and surfaces unknown people not in the outline roster. Read-only — produces a report, never mutates content.

**Developer Tasks (done):**
- [x] New workflow `DEV - Tool - Scan Character Drift` (id `fJWDHXhle345f6jY`)
- [x] **Pivot from LLM-based extraction to deterministic regex algorithm** (`scanner_algorithm: 'deterministic-regex-v4'`). Cuts time from 5+ min to <1 sec, eliminates token-limit failures, eliminates parse failures, eliminates fabrication risk. Driven by user feedback ("create an algorithm that will work for all chapter sizes — deal with the performance issues").
- [x] Three-phase matcher: (1) canonical full-name + first-name regex with longest-first ordering, (2) drift candidates `<canonical first> <Surname>` not in allowed set, (3) unknown people via honorific + bare-name pattern with consumed-range masking
- [x] Possessive stripping (`Lucia's` → `Lucia`)
- [x] Wired into DEV hub via `scan_character_drift` tool node + `ui:scan-character-drift` source bypass
- [x] Persists to `writing_projects_v2.outline._character_drift_scan`

**Developer Tasks (open — finish this sprint):**
- [ ] **Reverse-order detection**: add regex pass for `<Surname>,\s*<canonical first_name>` (case-file form, e.g. "Rodriguez, Elena") and `<Surname>\s+<canonical first_name>`. Surfaces drift the v4 forward-only matcher missed in Ch5 of *The Invisible Wall*.
- [ ] **Noise filter expansion**: extend `NON_PERSON_PATTERNS` to filter the unknown-character bucket. Current scan returns 144 unknowns of which ~134 are noise (legal terms: Constitution, Supreme Court, Fourteenth Amendment; ICE jargon: Priority One/Two/Three, Target Profile Alpha/Beta, Real Americans; place names: Maple Avenue, Roosevelt Elementary; broken paragraph compounds like "The October", "The Tract"). Goal: real character signals visible without scrolling.
- [ ] Re-scan *The Invisible Wall* and confirm: ≥2 reverse-order drift flags surface (Ch5 Elena/Rodriguez, Ch7 Maria Elena Rodriguez), ≤20 unknown_characters with most being real (Pastor Williams, Mrs. Chen, Maria Santos, Agent Martinez/Rodriguez/Thompson, Director Harrison, Mr. Peterson, Mrs. Rodriguez, Justice Brennan, Carmen).

**QA / DoD:** Re-scan must surface the Ch5 case-file drift (`Rodriguez, Elena`) as a `variant_inconsistency` flag and reduce unknown-character noise by at least 80%.

#### S12-13: Shared Report-Comment UI surface (8 pts) | P1 | NEW

**Goal:** Stop forcing the user to mentally cross-reference a JSON report against the chapter prose. Every drift flag and every genre-eval suggestion gets pinned to the exact span in the chapter editor — like Google Docs comments — with one-click "apply suggested fix" or "open in editor at this position." One UI shared by S12-11 and S12-12 (and any future evidence-backed report tool).

**Why now:** Both S12-11 and S12-12 already store enough anchoring metadata (`evidence.quote`, `chapter_number`, `sample_contexts`) to drive a comment surface. Without this, "hand-fix" today means typing instructions to Eve in the chat panel — workable but blind to the report. With it, the user reviews flags and accepts/rejects fixes inline.

**Developer Tasks:**
- [ ] **API**: `GET /api/projects/:id/chapters/:n/annotations` — returns merged annotations from `metadata.genre_eval` (S12-11) and `outline._character_drift_scan` (S12-12) for that chapter, normalized to a single shape: `{source: 'genre_eval'|'drift_scan', anchor: {quote, char_offset?}, severity, message, suggestion?: {action, replacement_text?}}`
- [ ] **API**: `POST /api/projects/:id/chapters/:n/annotations/:annotationId/apply` — performs the precise span replacement (no full LLM rewrite), snapshots prior text into `content_versions_v2`, returns updated chapter
- [ ] **API**: `POST /api/projects/:id/chapters/:n/annotations/:annotationId/dismiss` — marks the annotation `dismissed_at` so it doesn't reappear
- [ ] **Anchoring algorithm**: locate `evidence.quote` in current chapter text (exact match first, then 90% fuzzy match within ±200 chars of `sample_contexts.context`); compute character offset; if not found, mark annotation as `stale`
- [ ] **Client**: side panel in chapter editor listing annotations grouped by source, each with severity icon, message, evidence excerpt, and Apply/Dismiss/Open buttons. Clicking Open scrolls editor to anchor and highlights the span.
- [ ] **Client**: inline gutter marker on highlighted span (like a comment pin) so the user can spot them while reading
- [ ] **Client**: stale annotations get a "rescan" CTA that triggers the source tool again
- [ ] **n8n side**: ensure `genre_eval` and `_character_drift_scan` writers store anchoring fields needed by the API (`evidence.quote` already present; add `evidence.context` for drift_scan flags so fuzzy match works)

**QA — System + E2E Tests:**
- [ ] Drift scan with reverse-order flag (Ch5 case file) → annotation appears in side panel with correct anchor
- [ ] Click Apply on drift annotation → text replaced, version snapshot created, annotation removed from list
- [ ] Click Dismiss → annotation gone but no text change, no version snapshot
- [ ] Genre eval suggestion with `proposed_change` → Apply replaces correct span
- [ ] Editing the chapter so `evidence.quote` no longer matches → annotation marked stale → rescan CTA visible
- [ ] Two annotations on overlapping spans → both visible, applying one updates the other's anchor

**Definition of Done:** End-user can review a drift scan / genre eval, click Apply on at least one annotation per source, and see the chapter text update + version snapshot in `content_versions_v2`. No JSON-blob hunting required.

---

### Sprint 12 totals (revised): 81 pts (13 stories)

Original Tracks A + B: 57 pts. Track C add-ons (S12-11, S12-12, S12-13): 24 pts.

### Dependencies
- Sprint 10.a complete (Dev tier must exist for all workflow changes)
- Track A and Track B can proceed in parallel (different workflows)
- Track C depends on Track B's Q/A report shape (S12-8) for genre-eval suggestions to dovetail

### Recommended execution order
**S12-0 first — it's a 2-pt early win that unblocks multi-step requests TODAY.**
- Track A (solo):  S12-1 → S12-2 → S12-3 → S12-4 → S12-5
- Track B (solo):  **S12-0** → S12-7 → S12-8 → S12-6 → S12-9
- Track C (solo, added mid-sprint):  **S12-11** ✅ → **S12-12** 🟡 → S12-13

Converge at PR to develop; promote all three tracks together at end-of-sprint release.

---

## Sprint 13: n8n Migration to Railway — Independent Standalone Instances

**Status:** Planned | **Points:** 34 | **Duration:** 2 weeks | **Priority:** P1

**Goal:** Move n8n off the external `n8n.agileadautomation.com` host and onto Railway as **independent standalone instances** (not queue mode). Stand up `n8n-prod` and `n8n-dev` as fully self-contained services (own SQLite, own volumes, own webhooks, own encryption keys). Externalize the hardcoded credentials in V2 workflow Code nodes. Add the Workbench-side router so a future `n8n-prod-2` can be partitioned in.

**Why standalone, not queue mode?** Queue mode requires shared Postgres + Redis + identical encryption key across all workers. Confirmed out of scope per user direction: every n8n instance is fully isolated — own DB, own workflows, own webhooks. Scaling = launch another full instance; route to it with user_id hash. Trade-off: workflow changes must sync to each instance (automated via scripts); atomic failure isolation is much better.

See [`docs/railway-deployment.md`](docs/railway-deployment.md) for the full Railway service specs.

### Stories

#### S13-1: Externalize n8n workflow credentials to env vars (8 pts) | P0

**Developer Tasks (Dev workflows only — per 10.a governance):**
- [ ] Audit every V2 Dev workflow's Code nodes for hardcoded credentials: Supabase URL, Supabase service role key, Anthropic API key, Perplexity key, OpenAI key, KIE.AI key, Firecrawl key
- [ ] Replace each with `$env.<VAR_NAME>` references (n8n injects env vars into Code nodes via `$env.*`)
- [ ] Create n8n instance-level env vars for each: `N8N_SUPABASE_URL`, `N8N_SUPABASE_SERVICE_KEY`, `N8N_ANTHROPIC_API_KEY`, etc. (full list in `docs/railway-deployment.md`)
- [ ] Update `scripts/promote-dev-to-v2.sh` to handle env-var diffs between tiers (different values for Dev vs V2 vs future instances)
- [ ] Run each migrated Dev workflow to confirm still working

**QA — System Tests:**
- [ ] `grep` all 24 Dev V2 workflow JSONs — zero literal API keys or Supabase URLs remain
- [ ] Every migrated workflow still executes successfully against Dev Supabase

**Definition of Done:**
- [ ] Zero hardcoded secrets in Dev workflow Code nodes
- [ ] All workflows still working after env-var refactor
- [ ] Promotion script updated

#### S13-2: Deploy `n8n-prod` and `n8n-dev` as standalone Railway services (13 pts) | P0

**Developer Tasks:**
- [ ] Deploy `n8n-prod` on Railway:
  - Image `n8nio/n8n:latest`
  - Volume 5 GB at `/home/node/.n8n` (SQLite + credentials + workflows)
  - Env vars per `docs/railway-deployment.md` including unique `N8N_ENCRYPTION_KEY`
  - Public domain: `n8n.agileadautomation.com` (DNS cutover from external host at end of sprint)
- [ ] Import all V2 workflows from repo JSONs via n8n API — or export from current external n8n and import to Railway instance
- [ ] Deploy `n8n-dev` same pattern — own volume, own unique encryption key, domain `n8n-dev.agileadautomation.com`
- [ ] Import all Dev workflows from the Dev hub built in Sprint 10.a
- [ ] Verify each instance executes workflows correctly and reaches its tier's Supabase
- [ ] Capture n8n API keys on both instances → save in Railway as `N8N_PROD_API_KEY` / `N8N_DEV_API_KEY` on Workbench services

**QA — System Tests:**
- [ ] n8n-prod health check responds on `n8n.agileadautomation.com`
- [ ] n8n-dev health check responds on `n8n-dev.agileadautomation.com`
- [ ] Test webhook POST to each instance returns expected response
- [ ] No cross-tier data bleed (Dev workflow writes to Dev Supabase only; Prod to V2 Supabase only)

**Definition of Done:**
- [ ] Two n8n Railway services running
- [ ] All workflows imported and executing
- [ ] Domains wired; DNS cutover from external n8n complete

#### S13-3: Workbench multi-instance router (3 pts) | P0

**Developer Tasks:**
- [ ] Create `writers-workbench/server/src/lib/n8n-router.ts`:
  - Reads `N8N_PROD_INSTANCES` env var (comma-separated URLs)
  - `pickN8nInstance(userId)` uses stable hash of `user_id` → instance URL
  - Same user always hits same instance (preserves in-flight execution state invariants)
  - Fallback: if env var missing, uses single `N8N_API_URL`
- [ ] Update `writers-workbench/server/src/routes/chat.ts` to call `pickN8nInstance()` before POSTing the webhook
- [ ] Add `N8N_PROD_INSTANCES` to `.env.example` with clear comments
- [ ] Unit tests: stable hash returns same instance for same user across calls; different users distributed across instances

**QA — Unit + E2E Tests:**
- [ ] User A's chat consistently hits instance 1; user B consistently hits instance 2 (when 2 configured)
- [ ] Single-instance config still works (backward-compat)
- [ ] Removing an instance from config doesn't break users (failover logs warning)

**Definition of Done:**
- [ ] Router works in single-instance and multi-instance modes
- [ ] Unit tests passing

#### S13-4: Workflow sync across instances (5 pts) | P1

**Developer Tasks:**
- [ ] `scripts/sync-workflows-across-instances.sh`:
  - Parameterized: `--tier=prod|dev`, `--source-instance=<URL>`, `--target-instances=<URL,URL,...>`
  - Exports workflows from source via n8n API
  - For each target: PATCHes matching workflows (by name) — preserves target workflow IDs
  - Dry-run flag shows what would change
  - Logs to `workflows/sync-log.md`
- [ ] Extend `scripts/promote-dev-to-v2.sh` to invoke sync after promotion (so promoting Dev → V2 updates ALL prod instances)
- [ ] Update `docs/workflow-governance.md` with multi-instance sync procedure

**QA — Unit + System Tests:**
- [ ] Dry-run against identical instances → "no changes" report
- [ ] Actual sync across 2 test instances → both end up identical after run
- [ ] Sync logs entries correctly

**Definition of Done:**
- [ ] Multi-instance sync working
- [ ] Promotion invokes it automatically
- [ ] Docs updated

#### S13-5: DNS cutover from external n8n to Railway (5 pts) | P0

**Developer Tasks:**
- [ ] Final verification: Railway `n8n-prod` fully operational, all workflows imported, all credentials working
- [ ] Update `n8n.agileadautomation.com` DNS to point at Railway (was pointing at external infra)
- [ ] Brief window where both old and new n8n are reachable (during DNS propagation)
- [ ] Monitor webhook delivery for 24 hours post-cutover (n8n execution log, Postal delivery log)
- [ ] After 24h stable: decommission the external n8n host
- [ ] Update MEMORY.md, CLAUDE.md with new infrastructure notes

**QA — E2E Tests:**
- [ ] Full chat → chapter write flow against Railway-hosted n8n completes end-to-end
- [ ] All V2 workflow integration tests from earlier sprints still pass
- [ ] Newsletter sprint workflows still function (Postal, ingestion, approvals)

**Definition of Done:**
- [ ] DNS pointing at Railway
- [ ] External n8n host decommissioned (or in standby)
- [ ] 24-hour stability window complete
- [ ] No regressions in any V2 workflow

### Sprint 13 totals: 34 pts (5 stories)

### Dependencies
- Sprint 10.a complete (Dev tier Supabase + Dev hub)
- Sprint 10.b complete (Redis) — not strictly required but helpful for observability
- Note: This sprint does NOT require queue mode. Scaling beyond one prod instance comes from deploying additional standalone instances (S13-3 router handles partitioning).

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
| 10 | ✅ complete (S10-5 validated via PRs #2, #4; S10-6 consolidated into 10.a) | 34 |
| 10.a | in progress (S10a-1 done 2026-04-19; +S10a-0 CI/CD verification added) | 49 |
| 10.b | planned | 34 |
| 8 | planned (carried) | 55 |
| 9 | planned (carried) | 47 |
| 11 | planned | 21 |
| 12 | planned — expanded 2026-04-20 (+S12-0 Eve hotfix + rewrite tool) | 57 |
| 13 | planned — refreshed 2026-04-20 (independent instances, not queue mode) | 34 |
| 14 | planned | 34 |
| 15 | planned | 34 |
| **Total remaining** | | **365 pts** |

At 34 pts/sprint (2-week cadence), that's **~21 weeks (10-11 sprints) of work**. 10.a is a 3-week sprint at 49 pts. 12 is a 3-week sprint at 57 pts. Product-facing sprints (8, 9) can run in parallel with infrastructure sprints since they touch different layers.

---

## Out of scope (future sprint documents)

- **Newsletter Agent calendar-driven release** — companion to the Newsletter Agent Migration sprint; releases `status='scheduled'` newsletters on their `scheduled_send_at`
- **CRM integration** (GoHighLevel or other) — revisit once product is established
- **Multi-region deployment**
- **Web UI for subscriber management**
- **Analytics dashboard** (opens, clicks, unsubscribes, content performance)
- **API for external integrations** (public REST API with API key auth)
