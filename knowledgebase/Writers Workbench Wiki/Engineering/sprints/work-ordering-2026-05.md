---
name: Work ordering — 2026-05
description: Week-of-2026-05-25 reorder of all open sprint work. Four hard gates — newsletter PROD ship → Sprint 15 testbed → Sprints 16-22 Python rewrite → Sprints 23-27 B2B platform → Sprint 9 Stripe last. Supersedes the 9→13→14→15→16→18 sequencing in [[planned-sprints]].
type: concept
tags: [sprints, planning, gating, work-ordering, 2026-05]
last_reviewed: 2026-05-25
---

# Work ordering — 2026-05

Authoritative ordering of open work as of 2026-05-25. Supersedes the "Recommended next sprint" section of [[planned-sprints]] (which still pointed at Sprint 9).

## Constraints (user mandate 2026-05-25)

1. **Prioritize Sprint 15** ([[sprint-15-testbed]]).
2. **Hold Sprint 9 (Stripe)** until Sprints 16-22 complete.
3. **Hold ALL PRs to `main`** until newsletter development is 100 % complete.
4. **B2B Author Agent API platform must ship** (Sprints 23-27 in [[python-migration-roadmap]]).
5. **Reorder everything else** to follow this development.

The four "gates" below are hard — work in a later gate may not begin until the prior gate's exit criteria are met, except for the small side tasks listed under "Interleaved" which are explicitly allowed in parallel.

## Gate 1 — Newsletter PROD ship (this week)

**Until this gate clears, no PR merges to `main`.** All work stays on `develop` or `feature/*`.

| # | Item | Why it's the gate | Effort |
|---|------|------|---|
| 1.1 | Run [`newsletter-fullflow.spec.ts`](../../../../writers-workbench/e2e/newsletter-fullflow.spec.ts) + [`sprint-regression-suite.spec.ts`](../../../../writers-workbench/e2e/sprint-regression-suite.spec.ts) against DEV; fix reds | Validates 13-section plan + cross-sprint regressions before promotion | 0.5 d |
| 1.2 | Merge PR #76 (E2E suite) into `develop` | Safety net before promoting newsletter to PROD | 0.25 d |
| 1.3 | **Review** PR #68 — NOT stale; carries migration 015 + render-html n8n swap. Either merge into `develop` or carve migration 015 + the render-html script into a fresh PR | Without this, PROD newsletter sends the legacy `<pre>markdown</pre>` body instead of the Course Worx template | 0.5 d |
| 1.4 | Apply migrations 013 / 014 / **015** / 016 / 017 to PROD Supabase | Newsletter cluster schema (see [[migrations]]); 015 = Workbench template body_md fallback zone | 0.5 d |
| 1.5 | Promote 6 newsletter n8n workflows DEV → PROD (cadence cron, ingestion multi-user cron, fan-out, bounce auto-flip, CSV import, re-enable) | PROD UI needs the workflows behind it | 1 d |
| 1.6 | Seed PROD demo newsletter (`The Wasteland Wire` + 5 subscribers) | Smoke + marketing screenshots | 0.25 d |
| 1.7 | Run sprint-regression-suite read-only describes against PROD | Confirms promotion didn't break PROD | 0.25 d |
| 1.8 | Open `release/v-newsletter` → `main`, tag, merge `main` back into `develop` | **Gate 1 exit** | 0.5 d |

Exit criteria:
- All migrations applied, all workflows promoted, demo seed exists, PROD smoke green.
- Release tag pushed; `main` and `develop` reconciled.
- After this, PRs to `main` become unblocked again — but only Sprint 15 and gate-2 work should be filing them.

## Gate 2 — Sprint 15 (testbed)

Full plan: [[sprint-15-testbed]]. Prioritized over everything else once Gate 1 clears.

| # | Phase | Effort |
|---|------|---|
| 2.1 | Phase 1: standalone testbed Supabase + schema clone + orchestrator skeleton + n8n-test-1 | ~1 wk |
| 2.2 | Phase 2: 5 DEV workflows cloned to TEST tier + 4 chapter-writer LLM variants (Sonnet / Haiku / Hybrid-Draft-Polish / Hybrid-Smart) | ~1 wk |
| 2.3 | Phase 3: Q/A engine + gold-standard rubric on 50 DEV chapters | ~1 wk |
| 2.4 | Phase 4: n8n-test-2/3 + sticky LB + k6 collapse tests + LLM bake-off synthesis report | ~1 wk |

Exit criteria — Sprint 15 synthesis report answers all four questions:
1. Which LLM strategy meets quality bar at scale.
2. Where the platform breaks (N concurrent users).
3. How it fails under load (graceful vs cascade).
4. When Anthropic Tier 4 is actually required.

Sprint 15 output **feeds Gate 3 directly** — the bake-off winner determines hub LLM in Sprint 18, and the collapse-point numbers determine arq worker counts.

## Gate 3 — Python backend rewrite (Sprints 16-22)

Full plan: [[python-migration-roadmap]] Sprints 16-22 and [[architecture/python-backend/master-plan]]. n8n stays running as production through this whole phase; cutover is gated on Sprint 15 bake-off + per-sprint shadow comparisons.

