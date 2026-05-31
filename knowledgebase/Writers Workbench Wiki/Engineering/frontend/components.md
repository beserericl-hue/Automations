---
name: Components
description: Frontend components grouped by feature area; key behaviors and dependencies.
type: concept
tags: [frontend, components]
last_reviewed: 2026-05-09
---

# Components

Located in `client/src/components/`. 26 top-level folders.

## Layout (always-mounted)

| Component | File | Purpose |
|-----------|------|---------|
| `AppShell` | `layout/AppShell.tsx` | Top-level layout. SSE EventSource. Banners. ToastContainer. OnboardingTutorial. |
| `Sidebar` | `layout/Sidebar.tsx` | Left rail. Project-centric (Sprint 2). Collapsible. Newsletter section (DEV-only). Eve link. |
| `TopBar` | `layout/TopBar.tsx` | Breadcrumb (entity title resolution). Search (Cmd+K). Dark mode toggle. Chat button. Credits pill. |
| `ImpersonationBanner` | `layout/ImpersonationBanner.tsx` | Live timer + End button. Only renders when `useUser().isImpersonating === true`. |
| `TrialBanner` | `layout/TrialBanner.tsx` | Days remaining; turns red ≤3 days. |

## Auth (Sprint 0/8)

| Component | File | Purpose |
|-----------|------|---------|
| `LoginPage` | `auth/LoginPage.tsx` | Email + password + (gated) Google OAuth. PasswordInput show/hide. |
| `SignupPage` | `auth/SignupPage.tsx` | Email + 2 passwords (with match validation). |
| `ForgotPasswordPage` | `auth/ForgotPasswordPage.tsx` | Send reset email. |
| `ResetPasswordPage` | `auth/ResetPasswordPage.tsx` | Token-driven; lands from email. |
| `OnboardingPage` | `auth/OnboardingPage.tsx` | 2-step (profile + tier-selection). |
| `PricingCards` | `auth/PricingCards.tsx` | Tier selector. Annual/monthly toggle. "Most Popular" ribbon on Pro. |
| `AuthGuard` | `auth/AuthGuard.tsx` | Wraps authenticated routes. |

## Dashboard (Sprint 0)

| Component | File | Purpose |
|-----------|------|---------|
| `Dashboard` | `dashboard/Dashboard.tsx` | 6 count cards + recent activity table. Polling every 30s. Skeleton loader. Keyboard nav on rows. |
| `StatusBadgeIcon` | `dashboard/Dashboard.tsx` | Accessible status badge (icon + color). |

## Projects

| Component | File | Purpose |
|-----------|------|---------|
| `ProjectList` | `projects/ProjectList.tsx` | Table; pagination; soft-delete filter. |
| `ProjectDetail` | `projects/ProjectDetail.tsx` | 8 tabs. Edit button (Sprint 3). Delete with cascade dialog. |
| `ProjectEditForm` | `projects/ProjectEditForm.tsx` | Title, genre dropdown, status, type. Outline auto-versioned via DB trigger. |

`ProjectDetail` tabs:
- **Overview** — progress bar, word count, character cards, premise/themes.
- **Outline** — chapter list with sub-chapter outlines.
- **Chapters** — table with word counts, status badges, prev/next navigation.
- **Story Bible** — grouped by entry type.
- **Art** — `ImageGallery` component (Sprint 4).
- **Social** — `SocialMediaPanel` (Sprint 4).
- **Research** — filtered to project genre.
- **Cost** — `CostDashboard` scoped to project (Sprint 5).
- **Export** — `.docx` export config (page size, scope).

## Content (Sprint 0/2/4/5/12)

| Component | File | Purpose |
|-----------|------|---------|
| `ContentLibrary` | `content/ContentLibrary.tsx` | Sprint 2 consolidation. Filter bar + sortable + bulk actions. Lazy-loaded. |
| `ContentDetail` | `content/ContentDetail.tsx` | TipTap editor. Auto-save. Status workflow. Cover image banner. Side panels. |
| `ProvenancePanel` | `content/ProvenancePanel.tsx` | Sources for a content piece (content_usage_v2). |
| `QAReportPanel` | `content/QAReportPanel.tsx` | 9-check QA report from chapter metadata. |
| `AnnotationsPanel` | `content/AnnotationsPanel.tsx` | Sprint 12 S12-13. Drift + genre annotations. Apply/dismiss. |
| `SourceBrowser` | `content/SourceBrowser.tsx` | content_index browsing. |

