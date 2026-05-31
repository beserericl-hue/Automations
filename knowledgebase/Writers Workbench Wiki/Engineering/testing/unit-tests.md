---
name: Unit tests
description: Vitest + React Testing Library. Per-sprint test inventory, mocks, and run commands.
type: concept
tags: [testing, unit, vitest]
last_reviewed: 2026-05-09
---

# Unit tests

Vitest on both client + server workspaces. ~430+ tests as of 2026-05-09.

## Run commands

```bash
# Both workspaces
npm run test                      # in writers-workbench/

# Individual
npm -w client run test
npm -w server run test

# Watch mode
npm -w client run test -- --watch

# Single file
npm -w client run test sprint8-qa
```

## Client tests

`writers-workbench/client/src/test/`. RTL + jsdom. 27+ test files.

| File | What it covers |
|------|---------------|
| `setup.ts` | Vitest setup — JSDOM, mocks, fetch polyfill |
| `test-utils.tsx` | Render with providers (Query, Auth, User, Toast, Router) |
| `sprint0-qa.test.ts` | Auth middleware, JWT validation |
| `sprint1-qa.test.ts` | Soft delete queries, FK cascade UI |
| `sprint2-qa.test.ts` | Pagination util, content type labels, route mapping |
| `sprint2.5-qa.test.ts` | Misc Sprint 2 follow-ups |
| `sprint3-qa.test.ts` | Forms (ProjectEditForm, EntryForm, StoryArcForm), Genre ArrayField |
| `sprint4-qa.test.ts` | ImageGallery, SocialMediaPanel, ContentDetail cover banner, ChatDrawer |
| `sprint5-qa.test.ts` | CostDashboard, Provenance, QAReport, SourceBrowser |
| `sprint6-qa.test.ts` | Theme, toast, skeletons, accessibility |
| `sprint7-qa.test.ts` | OnboardingTutorial 5-step flow |
| `sprint8-qa.test.tsx` | RBAC UI: PricingCards, ImpersonationBanner, Credits pill |
| `sprint8-gaps.test.tsx` | Edit User dialog, role dropdown |
| `s10b3-chat-queue.test.tsx` | ChatDrawer queued/processing/complete pills, SSE handling |
| `newsletter-pages.test.tsx` | EditionsList, EditionEditor, FeedsList, NewsletterDetail |
| `newsletter-approvals-pages.test.tsx` | PendingApprovals, ApprovalDetail token flow |
| `newsletter-templates-pages.test.tsx` | TemplatesList, TemplateEditor preview |
| `newsletter-events.test.tsx` | useNewsletterEvents hook |
| `newsletter-execution-status.test.tsx` | ExecutionStatus live SSE progress |

Common mocking patterns:
- `supabase` client mocked at module level via `vi.mock('@/config/supabase')`.
- `apiFetch` mocked or routed to MSW.
- `useUser`, `useAuth` mocked via context overrides in test-utils.

## Server tests

`writers-workbench/server/src/test/`. ~150+ tests across 30+ files.

