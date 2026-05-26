# Newsletter Full-flow + Sprint Regression E2E

Two Playwright specs added in this PR:

- `e2e/newsletter-fullflow.spec.ts` — automated coverage of the 13 sections of [`writers-workbench/docs/newsletter-test.md`](../docs/newsletter-test.md) (the 114-test manual plan).
- `e2e/sprint-regression-suite.spec.ts` — cross-sprint regression covering Sprint 8 / 10b / 11 / 12 features plus the newsletter cluster and cross-cutting UX.

Both run in the existing `chromium` (authenticated) project. Auth uses storage state seeded by `e2e/auth.setup.ts` from `E2E_TEST_EMAIL` + `E2E_TEST_PASSWORD`.

## Run locally (local Vite dev server)

```bash
cd writers-workbench
# .env already has E2E_TEST_EMAIL=eric@agileadtesting.com + E2E_TEST_PASSWORD
npx playwright test newsletter-fullflow.spec.ts --project=chromium
npx playwright test sprint-regression-suite.spec.ts --project=chromium

# Or both
npx playwright test newsletter-fullflow sprint-regression-suite --project=chromium

# Headed for visual debugging
npx playwright test newsletter-fullflow.spec.ts --project=chromium --headed
```

The webServer block in `playwright.config.ts` automatically starts the local dev client on port 5173.

## Run against deployed DEV (`writersworkbench-develop.up.railway.app`)

```bash
cd writers-workbench
E2E_BASE_URL=https://writersworkbench-develop.up.railway.app \
E2E_TEST_EMAIL=eric@agileadtesting.com \
E2E_TEST_PASSWORD=Fr332bafami!y \
SUPABASE_URL=https://gvbvwcnmjkdpclcisqrr.supabase.co \
VITE_SUPABASE_ANON_KEY=sb_publishable_tWjSepIO8xym2ZcfYHP-vQ_OiBPx2Dp \
  npx playwright test newsletter-fullflow sprint-regression-suite --project=chromium
```

When `E2E_BASE_URL` is set, `auth.setup.ts` uses the Supabase password-grant API path (more reliable than the UI login form against deployed instances).

## Run against PROD (read-only checks only)

Same as DEV but with the PROD values. **The regression suite includes write-path tests — do NOT point these at PROD without limiting to read-only describe blocks.** Recommended PROD run:

```bash
# Only the route-smoke describe — pure GETs, no writes
E2E_BASE_URL=https://writersworkbench-production.up.railway.app \
E2E_TEST_EMAIL=... E2E_TEST_PASSWORD=... \
SUPABASE_URL=https://faklxfakgzkpkbxfihzh.supabase.co \
VITE_SUPABASE_ANON_KEY=sb_publishable_HsIkelEZaIr0VauiB3GgIQ_59XJRoWc \
  npx playwright test sprint-regression-suite.spec.ts -g 'Authenticated route smoke' --project=chromium
```

## What's covered

### `newsletter-fullflow.spec.ts` — 13 sections

| Section | Tests | Maps to |
|---|---|---|
| 0. Pre-flight | 3 | T-00.* — sign-in, /api/health, sidebar |
| 1. Editions list | 6 | T-01.1..6 — list, help drawer, show-disabled toggle |
| 2. Create + setup wizard | 3 | T-02.* — new-edition route, form fields, wizard |
| 3. Edition editor | 3 | T-03.* — genre dropdown, signature fields |
| 4. Feeds list | 2 | T-04.* — feeds route, manage-feeds link |
| 5. Subscribers | 1 | T-05.* — subscriber UI surface |
| 6. Templates | 4 | T-06.* — list, new template, default templates |
| 7. Generate | 2 | T-07.* — generate page, edition picker |
| 8. Approvals | 2 | T-08.* — pending approvals + empty state |
| 9. Sends | 2 | T-09.* — scheduled sends + detail |
| 10. Ingestion browser | 3 | T-10.* — page renders, date controls, deep-link |
| 11. Cron observations | 2 | T-11.* — recent runs + 3 tiles on NewsletterHome |
| 12. Bounces | 1 | T-12.* — admin email-bounces tab |
| 13. Edge cases | 4 | T-13.* — bad tokens, bad IDs, catch-all redirects, [object Object] checks |

### `sprint-regression-suite.spec.ts` — by sprint

| Sprint | Coverage |
|---|---|
| **Sprint 8** (RBAC + tiers + credits + impersonation) | Sidebar credits pill, /credits page, Settings tier panel, Admin tabs, Superuser panel |
| **Sprint 10b** (BullMQ + SSE) | ChatDrawer toggle, drawer opens with input |
| **Sprint 11** (Postal) | Admin Email Bounces tab |
| **Sprint 12** (chapter tools) | ContentDetail TipTap editor, cover-image banner, side panels (Sources / Q/A / Annotations), Rewrite-with-Research modal, AnnotationsPanel Apply/Dismiss, Story Bible tab on project |
| **Newsletter cluster** | All 7 newsletter routes load without [object Object]; legacy /newsletters redirects |
| **Cross-cutting (S2/S6/S7)** | Dark mode toggle, Cmd+K search, breadcrumb title resolution, Replay Tutorial button, Pagination controls |
| **Authenticated route smoke** | All 19 authenticated routes load without crash + no [object Object] |

## Robustness conventions

These specs are intentionally tolerant of missing demo data:

- Tests that need an existing project/chapter/edition use `test.skip(true)` if none are present rather than failing.
- Selectors prefer `getByRole`/`getByLabel` over CSS classes (which change with refactors).
- Assertions favor "panel renders" / "text contains keyword" over exact strings.
- `[object Object]` and "Something went wrong" boundaries are checked broadly as crash detectors.
- Helper `gotoFirstProject` / `gotoFirstChapter` short-circuit gracefully when the user has no data.

## Seeding demo data for full coverage

For maximum coverage, seed the demo project + edition described in [`knowledgebase/Writers Workbench Wiki/Engineering/marketing-copy.md`](../../knowledgebase/Writers%20Workbench%20Wiki/Engineering/marketing-copy.md) Section 2:

- Project: "The Last Signal" (post-apocalyptic, Hero's Journey)
- Newsletter edition: "The Wasteland Wire" with 5 placeholder subscribers
- One chapter with a deliberate "Maya Chan" drift to test the annotation Apply path

Without seeding, ~80% of tests still run (the route + smoke checks). With seeding, the data-dependent tests light up too.

## Notes for CI

- `E2E_BASE_URL` not set in CI → tests use the local Vite dev server (already wired in `playwright.config.ts` webServer block).
- For CI runs against deployed DEV, add `E2E_BASE_URL` + `SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` to GitHub Actions secrets and inject into the `e2e-tests` job.
- The existing CI workflow's `paths` filter already includes `writers-workbench/**` so this PR triggers CI on every push.