## Story bible / arcs / outlines (Sprint 3)

| Component | File | Purpose |
|-----------|------|---------|
| `StoryBiblePanel` | `story-bible/StoryBiblePanel.tsx` | Grouped by entry type. Add Entry button. Edit icons. |
| `EntryForm` | `story-bible/EntryForm.tsx` | Add/edit story bible entry. Key-value metadata editor. |
| `StoryArcBrowser` | `story-arcs/StoryArcBrowser.tsx` | Public + custom. Create/edit custom arcs. |
| `StoryArcForm` | `story-arcs/StoryArcForm.tsx` | name, description, prompt_text, discovery_question. |
| `OutlineList` | `outlines/OutlineList.tsx` | List projects with outlines. |
| `VersionHistory` | `outlines/VersionHistory.tsx` | List/view/compare/restore modes (Sprint 1 S1-5). |

## Genres (Sprint 0/3)

| Component | File | Purpose |
|-----------|------|---------|
| `GenreList` | `genres/GenreList.tsx` | Public + private. Reference count per genre. Cascade-warning on delete. |
| `GenreForm` | `genres/GenreForm.tsx` | Numbered ArrayField with reorder + URL validation. |

## Research

| Component | File | Purpose |
|-----------|------|---------|
| `ResearchList` | `research/ResearchList.tsx` | Clickable rows → ResearchDetail. |
| `ResearchDetail` | `research/ResearchDetail.tsx` | TipTap editor. |

## Editor

| Component | File | Purpose |
|-----------|------|---------|
| `RichTextEditor` | `editor/RichTextEditor.tsx` | TipTap StarterKit + Link + Placeholder. |
| `EditorToolbar` | `editor/EditorToolbar.tsx` | Bold, italic, headers, lists, link. |

## Export

| Component | File | Purpose |
|-----------|------|---------|
| `ExportDialog` | `export/ExportDialog.tsx` | Page size + scope + .docx generation. |
| `PageSizeSelector` | `export/PageSizeSelector.tsx` | KDP-standard sizes. |

## Cost (Sprint 5)

| Component | File | Purpose |
|-----------|------|---------|
| `CostDashboard` | `cost/CostDashboard.tsx` | Date range filter (7/30/90/all). Daily bar chart. By model + workflow. |

## Images / Social (Sprint 4)

| Component | File | Purpose |
|-----------|------|---------|
| `ImageGallery` | `images/ImageGallery.tsx` | Grid + filter + Select callback (used as picker). |
| `ImageDetail` | `images/ImageDetail.tsx` | Full-size + metadata. |
| `SocialMediaPanel` | `social/SocialMediaPanel.tsx` | Platform tabs + post cards + copy-to-clipboard. |

## Chat / Eve

| Component | File | Purpose |
|-----------|------|---------|
| `ChatDrawer` | `chat/ChatDrawer.tsx` | Resizable. Persistent history (localStorage 100). Quick Commands. Pill states. |
| `EveOrb` | `eve/EveOrb.tsx` | Sidebar entry-point button. |
| `EveWidget` | `eve/EveWidget.tsx` | ElevenLabs embed widget host. Session register/unregister. |

## Newsletter (DEV-only as of 2026-05-09)

