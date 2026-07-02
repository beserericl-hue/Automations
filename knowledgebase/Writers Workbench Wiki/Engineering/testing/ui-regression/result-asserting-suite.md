---
name: Result-asserting regression suite (assert results, not clicks)
description: The upgraded regression suite that proves each function actually worked (DOM result + DB row), data-isolated per test. Modules, harness, bug records, and the run-after-every-sprint plan.
type: reference
last_reviewed: 2026-07-02
---

# Result-asserting regression suite

The rule: for every interactive element, capture BEFORE → act → **assert the real produced result** — the
DOM shows the actual output (not a spinner/empty state) **AND** the backing DB row/field changed; async
actions poll to completion first. Each test isolates its own data (create → assert → hard-delete) and
pins to the demo user `+14105914612`. A test that only asserts "element visible / click didn't throw" is
invalid.

## Harness — `e2e/pages/api.ts`
- `getToken()` / `apiClient()` — demo-user bearer for the real `/api` routes.
- `supaGet` / `supaDelete` — Supabase REST via **Node `fetch`** (the new `sb_secret_` service keys are
  rejected from browser-like clients like Playwright's request context — this bit us: `401 "Forbidden use
  of secret API key in browser"`).
- `seedEdition`-style helpers: `seedProject` / `seedContent` / `seedEdition(via API)` +
  `deleteProject` / `deleteContent` / `hardDeleteEdition` (children too — the `/api` DELETE for editions is
  only a soft delete, so teardown goes straight to the DB).

## Modules (green on DEV)

| Module | Spec | Proves (result + DB) |
|---|---|---|
| Newsletter Setup Wizard | `newsletter-wizard.spec.ts` | feed import grows list + `newsletter_feed_sources_v2` rows; Template step previews real HTML + default `newsletter_templates_v2` row; subscriber add → `newsletter_subscribers_v2` row |
| ContentDetail lifecycle | `content-lifecycle.spec.ts` | Approve/Publish/Reject flip `published_content_v2.status` on the exact seeded row + UI advances state |
| ProjectDetail Export | `project-export.spec.ts` | Export downloads a real non-empty `.docx` for an approved chapter (download event + file size) |

## Bugs found + fixed (all real, user-facing)
- ✅ **`import-from-genre` 500'd every call** — broken `onConflict` upsert with no matching unique
  constraint (`42P10`). The wizard "Copy N feeds" was dead. Fixed: code-dedup insert. (`newsletter-feeds.ts`)
- ✅ **CSV subscriber import** — identical broken upsert. Same fix. (`newsletter-edition-extras.ts`)
- ✅ **New editions had no default template** — wizard preview blank + generation would fail
  `NO_DEFAULT_TEMPLATE`. Fixed: seed a per-edition default template (clone system starter) on edition
  create. (`newsletter.ts`) Commit `6110b5d`.

## Run
```bash
cd writers-workbench && source <the DEV env from ../session_context.md>
npx playwright test e2e/regression --project=chromium
```

## Remaining modules (same methodology — the continuation)
newsletter-crud (EditionEditor save→DB, feeds CRUD, templates + live `/preview`, **generate + preview**,
**approvals approve/reject/revise + rendered preview**, sends+detail html, ingestion); project-detail
(**Generate Cover Art**→gallery+`generated_images_v2`, Outline/Chapters/Research/Social/Story-Bible/Cost
real results); content-detail async bars (**Run Q/A**→report checks display + `metadata.qa_report.checks`,
**AnnotationsPanel Apply**→`content_text` changes, VersionHistory, Rewrite-with-Research); library (bulk +
sort DB); reference (story-arcs/genres/brainstorm/research); account/auth. Each async action polls to
completion, then asserts the rendered result.
