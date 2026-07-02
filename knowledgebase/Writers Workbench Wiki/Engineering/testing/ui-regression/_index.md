---
name: UI Regression Suite (run after every sprint)
description: The authoritative, no-gaps UI + engine regression plan — every page, every button, its expected result, and the covering Playwright test. Run after every sprint.
type: index
last_reviewed: 2026-07-02
---

# UI Regression Suite — run this after every sprint

> **Result-asserting upgrade (2026-07-02):** the suite now PROVES each function worked (DOM result + DB
> row), data-isolated per test — see **[[result-asserting-suite]]** (harness + modules + the 3 real
> backend bugs it already found and fixed). New/upgraded specs supersede the older presence-only ones.


This is the **authoritative regression plan** for the Writer's Workbench UI. It was built from a
verified inventory of `writers-workbench/client/src/App.tsx` + every route component (not a summary),
and every element listed here has a **covering Playwright test** in `writers-workbench/e2e/regression/`.
The engine side is covered by the [[engine-chat-e2e-suite]] (157 tests via chat + voice).

## How to run (against DEV — no local servers)

```bash
cd writers-workbench
export E2E_BASE_URL='https://writersworkbench-develop.up.railway.app'
export E2E_TEST_EMAIL='eric@agileadtesting.com'
export E2E_TEST_PASSWORD='Fr332bafami!y'
export SUPABASE_URL='https://gvbvwcnmjkdpclcisqrr.supabase.co'
export VITE_SUPABASE_ANON_KEY='<DEV anon key from Railway WritersWorkbench develop>'
# Optional — deterministic chapter/content picking for content-detail specs:
export E2E_SUPA_URL="$SUPABASE_URL"
export E2E_SUPA_SERVICE_KEY='<DEV service-role key from engine/.env>'
export E2E_USER_ID='+14105914612'

npx playwright test e2e/regression --project=chromium
```

The `chromium` project depends on `auth.setup.ts`, which seeds the session via the Supabase
password-grant path when `E2E_BASE_URL` is set. Run engine tests separately with
`scripts/e2e_full_verify.py` (see [[engine-chat-e2e-suite]]).

## Coverage map — one page per feature area

Each page lists: routes covered, every interactive element + its expected result, the stable Playwright
selector, and the covering spec file. `FINDINGS` records real UI bugs/quirks discovered while building
the suite (fixed ones are marked ✅).

- [[nav-and-shell]] — AppShell sidebar/topbar, every-route render gate, guarded-route access control. Spec: `regression/nav-render.spec.ts`.
- [[auth-onboarding]] — login/signup/forgot/reset/onboarding + PricingCards. Spec: `login.spec.ts` (existing) + notes here.
- [[dashboard-projects]] — Dashboard, ProjectList, ProjectEditForm. Spec: `regression/nav-render.spec.ts` + `project-detail.spec.ts`.
- [[project-detail]] — `/projects/:id` all 9 tabs + modals. Spec: `regression/project-detail.spec.ts`.
- [[content-detail]] — `/content/:id` editor, lifecycle, QA/annotations, versions, rewrite modal. Spec: `regression/content-detail.spec.ts`.
- [[library-and-reference]] — Content Library, Research, Brainstorm, Outlines, Story Arcs, Genres, Sources, Cost, Credits, Trash, Settings. Specs: `regression/library.spec.ts`, `reference.spec.ts`, `settings.spec.ts`.
- [[story-bible-and-images]] — `/projects/:id/bible` StoryBiblePanel + EntryForm, `/images/:id` ImageDetail, ImageGallery. Spec: covered via `project-detail.spec.ts` (Art tab) + notes here.
- [[newsletter-ui]] — all `/newsletter/*` routes. Spec: `regression/newsletter.spec.ts`.
- [[eve-voice-widget]] — the ElevenLabs ConvAI voice widget in the Workbench + the DEV demo-agent→engine wiring (pinned to the demo account). Spec: `regression/eve-voice-widget.spec.ts`.
- [[admin-superuser]] — `/admin/*`, `/superuser/*` (access-gated). Spec: `regression/nav-render.spec.ts` (guarded-route block) + notes here.

## Cross-cutting findings (worth fixing over time)

See each area page for the full list. The highest-signal ones:

- ✅ **RewriteWithResearchModal** had no `role="dialog"`/`aria-modal` — fixed 2026-07-02.
- **Unlabeled inputs** (no `htmlFor`/`id`) across ProjectEditForm, EntryForm, GenreForm, StoryArcForm,
  BrainstormForm, Settings, EditionEditor — `getByLabel` is unreliable; specs use `getByPlaceholder`/role.
- **Icon-only buttons with no accessible name**: ContentDetail image-picker close X, ImageDetail
  remove-reference, ImageGallery thumbnail cards (`<div>`, not button/link). a11y + selector fragility.
- **Newsletter dead controls**: Generate template-override is never sent; Setup→Generate `?edition=`
  param is ignored; HelpButton footer doc link likely 404. See [[newsletter-ui]].
- **Hidden pager threshold**: shared `Pagination` renders nothing (and no page-size select) at ≤10 items.
- **Hard vs soft deletes**: story-arc + genre deletes are permanent (no trash); content/research/project
  deletes are soft (restorable via `/trash`).

See [[log]] for the change history of this suite.
