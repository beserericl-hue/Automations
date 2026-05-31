---
name: Frontend stack
description: React + Vite + TanStack Query + TipTap + TailwindCSS. Build, dev server, env vars, and SSE wiring.
type: concept
tags: [frontend, stack]
last_reviewed: 2026-05-09
---

# Frontend stack

`writers-workbench/client/`. Vite-built React 18 SPA, served from the Express server in production.

## Dependencies (high level)

| Package | Why |
|---------|-----|
| `react@18`, `react-dom@18`, `react-router-dom@6` | UI + routing |
| `@tanstack/react-query` | Data fetching + cache. Drives almost every list/detail. |
| `@supabase/supabase-js` | Direct Supabase client. Auth + RLS-scoped reads. |
| `@tiptap/react` + `@tiptap/starter-kit` + `@tiptap/extension-link` + `@tiptap/extension-placeholder` | Rich text editor. |
| `marked` | Markdown → HTML for content_text rendering before editor load. |
| `dompurify` | Sanitize HTML before TipTap insertion (added Sprint 0). |
| `tailwindcss` + `@tailwindcss/typography` | Styling. `darkMode: 'class'` (Sprint 6). |
| `lucide-react` | Icons. |
| `vite` + `@vitejs/plugin-react` | Build tool + dev server. |
| `vitest` + `@testing-library/react` + `jsdom` | Unit tests. |

No `@elevenlabs/react`. We tried it; switched to the CDN embed widget (`<elevenlabs-convai>`) after WebRTC/LiveKit 404 errors. See [[chat-and-eve]].

## Vite config

- Dev server: port `5173`, proxies `/api/*` → `localhost:3001` (Express).
- Build output: `client/dist/`. Express serves it via `express.static` in production.
- Env vars: only `VITE_*` prefixed are exposed to the bundle. List in [[env-vars-by-tier]].

## Bootstrapping

```
main.tsx
  → ReactDOM.createRoot(document.getElementById('root')!)
  → <BrowserRouter><QueryClientProvider><App /></QueryClientProvider></BrowserRouter>

App.tsx
  → ToastProvider
    → AuthProvider
      → Routes:
          /login, /signup, /forgot-password, /reset-password, /onboarding (public)
          /* (guarded by AuthGuard → UserProvider → AppShell)
```

See [[routing]] for the full route table.

## State management

- **Server state** → TanStack Query (`useQuery`, `useMutation`).
- **Auth + user profile** → React Context (`AuthContext`, `UserContext`). UserContext exposes `isImpersonating`, `impersonateAs(targetId)`, `endImpersonation()`.
- **Theme** → `useTheme()` hook + `localStorage`. Toggle in TopBar.
- **Toasts** → `useToast()` hook + `ToastProvider`.
- **Chat history** → `localStorage` (capped at 100 msgs). Active job IDs persist so a refresh restores Queued/Processing pills.

No Zustand or Redux — Context + TanStack Query handles everything.

## Auth flow

```
Supabase Auth (email/password + Google OAuth gated by VITE_GOOGLE_OAUTH_ENABLED)
   → AuthContext sets session
   → UserProvider loads users_v2 row by supabase_auth_uid
   → if no row → /onboarding
   → onboarding step 1: profile (display_name, recipient_email, bcc_email)
   → onboarding step 2: tier selection via PricingCards (POST /api/account/subscribe)
   → AppShell renders
```

See [[auth-and-impersonation]].

## SSE wiring (one EventSource per session)

```
AppShell.tsx
  → on mount: const es = new EventSource('/api/callback/events?token=...')
  → es.onmessage handles {type, ...payload} → window.dispatchEvent(new CustomEvent('app-sse', {detail}))
  → ChatDrawer + IngestionBrowser + others addEventListener('app-sse', handle)
  → on unmount: es.close()
```

Event types from server:
- `content-ready` — chapter/blog/newsletter just finished writing.
- `job-status` — BullMQ state change for a tracked job.
- `newsletter:approval-changed` — approval status flipped.
- `newsletter:execution-status` — composer progress for live status panel.
- `eve:loaded` — Eve has injected content into KB and started the call.

