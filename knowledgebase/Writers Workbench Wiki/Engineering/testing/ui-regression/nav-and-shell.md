---
name: Nav + App Shell regression
description: AppShell sidebar/topbar, every-route render gate, guarded-route access control.
type: reference
last_reviewed: 2026-07-02
---

# Nav + App Shell

Spec: `writers-workbench/e2e/regression/nav-render.spec.ts`. Components: `layout/AppShell.tsx`,
`layout/Sidebar.tsx`, `layout/TopBar.tsx`.

## Every-route render gate

`RegressionPage.ROUTES` (in `e2e/pages/regression.page.ts`) lists every reachable top-level route.
For each, `assertRenders` proves: AppShell chrome present, NOT the ErrorBoundary crash screen, content
settled past the Suspense "Loading…" fallback, and the route's marker text visible. Routes covered:

`/`, `/projects`, `/library`, `/brainstorm`, `/outlines`, `/research`, `/story-arcs`, `/genres`,
`/sources`, `/cost`, `/credits`, `/trash`, `/settings`, `/newsletter`, `/newsletter/generate`,
`/newsletter/approvals`, `/newsletter/sends`, `/newsletter/ingestion`, `/newsletter/templates`,
`/newsletter/templates/new`, `/newsletter/editions`, `/newsletter/editions/new`.

`:id` detail routes (`/projects/:id`, `/content/:id`, `/research/:id`, `/images/:id`,
`/newsletter/...`) are covered by the area-specific specs that open a real row first.

## Sidebar (`Sidebar.tsx`)

| Element | Expected result | Selector | Test |
|---|---|---|---|
| Collapse/expand toggle | width `w-56`↔`w-14`; labels hide when collapsed | `getByRole('button',{name:/Collapse sidebar\|Expand sidebar/})` | (manual/visual) |
| Dashboard / Content Library / Brainstorm / Outlines / Credits / Trash / Settings links | navigate to each route | `aside >> getByRole('link',{name,exact:true})` | `nav-render` "sidebar … navigates" |
| Admin / Superuser links | only render for admin/superuser | conditional | see [[admin-superuser]] |
| My Projects / Newsletter / Reference section headers | expand/collapse child list (no-op when collapsed) | `aside >> getByRole('button',{name:/…/})` | `nav-render` "expandable sections … expand" |
| Per-project sub-links (≤20) | navigate `/projects/:id` | `aside >> getByRole('link',{name:title})` | via `project-detail` |

## TopBar (`TopBar.tsx`)

| Element | Expected result | Selector |
|---|---|---|
| Hamburger (mobile) | toggles mobile drawer | `getByRole('button',{name:'Toggle sidebar'})` |
| Breadcrumb "Home" | navigate `/` | header `getByRole('link',{name:'Home'})` |
| Search toggle (Cmd+K) | open/close search panel; Esc closes | `getByRole('button',{name:'Search (Cmd+K)'})` |
| Search input | debounced search across projects/content/research | `getByPlaceholder('Search projects, content, research...')` |
| Dark-mode toggle | flips theme | `getByRole('button',{name:/Switch to (dark\|light) mode/})` |
| Chat toggle | open/close ChatDrawer | `getByRole('button',{name:'Chat with Author Agent'})` |
| User menu → Settings / Sign out | navigate `/settings` / `signOut()`→`/login` | `getByRole('button',{name:'Sign out'})` |

## Guarded routes (`/admin`, `/superuser`)

Both self-guard **inside the component** (no route-level redirect). A non-admin sees an in-page denied
message; the URL does NOT change and there is no crash. Test: `nav-render` "access control" block asserts
the URL stays and either the panel heading OR the denied message shows. See [[admin-superuser]].

## FINDINGS

- **Collapsed section headers are silent no-ops** — clicking My Projects/Newsletter/Reference icons while
  the sidebar is collapsed does nothing (`onClick={() => open ? setX(!x) : undefined}`). No direct-link
  fallback. Test both states if this matters.
- **Sidebar collapse doesn't track viewport resize** (`sidebarOpen` seeded once from `isDesktop`).
- **Duplicate accessible names**: "Settings" (sidebar + user menu), "Home" (breadcrumb `/` + newsletter
  `/newsletter`) — scope selectors to `aside` vs header.
- **User-menu button has no stable accessible name** (uses `display_name`, hidden below `sm`). Consider
  `aria-label="User menu"`.
- **TopBar research search results navigate to `/research` (list), not `/research/:id`** — lossy.
- **`/newsletters` (plural)** is a legacy redirect to `/library?type=newsletter`; the sidebar uses
  singular `/newsletter*`. Don't collapse them.