| # | Sprint | Module | Effort |
|---|------|------|---|
| 3.1 | 16 | Service skeleton — modular monolith, 4 service groups (api-svc / worker-heavy / worker-light / worker-cron), arq + Redis | ~1.5 wk |
| 3.2 | 17 | API contracts + auth boundary (replaces hub webhook surface) | ~1 wk |
| 3.3 | 18 | Hub migration to Python (LLM choice from Sprint 15 bake-off; default assumption Claude Haiku 4.5) | ~1.5 wk — **revisit estimate post-2.4 bake-off; bumps to ~2.5 wk if Sonnet 4.6 wins** |
| 3.4 | 19 | Heavy workers: write-chapter, brainstorm, scrape | ~1.5 wk |
| 3.5 | 20 | Light workers: list / get / approve / version | ~1 wk |
| 3.6 | 21 | Cross-chapter continuity (NEW capability — leverages new arch) | ~1.5 wk |
| 3.7 | 22 | Observability + deployment: OTel, dashboards, Railway services per group | ~1 wk |

Exit criteria — Python backend is the production path for 100 % of traffic; n8n hub + tool workflows archived.

## Gate 4 — B2B Author Agent API platform (Sprints 23-27)

Full plan: [[python-migration-roadmap]] Sprints 23-27 and [[architecture/python-backend/productization]]. Cannot begin until Gate 3 clears — the platform IS the Python backend.

| # | Sprint | Module | Effort |
|---|------|------|---|
| 4.1 | 23 | Dual-schema multi-tenancy (tenant_id partitioning, RLS) | ~1.5 wk |
| 4.2 | 24 | API key system (Argon2id, scoped permissions, rotation) | ~1 wk |
| 4.3 | 25 | 5 subscription tiers + usage metering | ~1 wk |
| 4.4 | 26 | Public OpenAPI + Python / TS SDKs | ~1 wk |
| 4.5 | 27 | Developer portal + docs site | ~1 wk |

Exit criteria — Author Agent API publicly callable by paying customers under their own credentials and quotas.

## Gate 5 — Sprint 9 (Stripe billing)

Held per user mandate until Gate 4 exits. Stripe only makes sense once:
- Tiers + metering exist (Sprint 25).
- The API is the product (Sprint 27).
- Internal Workbench billing reuses the same Stripe layer the B2B platform exposes.

Full Sprint 9 story list remains in [[planned-sprints]].

## Interleaved — small side tasks (allowed in parallel)

These do not block any gate and can be picked up in idle slots. None of them touch `main` unless Gate 1 has already cleared.

- **Auth Site URL fix** on both Supabase projects (factory localhost:3000 still set) — ~30 min.
- **`CRON_SECRET` env var** on both Railway services (Dev + PROD) — ~10 min.
- **Google OAuth provider** configuration — ~1 h.
- **Auto-trial on signup skip** — small bug, fold into the next newsletter sub-PR before Gate 1 closes.
- **5 wiki Postal-doc rewrites** (correct one-server model; see [[postal-mail-stack]]) — ~1 h.
- **27-file DEV-URL consolidation PR** (already in working tree) — small separate PR to `develop`, this week.
- **Eve KB cleanup cron** — delete documents older than X days. Whenever convenient.
- **Annotation `_scanner_exclusions` UI** — currently JSONB-only edit. Whenever convenient.
- **Cron health dashboard** for `newsletter_ingestion_runs_v2` — Gate-1-adjacent but not blocking.

## Concrete week — 2026-05-25 → 2026-05-29

| Day | AM | PM |
|-----|----|----|
| Mon 5/25 | 1.1 — run E2E suites, fix reds | 1.2 — merge PR #76; 1.3 — review PR #68 (merge or carve out migration 015); kick off 2.1 in background |
| Tue 5/26 | 1.4 — migrations 013/014/015/016/017 to PROD | 1.5 — promote 6 newsletter n8n workflows |
| Wed 5/27 | 1.6 — PROD demo seed | 1.7 — PROD read-only regression smoke |
| Wed 5/27 EOD | 1.8 — release PR + tag + merge `main` back to `develop` — **Gate 1 clears** | — |
| Thu 5/28 | Interleaved cluster: auth Site URL, CRON_SECRET, Google OAuth | Interleaved cluster: Postal wiki rewrites, URL-consolidation PR |
| Fri 5/29 | 2.1 — testbed Supabase + schema clone | 2.2 start — TEST-tier workflow clones |

## Calendar-level horizon

- **Week of 2026-05-25**: Gate 1 closes mid-week; Gate 2 starts late-week.
- **Weeks of 2026-06-01 → 2026-06-22**: Gate 2 (Sprint 15) runs ~4 weeks per [[sprint-15-testbed]].
- **2026-06-23 → ~2026-09-30**: Gate 3 (Sprints 16-22) — ~10 wk firm + buffer.
- **2026-10 → ~2026-12**: Gate 4 (Sprints 23-27) — ~5.5 wk firm + buffer for beta.
- **2027-Q1**: Gate 5 (Sprint 9) — Stripe over the now-existing tier + metering layer.

Dates slip; the **ordering** is the contract, not the dates.

## What this overrides in other pages

- [[planned-sprints]] "Recommended next sprint" section is now wrong (it says Sprint 9 next). Updated to point here.
- [[python-migration-roadmap]] Phase A "unblocks Sprint 9 paid-seat launch" framing is loosened — Sprint 9 now waits until after Phase E (B2B platform GA), not just Phase A.
- [[design-feasibility]] sequencing intent remains valid; the empirical numbers it asks for come from Gate 2.

## Revisit triggers

Re-evaluate this ordering if any of the following happens:

- Gate 1 misses its mid-week target — re-baseline before starting Gate 2.
- Sprint 15 bake-off (2.4) returns a surprising LLM winner — adjust Sprint 18 estimate per the inline note, and re-cost Gates 3-4.
- A PROD incident requires a hotfix — hotfix path stays open via `hotfix/*` → `main` regardless of these gates (per [[hotfix-flow]]).
- User priorities change — re-file an updated `work-ordering-YYYY-MM.md` page.
