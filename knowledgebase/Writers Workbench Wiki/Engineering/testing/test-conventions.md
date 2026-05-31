---
name: Test conventions
description: CLAUDE.md testing rules + per-sprint test conventions + page object pattern.
type: concept
tags: [testing, conventions]
last_reviewed: 2026-05-09
---

# Test conventions

Codified in `CLAUDE.md` rules 10-14 and per-sprint memory entries.

## Rule 10 — Every-element coverage

> E2E tests must cover every screen element. Every sprint must include authenticated E2E tests that exercise every page, button, dialog, link, tab, dropdown, and data display. Test for `[object Object]` on every page. Test error states render human-readable messages. Shallow redirect-only tests are insufficient.

Example pattern:
```ts
test('content detail renders all sections', async ({page}) => {
  await page.goto('/content/abc123');

  // Page header
  await expect(page.getByRole('heading')).toBeVisible();

  // Editor
  await expect(page.locator('.ProseMirror')).toBeVisible();

  // Status badge
  await expect(page.getByTestId('status-badge')).toBeVisible();

  // Side panels (chapters only)
  await expect(page.getByText(/sources/i)).toBeVisible();
  await expect(page.getByText(/q\/?a report/i)).toBeVisible();
  await expect(page.getByText(/annotations/i)).toBeVisible();

  // No raw object dumps
  await expect(page.locator('body')).not.toContainText('[object Object]');
});
```

## Rule 11 — Real data shape

> Tests must verify against real data, not assumed types. Before writing any component that renders database data, query the actual Supabase table to inspect the real data shape. Never assume the TypeScript type matches reality — the n8n workflows define the data structure, not the frontend types.

Example: `published_content_v2.metadata` is JSONB. The TypeScript type might say:

```ts
type Metadata = {
  schedule_date?: string;
  qa_report?: object;
};
```

But reality includes:
- `dismissed_annotations: string[]` (Sprint 12)
- `last_rewrite: {research_report_id, rewritten_at, citations_in_prose}` (Sprint 12)
- `genre_eval: {prose_adaptations, outline_adaptations, observations}` (Sprint 12)
- `summary: string` (older n8n writes)
- `word_count: number` (older n8n writes)

If your component reads `metadata.summary` and the test fixture only has `metadata.schedule_date`, the test passes but the runtime path errors.

**Practice:** copy real rows from DEV Supabase as fixtures.

## Rule 12 — Test rendered functionality

> Tests must verify rendered functionality, not just code existence. Unit tests must validate that components actually work — clickable elements respond, expanded sections show content, queries fetch from the correct tables. Do not write tests that only check module exports or type compilation.

Bad:
```ts
import { ContentDetail } from './ContentDetail';
expect(ContentDetail).toBeDefined();   // passes; tests nothing
```

Good:
```ts
const { user } = renderWithProviders(<ContentDetail />);
await user.click(screen.getByRole('button', {name: /save/i}));
expect(supabaseMock.update).toHaveBeenCalledWith({content_text: '...'});
```

## Rule 13 — Visual correctness

> Every UI change must be E2E tested for visual correctness. When adding metadata (version numbers, dates, IDs, badges) to any screen, write an E2E test that navigates to that screen, scrolls to the element, and asserts the text is visible — not just that TypeScript compiles. Take a screenshot in the test for manual verification. If the element could be scrolled off-screen, the test must scroll to it.

Pattern:
```ts
test('chapter shows version badge', async ({page}) => {
  await page.goto('/content/abc123');
  await page.locator('.version-badge').scrollIntoViewIfNeeded();
  await expect(page.locator('.version-badge')).toContainText('v3');
  await expect(page).toHaveScreenshot('chapter-version-badge.png');
});
```

## Rule 14 — Versioned object metadata

> Version info must appear on every versioned object. Every screen that displays a versioned entity (outlines, content, projects, story bible entries, research reports, images) must show: created date, last updated timestamp, version number or revision count (if applicable), and a short ID. This metadata must be visible without scrolling to a different section or expanding a collapsed panel.

Audit your component for:
- `created_at` (date)
- `updated_at` (timestamp)
- Version number / revision count (if applicable)
- Short ID (e.g. last 6 chars of UUID)

E.g. `ContentDetail` shows: title, status, schedule date, last_rewrite timestamp, content version count.

## Per-sprint convention

Each sprint adds a `sprintN-qa.test.ts(x)` file in client + server. The file:

- Tests every story's acceptance criteria.
- Uses real Supabase row shapes as fixtures.
- Mocks dependencies (Postal, n8n, Anthropic).
- Expected to pass at sprint close.

Names always `sprintN-qa.test.ts`. Some files for cross-cutting features go by feature name (`s10b3-chat-queue.test.tsx`, `newsletter-pages.test.tsx`).

## Page Object Model (E2E)

`e2e/pages/<feature>.page.ts`. Each export class with:
- Selector helpers (`emailInput()`, `saveButton()`).
- Action methods (`async login(email, password)`).
- Waits/assertions encapsulated.

Keeps spec files readable + selectors centralized.

## Mocking

### Client

`vi.mock('@/config/supabase')` at top of test file:
```ts
vi.mock('@/config/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({data: {/*...*/}, error: null}),
    })),
  },
}));
```

Or use MSW for HTTP-level mocking when testing real network flows.

### Server

`server/src/test/fixtures/` has shared fakes. Pattern:
```ts
import { createSupabaseFake } from './fixtures/supabase-fake';
const supabase = createSupabaseFake();
supabase.tables.users_v2.set('+14105914612', {/* row */});
```

### Redis

`ioredis-mock` package. Auto-injected if test file mocks `ioredis`.

## TanStack Query in tests

Tests provide a fresh `QueryClient` per test:
```ts
const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
```

`retry: false` keeps tests fast. Without it, errors retry 3× = 3× slow.

`renderWithProviders` in `test-utils.tsx` does this automatically.

## Async waits

Prefer `await waitFor(() => ...)` over `await new Promise(r => setTimeout(r, 100))`. The former is event-driven; the latter is fragile.

## Test data lifecycle

Test data lives only in test files. Don't pollute DEV Supabase with test rows.

For E2E: tests run against DEV Workbench (which connects to DEV Supabase). DEV Supabase HAS test data — Eric and Horace. Tests can write to DEV but should clean up after.

## Common gotchas

- **Forgot `await user.click(...)`** — RTL `userEvent` is async. Without await, assertions race ahead.
- **`getByRole('button', {name:'Save'})` vs `getByText('Save')`** — prefer role+name; works with disabled/aria states.
- **`getByLabel` substring match** — use `{exact: true}` when label could match multiple elements (e.g. PasswordInput toggle).
- **Hard-coded URLs in tests** — use `baseURL` from playwright config.
- **Test data leaks across tests** — clear `queryClient` + reset mocks in `beforeEach`.
- **`window.matchMedia` undefined** — JSDOM polyfill in setup.ts.
- **Date / timestamp comparisons** — use `expect.stringMatching(/^\d{4}-\d{2}-\d{2}/)` for "any ISO date".
- **`supabase.auth.getUser` returns null in tests** without mocking → `requireAuth` returns 401 → 401 chains. Mock auth in setup.