| File | What it covers |
|------|---------------|
| `health.test.ts` | `/api/health` shape, dependency probes |
| `chat.test.ts` | Chat-proxy classify + dispatch |
| `s10b3-chat-queue.test.ts` | Async chat-proxy migration |
| `s10b4-concurrency.test.ts` | Per-user slot acquire/release; admin queue dashboard |
| `s10b5-session-store.test.ts` | Session-store + sse-pubsub |
| `queue.test.ts` | BullMQ Queue factory + named queue registry |
| `jobs.test.ts` | Jobs API (list, stats, detail, status, cancel) |
| `email.test.ts` | sendEmail + Postal mock + DRY_RUN_EMAIL |
| `rate-limit.test.ts` | Email rate limit (30/min/user) |
| `bounces.test.ts` | Email bounce handler + subscriber flip |
| `ingestion.test.ts` | 17 tests — upload/search/get + path traversal + FK violation + BLOB_MISSING |
| `approvals.test.ts` | Approval token generation + expiry + flow |
| `newsletter.test.ts` | Editions CRUD |
| `newsletter-multi-user.test.ts` | Multi-tenant feed sources, ingestion runs |
| `newsletter-sends.test.ts` | Sends list/detail/delete |
| `newsletter-templates.test.ts` | Templates CRUD + preview merge |
| `newsletter-approvals.test.ts` | Approval token-flow |
| `newsletter-simulate-run.test.ts` | End-to-end ingestion + compose simulation |
| `genres.test.ts` | Genre CRUD + cascade reference count |
| `brainstorm.test.ts` | Brainstorm route |
| `content-actions.test.ts` | 9 tests — rewrite-with-research enqueue, annotations GET/apply/dismiss/422 |
| `sprint0-qa.test.ts` | Auth middleware unit tests |
| `sprint3-qa.test.ts` | Account deletion, Zod schemas |
| `sprint5-qa.test.ts` | Session register/unregister, callback content-ready |
| `sprint6-qa.test.ts` | Admin metrics, workflows, storage stats |
| `sprint7-qa.test.ts` | Swagger config |
| `sprint8-qa.test.ts` | RBAC routes (credits, superuser, tiers, cron) |
| `sprint8-gaps.test.ts` | Role assignment edge cases |
| `sprint8-impersonate-write.test.ts` | Impersonation write proxy + audit append |

## Common mocks

### Supabase fake (server)

`server/src/test/fixtures/` has an in-memory Supabase fake. Tables stored as Maps. Storage mocked. Mocks the `.from(table).select(cols).eq(col, val).maybeSingle()` chain.

### Redis fake

`ioredis-mock` for Redis-dependent tests. Auto-injected when `vi.mock('ioredis')` at top of test file.

### Postal fake

`fetch` mocked at module level. Returns canned `{message_id}` for success or 4xx/5xx for error path tests.

## Test conventions (per CLAUDE.md rule 11-12)

- **Real-data shape, not assumed types.** Before testing a component that renders DB data, query the actual Supabase table to inspect the real data shape. Don't trust the TypeScript type — n8n workflows define data structure, not the frontend types.
- **Test rendered functionality, not module exports.** Every user-story acceptance criterion needs a test that would FAIL if the feature were broken or missing. Don't write tests that only check `import { foo } from './foo'`.
- **One acceptance criterion = one test.** If a story has 3 ACs, the file has at least 3 tests.

## Coverage gates

CI requires:
- All client unit tests pass.
- All server unit tests pass.
- TypeScript clean both workspaces (`tsc --noEmit`).
- Production build succeeds (`npm run build`).
- Schema governance check passes (`scripts/check-base-table-immutability.py`).

E2E is NOT required (Issue #3 — known broken in CI). See [[e2e-tests]] and [[ci-pipeline]].

## Adding a new test file

Pattern:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MyComponent } from '@/components/...';
import { renderWithProviders } from '@/test/test-utils';

describe('MyComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the title', () => {
    renderWithProviders(<MyComponent />);
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('saves on click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MyComponent />);
    await user.click(screen.getByRole('button', {name: /save/i}));
    expect(supabaseMock.from).toHaveBeenCalledWith('published_content_v2');
  });
});
```

Follow the per-sprint naming convention: `sprintN-qa.test.tsx` for sprint deliverables, `<feature>.test.ts` for cross-sprint utilities.

## Common gotchas

- **Forgot to mock `apiFetch`** — test makes real HTTP calls in jsdom (which fails). Use `vi.mock('@/lib/api-fetch')`.
- **`window.matchMedia` not defined** — JSDOM doesn't support. Polyfill in `setup.ts`.
- **`crypto.subtle` not defined** — same. Polyfill via `webcrypto` in `setup.ts`.
- **`structuredClone`** — newer node. Polyfill if needed.
- **TanStack Query cache** persists across tests — clear it in `beforeEach` via `queryClient.clear()`.
- **DOMPurify in jsdom** — works but slow on huge HTML. Cap test fixtures.
- **Zod refine** runs synchronously — async refine needs `parseAsync`.
