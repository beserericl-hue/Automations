---
name: E2E tests
description: Playwright projects, spec files per sprint, auth setup, screenshot conventions.
type: concept
tags: [testing, e2e, playwright]
last_reviewed: 2026-05-09
---

# E2E tests

Playwright. Two projects defined in `playwright.config.ts`:
- `chromium-noauth` — runs without an authenticated session. Tests login redirect, 404, public pages.
- `chromium-authenticated` — uses `auth.setup.ts` to log in via `E2E_TEST_EMAIL` + `E2E_TEST_PASSWORD`, stores session, runs the rest.

Plus `firefox-noauth` and `firefox-authenticated` mirror — used for cross-browser coverage at sprint sign-off.

## Run commands

```bash
cd writers-workbench
npx playwright install         # first time only

# All projects (slow)
npx playwright test

# Single project
npx playwright test --project=chromium-noauth
npx playwright test --project=chromium-authenticated

# Single spec
npx playwright test e2e/sprint7-critical-paths.spec.ts

# UI mode
npx playwright test --ui

# Headed (visible browser)
npx playwright test --headed --project=chromium-noauth
```

## Auth setup

`e2e/auth.setup.ts` — logs in to DEV Workbench, stores `playwright/.auth/user.json` for the authenticated project.

```env
# .env (local)
E2E_TEST_EMAIL=eric@agileadtesting.com
E2E_TEST_PASSWORD=Fr332bafami!y
```

CI sets these via GitHub secrets.

## Spec files

| File | Project | What it covers |
|------|---------|---------------|
| `e2e/login.spec.ts` | noauth | Login page renders; redirect to /login when not signed in |
| `e2e/auth.setup.ts` | (setup) | Login storage state |
| `e2e/authenticated.spec.ts` | authenticated | App shell loads, dashboard renders, search works |
| `e2e/sprint2-navigation.spec.ts` | noauth | Legacy redirects, route table, mobile sidebar |
| `e2e/sprint3-crud.spec.ts` | authenticated | ProjectEditForm, EntryForm, ResearchDetail, schedule |
| `e2e/sprint5-observability.spec.ts` | authenticated | CostDashboard, ProvenancePanel, QAReportPanel, SourceBrowser |
| `e2e/sprint7-critical-paths.spec.ts` | authenticated | 60+ tests across 9 critical path groups |
| `e2e/chapter-outline-version.spec.ts` | authenticated | Outline versioning trigger, version history UI |
| `e2e/qa-button-verify.spec.ts` | authenticated | QAReportPanel button + render |
| `e2e/image-debug.spec.ts` | authenticated | Image generation flow |
| `e2e/capture-manual-screenshots.spec.ts` | authenticated | Screenshot generator for production user manual |

## Sprint 7 critical paths (60+ tests)

`e2e/sprint7-critical-paths.spec.ts` is the largest spec. 9 groups:

1. **Login + dashboard** — sign in, see counts, navigate.
2. **Genre CRUD** — create, edit, delete with cascade-warning.
3. **Project → chapter editing** — open project, switch tabs, edit chapter.
4. **Delete + trash + restore** — soft delete, see in trash, restore.
5. **Chat drawer** — open, send message, see Queued pill, see SSE update.
6. **Eve widget** — open popover, register session, unregister on close.
7. **Admin panel** — 7 tabs render, user list shows.
8. **Export** — KDP export dialog, generate .docx.
9. **Mobile responsive** — sidebar collapse below `lg` breakpoint.

Cross-cutting:
- Error-free navigation on all 11 routes.
- Dark mode toggle.
- Accessibility: tab order, focus rings.
- Story arcs + outlines pages render.

## Conventions

### Page Object Model

`e2e/pages/login.page.ts` is the start. Per-page helpers as Sprint 7+ specs grew. Pattern:

