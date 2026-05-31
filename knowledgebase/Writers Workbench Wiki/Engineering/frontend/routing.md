---
name: Routing
description: Full client route table — public, authenticated, admin, superuser, newsletter, legacy redirects.
type: concept
tags: [frontend, routing]
last_reviewed: 2026-05-09
---

# Routing

Defined in [`client/src/App.tsx`](../../../../writers-workbench/client/src/App.tsx).

## Public routes (no auth required)

| Path | Component | Notes |
|------|-----------|-------|
| `/login` | LoginPage | Email + password (Google OAuth gated by VITE_GOOGLE_OAUTH_ENABLED) |
| `/signup` | SignupPage | New account — currently profile-only (no auto-trial; see [[hotfixes]] follow-up) |
| `/forgot-password` | ForgotPasswordPage | Sends reset email via Supabase Auth (Site URL must be set!) |
| `/reset-password` | ResetPasswordPage | Token-driven; lands here from email link |
| `/onboarding` | OnboardingPage | Profile → tier-selection (PricingCards). 2-step. |

All other routes are wrapped in:

```tsx
<AuthGuard>
  <UserProvider>
    <AppShell>
      <Routes>...authenticated routes...</Routes>
    </AppShell>
  </UserProvider>
</AuthGuard>
```

## Top-level authenticated routes

| Path | Component | Notes |
|------|-----------|-------|
| `/` | Dashboard | live counts + recent activity |
| `/projects` | ProjectList | paginated |
| `/projects/:id` | ProjectDetail | 8 tabs: Overview, Outline, Chapters, Story Bible, Art, Social, Research, Cost, Export |
| `/projects/:id/bible` | StoryBiblePanel | direct-link to bible tab |
| `/trash` | TrashView | soft-deleted entities, restore action |
| `/library` | ContentLibrary | unified content view; filters + bulk ops |
| `/content/:id` | ContentDetail | TipTap editor, status workflow, panels |
| `/research` | ResearchList | paginated |
| `/research/:id` | ResearchDetail | TipTap editor + delete |
| `/brainstorm` | BrainstormForm | (legacy entry; chat preferred) |
| `/outlines` | OutlineList | |
| `/story-arcs` | StoryArcBrowser | public + custom; create/edit |
| `/genres` | GenreList | public + custom; CRUD with feeds |
| `/cost` | CostDashboard | tokens, $, daily breakdown |
| `/sources` | SourceBrowser | content_index browsing |
| `/settings` | UserSettings | profile, password, theme, tutorial replay |
| `/credits` | CreditsPage | balance + transactions + buy more |
| `/admin/*` | AdminPanel | 7 tabs; admin/superuser |
| `/superuser/*` | SuperuserPanel | impersonation, tier mgmt, system config; superuser only |
| `/images/:id` | ImageDetail | full-size + metadata |

## Newsletter routes (DEV-only as of 2026-05-09; PROD on next release)

| Path | Component |
|------|-----------|
| `/newsletter` | NewsletterHome |
| `/newsletter/generate` | NewsletterGenerate |
| `/newsletter/execution/:id` | ExecutionStatus (live SSE progress) |
| `/newsletter/approvals` | PendingApprovals |
| `/newsletter/approvals/:token` | ApprovalDetail (approve/reject/edit) |
| `/newsletter/sends` | ScheduledSends |
| `/newsletter/sends/:id` | NewsletterDetail |
| `/newsletter/ingestion` | IngestionBrowser |
| `/newsletter/templates` | TemplatesList |
| `/newsletter/templates/new` | TemplateEditor |
| `/newsletter/templates/:id` | TemplateEditor |
| `/newsletter/editions` | EditionsList |
| `/newsletter/editions/new` | EditionEditor |
| `/newsletter/editions/:id` | EditionEditor |
| `/newsletter/editions/:id/feeds` | FeedsList |
| `/newsletter/editions/:id/setup` | EditionSetupWizard |

## Legacy redirects (Sprint 2)

The Sprint 2 ContentLibrary consolidation deprecated the four content-type pages. The legacy routes redirect:

| Legacy | Target |
|--------|--------|
| `/chapters` | `/library?type=chapter` |
| `/short-stories` | `/library?type=short_story` |
| `/blog-posts` | `/library?type=blog_post` |
| `/newsletters` | `/library?type=newsletter` |

Plus catch-all: `*` → `Navigate to="/" replace`.

## URL params used

| Param | Path | Effect |
|-------|------|--------|
| `?type=` | `/library` | filter content type |
| `?status=` | `/library` | filter status |
| `?genre=` | `/library` | filter genre |
| `?project=` | `/library` | filter project |
| `?tab=` | `/projects/:id` | persist active tab |
| `?date=` | `/newsletter/ingestion` | jump to a specific scan day (deep-link from approval payload) |
| `?token=` | `/api/callback/events` | EventSource auth |

## Auth guard

```tsx
function AuthGuard({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <FullPageLoader />;
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

`useAuth()` reads from `AuthContext`. Session from `supabase.auth.getSession()`.

`UserProvider` (inside the guard) loads the `users_v2` row by `supabase_auth_uid`. If no row exists, redirects to `/onboarding`.

## Layout structure

```
<AppShell>
  <Sidebar>           ← left rail; collapsible; My Projects expandable; project count badges
    <SidebarItem>     ← Dashboard, Projects, Library, etc.
    <ReferenceSection>← Genres, Story Arcs, Research, Sources, Cost
    <NewsletterSection>← (when on DEV) → editions, feeds, templates, approvals, etc.
    <EveLink>         ← "Talk to Eve" → opens widget popover
    <SettingsLink>
  </Sidebar>
  <MainArea>
    <TopBar>          ← breadcrumb + search (Cmd+K) + dark mode toggle + chat button + credits pill
    <ImpersonationBanner>  ← if superuser is impersonating
    <TrialBanner>     ← if on trial; turns red ≤3 days remaining
    <Outlet>          ← current route
  </MainArea>
  <ChatDrawer>        ← right side, resizable; collapsed by default; toggled from TopBar
</AppShell>
```

`Sidebar` collapses to icon-only below `lg` breakpoint via `matchMedia` listener (Sprint 2 mobile-responsive).

## Lazy-loaded routes

Sprint 2 marked `ContentLibrary`, `CostDashboard`, `SourceBrowser` as `React.lazy` to keep initial bundle small. Wrapped in `<Suspense>` in `App.tsx`.

Newsletter routes also lazy-loaded via PR #69+. Each major feature folder gets its own bundle.

## Bug repro paths

Common test paths:

- "Login → Dashboard → click row" — basic path, regress-tested in `e2e/sprint7-critical-paths.spec.ts`.
- "Library → bulk select → bulk approve" — regress in `e2e/sprint2-navigation.spec.ts`.
- "Project → Outline tab → version history" — Sprint 3 regress.
- "Settings → Replay Tutorial" — Sprint 7 onboarding regress.

## Common gotchas

- **`<Navigate>` inside a Route element** vs. `<Navigate>` from a useEffect — the Route element form works synchronously.
- **`useBlocker`** for unsaved-changes warnings (`ContentDetail`) — don't combine with `beforeunload` listener (double-prompt). Sprint 1 S1-7.
- **Forgetting to wrap a new route in `<Suspense>`** when using `React.lazy` — works in dev, breaks production with white screen.
- **Tab persistence via `?tab=`** — must keep parameter consistent across tab switches; using `useSearchParams` with replace=true.
