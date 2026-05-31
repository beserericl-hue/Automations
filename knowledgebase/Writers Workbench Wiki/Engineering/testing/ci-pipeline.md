---
name: CI pipeline
description: GitHub Actions jobs, required status checks, paths filter, secrets.
type: concept
tags: [testing, ci, github-actions]
last_reviewed: 2026-05-09
---

# CI pipeline

`.github/workflows/ci.yml` (Sprint 7).

## Jobs

| Job | Required on `main`? | Trigger | What it does |
|-----|---------------------|---------|--------------|
| TypeScript & Lint | yes | push, PR | `npm run typecheck` + `npm run lint` both workspaces |
| Unit Tests | yes | push, PR | `npm run test` both workspaces |
| Production Build | yes | push, PR | `npm run build` (Vite + tsc) |
| Schema Governance Check | yes | push, PR | `python3 scripts/check-base-table-immutability.py` + baseline-hashes verify |
| E2E Tests (Chromium) | NO | PR only (`if: github.event_name == 'pull_request'`) | `npx playwright test --project=chromium-noauth` + `chromium-authenticated`. Known flaky — Issue #3. |

Branch protection on `main`: 4 required status checks (TypeScript, Unit, Build, Schema). Admin push blocked. PR author can't self-approve (admin override is the documented escape hatch).

`develop`: 1 approving review. Same self-approve restriction. Admin override used in practice for stacked-PR chains.

## paths filter — gotcha

```yaml
on:
  pull_request:
    paths:
      - 'writers-workbench/**'
      - 'workflows/**'
      - 'scripts/check-base-table-immutability.py'
      - '.github/workflows/ci.yml'
      - 'CLAUDE.md'
```

**Scripts-only PRs to `main`** (e.g. `scripts/hotfix-*.py`) **don't trigger CI** and therefore can't satisfy `main`'s required-status-check gate.

**Workaround:** include a docs file under `writers-workbench/docs/` as part of any scripts-only hotfix targeting `main`. PR #71 used this — runbook served the purpose AND was genuinely useful.

## Schema Governance Check details

`scripts/check-base-table-immutability.py`:
1. Reads all migration files in `writers-workbench/migrations/`.
2. For each file numbered ≥008, parse SQL and check no `ALTER`/`DROP`/`RENAME` statement targets a base table (`users_v2`, `writing_projects_v2`, `published_content_v2`, `story_bible_v2`, `research_reports_v2`, `genre_config_v2`, `story_arcs_v2`, `content_versions_v2`, `outline_versions_v2`).
3. For files numbered 001-007, verify SHA-256 against `.baseline-hashes.json`. Any byte change fails.
4. Exit non-zero if violations.

Test runner: `scripts/test-check-base-table-immutability.sh` — sanity test against a known-bad sample to ensure the checker actually catches violations.

## Secrets

Required GH secrets:
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (for production build + E2E noauth dev server)
- `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD` (for authenticated E2E project)
- `RAILWAY_TOKEN` (if using Railway CLI in CI — currently unused; deploys are auto-from-branch)

DO NOT put service-role keys, Postal keys, etc. in CI. They're per-tier and only needed at runtime on Railway.

## Workflow file structure

```yaml
name: CI

on:
  push:
    branches: [main, develop]
    paths:
      - 'writers-workbench/**'
      - 'workflows/**'
      - 'scripts/check-base-table-immutability.py'
      - '.github/workflows/ci.yml'
      - 'CLAUDE.md'
  pull_request:
    branches: [main, develop]
    paths: <same>

jobs:
  schema-governance:
    runs-on: ubuntu-latest
    steps:
      - checkout
      - setup-python
      - run: python3 scripts/check-base-table-immutability.py

  typecheck:
    steps:
      - checkout
      - setup-node
      - run: cd writers-workbench && npm ci && npm run typecheck && npm run lint

  unit-tests:
    steps:
      - checkout
      - setup-node
      - run: cd writers-workbench && npm ci && npm run test

  build:
    steps:
      - checkout
      - setup-node
      - env:
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
        run: cd writers-workbench && npm ci && npm run build

  e2e-tests:
    if: github.event_name == 'pull_request'
    steps:
      - checkout
      - setup-node
      - run: cd writers-workbench && npm ci
      - run: npx playwright install --with-deps
      - env:
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
          E2E_TEST_EMAIL: ${{ secrets.E2E_TEST_EMAIL }}
          E2E_TEST_PASSWORD: ${{ secrets.E2E_TEST_PASSWORD }}
        run: cd writers-workbench && npx playwright test
      - name: Upload report on failure
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: playwright-report
          path: writers-workbench/playwright-report
```

## E2E test status

E2E is informational, not blocking, on `main`. Reasons:
- Flaky session-API tests (Sprint 5/6).
- Cookie consent banner sometimes blocks first interaction.
- Cloudflare-fronted DEV Workbench occasionally 524s on slow CI.

Issue #3 tracks improving. Run E2E locally before opening PR for high-confidence merges.

## When CI fails

| Job | Common causes | Fix |
|-----|---------------|-----|
| TypeScript & Lint | type drift, unused import | fix the type, run `npm run typecheck` locally |
| Unit Tests | flaky timing, mock drift | run `npm run test` locally; add `await waitFor(...)` for async UI |
| Production Build | missing `VITE_*` env var, large unused import | check Vite log; verify env vars set |
| Schema Governance | `ALTER` on base table, byte-changed migration 001-007, new file not following naming | fix migration; consult [[base-tables]] |
| E2E (informational) | flaky — retry or investigate Playwright trace | usually safe to ignore unless it's PR #40-style legitimate breakage |

## Deploy after CI

Merging to `develop` → DEV Railway auto-deploys (~3 min).
Merging to `main` does **NOT** deploy PROD. Manual step: `git push origin main:release/v1.0`.

See [[releases-and-tags]] for the full release runbook.

## Common gotchas

- **paths filter** silently skips CI on scripts-only PRs.
- **`if: github.event_name == 'pull_request'`** on E2E job means push-to-develop never runs E2E. Latent failures accumulate until next PR.
- **Secrets are scoped to repo, not env.** No need for separate DEV vs PROD CI secrets currently.
- **Railway deploy logs** are available via `railway logs` CLI or Railway dashboard. CI doesn't surface them.
- **Out-of-date `package-lock.json`** is the most common Build failure. Run `npm i` locally + commit lock changes.