```ts
export class LoginPage {
  constructor(private page: Page) {}

  emailInput = () => this.page.getByLabel('Email');
  passwordInput = () => this.page.getByLabel('Password', { exact: true });   // PR #57: exact required
  submitButton = () => this.page.getByRole('button', {name: 'Sign in'});

  async login(email: string, password: string) {
    await this.emailInput().fill(email);
    await this.passwordInput().fill(password);
    await this.submitButton().click();
    await this.page.waitForURL('/');
  }
}
```

### Screenshot capture

`expect(page).toHaveScreenshot()` with sensible thresholds. Saved to `playwright-report/`. Per CLAUDE.md rule 13:

> Every UI change must be E2E tested for visual correctness. When adding metadata (version numbers, dates, IDs, badges) to any screen, write an E2E test that navigates to that screen, scrolls to the element, and asserts the text is visible — not just that TypeScript compiles. Take a screenshot in the test for manual verification.

### Headed + screenshot for visual verification

Default headless. Use `--headed` only when user explicitly asks ("I want to see this work in a browser"). Per memory `feedback_playwright_headless.md`.

## CI gotcha — env vars for noauth project

PR #40 surfaced this:

The `e2e-tests` job runs `npx playwright test --project=chromium-noauth` which spawns `npm run dev:client` (Vite dev server). The dev server initialises Supabase client. **Without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in env**, auth misbehaves and route guards inconsistently leave unauthenticated users on `/`, `/chapters`, etc. instead of redirecting to `/login`. All 18 noauth tests then fail with `15s timeout waiting for "The Writers Workbench" heading`.

**Fix (PR #40 commit `e0425b6`):** propagate the same env-var block already used by `npm run build` into the noauth playwright step.

**Latent for a long time** because the `e2e-tests` job has `if: github.event_name == 'pull_request'` — pushes to `develop` SKIP it, and develop's history shows `E2E Tests (Chromium): skipped` on every recent run. PR #40 was the first PR in a while to actually exercise it.

## Issue #3 — E2E known broken in CI

E2E is **not required** in branch protection. Several specs have been flaky on CI environment:
- 5 pre-existing flaky session-API tests in Sprint 6 set.
- Cookie consent banner sometimes blocks first interaction.
- Cloudflare-fronted Workbench dev server sometimes 524s on slow CI.

Status:
- Run E2E locally before opening a PR.
- Run on PR via `pull_request` trigger — informational, not blocking.
- Issue #3 tracks improving CI E2E reliability.

## CLAUDE.md rule 10 — every-element coverage

> E2E tests must cover every screen element. Every sprint must include authenticated E2E tests that exercise every page, button, dialog, link, tab, dropdown, and data display. Test for `[object Object]` on every page. Test error states render human-readable messages. Shallow redirect-only tests are insufficient.

Sprint 2-3-7 specs follow this pattern. New sprints should follow suit.

## Newsletter test plan

The 114-test manual QA plan is **not** automated. See [[newsletter-test-plan]] for the operator-driven manual checklist. Selected core flows have automated counterparts in `newsletter-*.test.tsx` (client) and `newsletter-*.test.ts` (server).

## Common gotchas

- **`getByLabel('Password')` matches BOTH input and toggle button** because PasswordInput's toggle has `aria-label="Show password"` which contains "Password". Use `getByLabel('Password', {exact: true})`.
- **`page.waitForURL('/')` immediately after click** can fail because route guards redirect to `/onboarding` first if user has no profile. Use `page.waitForURL(/\/(onboarding|$)/)`.
- **`{trace: 'on-first-retry'}`** in playwright.config.ts captures the trace ZIP for debugging.
- **Cookie consent banner** must be dismissed in setup or it blocks the first interaction.
- **Storage state** `playwright/.auth/user.json` expires when Supabase session expires (60-day default). Re-run setup if old.
- **Don't use `page.goto('http://localhost:5173')` in E2E** — Playwright config sets `baseURL`. Use `page.goto('/')`.