| Component | File | Purpose |
|-----------|------|---------|
| `NewsletterHome` | `newsletter/NewsletterHome.tsx` | Hub view. |
| `NewsletterGenerate` | `newsletter/NewsletterGenerate.tsx` | Trigger compose for an edition. |
| `ExecutionStatus` | `newsletter/ExecutionStatus.tsx` | Live SSE progress. |
| `PendingApprovals` | `newsletter/PendingApprovals.tsx` | Open approvals list. |
| `ApprovalDetail` | `newsletter/ApprovalDetail.tsx` | Token-loaded; approve/reject/edit. |
| `ScheduledSends` | `newsletter/ScheduledSends.tsx` | Scheduled queue. |
| `NewsletterDetail` | `newsletter/NewsletterDetail.tsx` | Full send view. |
| `IngestionBrowser` | `newsletter/IngestionBrowser.tsx` | Article scan results. Days sidebar. Scanned column. |
| `TemplatesList` | `newsletter/TemplatesList.tsx` | Public + custom templates. |
| `TemplateEditor` | `newsletter/TemplateEditor.tsx` | Handlebars editor + preview. |
| `EditionsList` | `newsletter/EditionsList.tsx` | Editions table. Show-disabled toggle. Re-enable button. |
| `EditionEditor` | `newsletter/EditionEditor.tsx` | Edit edition (genre dropdown PR #75). Logo upload. Signoff. |
| `FeedsList` | `newsletter/FeedsList.tsx` | Per-edition feed sources. |
| `EditionSetupWizard` | `newsletter/EditionSetupWizard.tsx` | Onboarding wizard; copies N feeds from chosen genre. |

## Settings / Admin / Superuser / Credits

| Component | File | Purpose |
|-----------|------|---------|
| `UserSettings` | `settings/UserSettings.tsx` | Profile, password (PasswordInput), theme, tutorial replay, danger zone. |
| `AdminPanel` | `admin/AdminPanel.tsx` | 7 tabs: Users, Subscriptions, Revenue, Metrics, Workflows, Queues, Email Bounces. |
| `EditUserDialog` | `admin/AdminPanel.tsx` (subcomponent) | Profile + email-delivery + password sections. |
| `SuperuserPanel` | `superuser/SuperuserPanel.tsx` | Impersonation + Tier Mgmt + System Config tabs. |
| `CreditsPage` | `credits/CreditsPage.tsx` | Balance + transactions + buy more. |

## Onboarding tutorial (Sprint 7 + PR #51)

| Component | File | Purpose |
|-----------|------|---------|
| `OnboardingTutorial` | `onboarding/OnboardingTutorial.tsx` | Anchored spotlight tour. 5 steps. ResizeObserver. `data-tour` attributes on target elements. |

## Shared (Sprint 6)

| Component | File | Purpose |
|-----------|------|---------|
| `Pagination` | `shared/Pagination.tsx` | Page nums + ellipsis + size selector. |
| `Skeleton` | `shared/Skeleton.tsx` | Skeleton, TableSkeleton, CardSkeleton, DashboardSkeleton, EmptyState. |
| `ConfirmDialog` | `shared/ConfirmDialog.tsx` | danger/warning/default variants. Keyboard nav. |
| `EmptyState` | `shared/Skeleton.tsx` | "Nothing here yet — try chat to start." |
| `PasswordInput` | `shared/PasswordInput.tsx` | Eye-icon show/hide. v1.1.1 hotfix. |
| `HelpButton` | `shared/HelpButton.tsx` | `?` icon → drawer with feature help. |
| `ErrorBoundary` | `ErrorBoundary.tsx` | Top-level boundary. |

## Component patterns

### Apifetch helper

`client/src/lib/api-fetch.ts`:

```ts
async function apiFetch(url: string, opts?: RequestInit) {
  const headers = new Headers(opts?.headers);
  const session = await supabase.auth.getSession();
  if (session.data.session) headers.set('Authorization', `Bearer ${session.data.session.access_token}`);
  if (userContext.isImpersonating) headers.set('X-Impersonate-User', userContext.impersonatedUserId);
  return fetch(url, { ...opts, headers });
}
```

Always use `apiFetch` over raw `fetch` when calling Workbench `/api/*` endpoints — gets you JWT + impersonation header automatically.

### TanStack Query mutation pattern

```ts
const mutation = useMutation({
  mutationFn: async (data) => {
    if (isImpersonating) {
      return apiFetch(`/api/impersonate/write/content/${id}`, {method:'PATCH', body:JSON.stringify(data)});
    }
    return supabase.from('published_content_v2').update(data).eq('id', id);
  },
  onSuccess: () => {
    queryClient.invalidateQueries(['content', id]);
    toast({type:'success', message:'Saved'});
  },
});
```

This pattern is wired across every editable surface — supports impersonation transparently.

### Skeleton loading

```tsx
{isLoading ? <TableSkeleton rows={10} /> : <ProjectsTable data={data} />}
```

Sprint 6 standardized skeleton usage. Don't render empty `<table>` with no rows during load — looks broken.

## Common gotchas

- **Forget `apiFetch` → use `fetch`** — impersonation header missing; impersonation breaks silently.
- **Direct `supabase.from(...).update(...)` during impersonation** — service-role bypass not available; falls back to user's RLS context. Use the impersonate-write proxy instead.
- **`React.lazy` without Suspense wrapper** — white screen in production.
- **Auto-save debounce** — 1500ms. Don't reduce; slow networks fail. Don't increase; users notice unsaved work disappearing on tab close (useBlocker mitigates).
- **TipTap state desync** — when external state (e.g. impersonation switch) changes the underlying content, TipTap doesn't re-render automatically. Use `useEffect` + `editor.commands.setContent(html)` on dependency change.