## Key components by feature area

| Feature | Folder | Top components |
|---------|--------|----------------|
| Auth | `components/auth/` | LoginPage, SignupPage, ForgotPasswordPage, ResetPasswordPage, OnboardingPage, AuthGuard, PricingCards |
| Layout | `components/layout/` | AppShell, Sidebar, TopBar, ImpersonationBanner, TrialBanner |
| Dashboard | `components/dashboard/` | Dashboard (skeleton + real cards), StatusBadgeIcon |
| Projects | `components/projects/` | ProjectList, ProjectDetail (8 tabs), ProjectEditForm |
| Content | `components/content/` | ContentLibrary, ContentDetail (TipTap), ProvenancePanel, QAReportPanel, AnnotationsPanel, SourceBrowser |
| Story bible | `components/story-bible/` | StoryBiblePanel, EntryForm |
| Story arcs | `components/story-arcs/` | StoryArcBrowser, StoryArcForm |
| Research | `components/research/` | ResearchList, ResearchDetail |
| Genres | `components/genres/` | GenreList, GenreForm (ArrayField w/ reorder + URL validation) |
| Outlines | `components/outlines/` | OutlineList, VersionHistory |
| Brainstorm | `components/brainstorm/` | BrainstormForm |
| Editor | `components/editor/` | RichTextEditor, EditorToolbar |
| Export | `components/export/` | ExportDialog, PageSizeSelector |
| Cost | `components/cost/` | CostDashboard |
| Images | `components/images/` | ImageGallery, ImageDetail |
| Social | `components/social/` | SocialMediaPanel |
| Chat | `components/chat/` | ChatDrawer (resizable) |
| Eve | `components/eve/` | EveOrb, EveWidget |
| Newsletter | `components/newsletter/` | NewsletterHome, NewsletterGenerate, ExecutionStatus, PendingApprovals, ApprovalDetail, ScheduledSends, NewsletterDetail, IngestionBrowser, TemplatesList, TemplateEditor, EditionsList, EditionEditor, FeedsList, EditionSetupWizard |
| Settings | `components/settings/` | UserSettings (profile, password, theme, tutorial replay) |
| Admin | `components/admin/` | AdminPanel (7 tabs: Users, Subscriptions, Revenue, Metrics, Workflows, Queues, Email Bounces), EditUserDialog |
| Superuser | `components/superuser/` | SuperuserPanel (Impersonation, Tier Management, System Config) |
| Credits | `components/credits/` | CreditsPage |
| Onboarding | `components/onboarding/` | OnboardingTutorial (anchored spotlight tour) |
| Shared | `components/shared/` | Pagination, Skeleton, ConfirmDialog, EmptyState, PasswordInput, HelpButton |

## Build + run

```bash
cd writers-workbench
npm install
npm run dev          # client (5173) + server (3001) concurrently
npm run test         # vitest, both workspaces (~430 tests)
npm run typecheck
npm run build
npm run test:e2e     # playwright
```

Production build is a Docker multi-stage. See [[deployment-railway]].

## Sprint scaffolding

- 27+ test files in `client/src/test/sprintN-qa.test.ts(x)` and `newsletter-*.test.tsx`.
- E2E specs in `e2e/` driven by `playwright.config.ts` with two projects: `chromium-noauth` and `chromium-authenticated` (uses `auth.setup.ts` to log in).

## Common gotchas

- `App.tsx` legacy redirects: `/chapters`, `/short-stories`, `/blog-posts`, `/newsletters` → `/library?type=X`.
- Cover image banner reads `cover_image_path` from `published_content_v2`. Updated via `mutation.cover_image_path` (or impersonation write).
- `ContentDetail` lazy-loads via `React.lazy(() => import(...))`. Wrap in `<Suspense>` (already done in App.tsx).
- TipTap auto-save fires after 1500ms idle. Don't change the debounce without a perf check on slow networks.
