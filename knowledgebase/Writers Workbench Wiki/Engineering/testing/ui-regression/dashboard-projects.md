---
name: Dashboard + ProjectList regression
description: / Dashboard, /projects ProjectList, ProjectEditForm.
type: reference
last_reviewed: 2026-07-02
---

# Dashboard + ProjectList

Specs: render covered by `nav-render.spec.ts`; interactions by `project-detail.spec.ts` (which opens a
project). Components: `dashboard/Dashboard.tsx`, `projects/ProjectList.tsx`, `projects/ProjectEditForm.tsx`.

## `/` Dashboard

| Element | Expected | Selector |
|---|---|---|
| Welcome header | "Welcome back[, name]" | `getByRole('heading',{name:/Welcome back/})` |
| 4 StatCards (Projects/Drafts/Published/Research) | display counts — **NOT clickable** | `getByText('Projects')` |
| Recent Activity rows | `tr[role=button]` → `navigate(item.path)` | `getByRole('button',{name:'View <title>'})` |

FINDING: StatCards are static `<div>`s (no navigation) — do NOT assert click-through. Initial-load gate
is `countsLoading && recentLoading` (AND) — a single slow query still renders the page.

## `/projects` ProjectList

| Element | Expected | Selector |
|---|---|---|
| Project rows | `role="button" aria-label="Open project <title>"` → `/projects/:id` | `getByRole('button',{name:/^Open project/})` |
| Pagination Prev/Next/pages/page-size | client-side paging (hidden at ≤10 projects) | `getByRole('button',{name:'Next'})` |
| Empty state | "No projects yet" (no action button) | `getByText('No projects yet')` |

FINDING: **no "New Project" button** — creation is via chat/Eve. Pagination + page-size select hidden at
≤10 projects (this user has 28 → visible).

## ProjectEditForm (opened from ProjectDetail header "Edit")

Title*/Premise/Themes inputs; Genre/Status/Project-Type selects; `Save Changes` (disabled when title
blank) / `Cancel`. No `<form>`/onSubmit — Enter does not submit; labels not `htmlFor`-linked (use
placeholders / positional comboboxes). Covered by `project-detail.spec.ts` "Edit form opens and cancels".
