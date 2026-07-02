---
name: Admin + Superuser regression
description: /admin/* AdminPanel (7 tabs), /superuser/* SuperuserPanel (3 tabs), ImpersonationBanner. Access-gated.
type: reference
last_reviewed: 2026-07-02
---

# Admin + Superuser

Spec: access-control asserted by `regression/nav-render.spec.ts` (guarded-route block). Full tab coverage
requires an admin/superuser session — run those with an elevated test user. Components:
`admin/AdminPanel.tsx`, `superuser/SuperuserPanel.tsx`, `superuser/ImpersonationBanner.tsx`.

## Access control (what a normal user sees)

Neither route redirects — each self-guards inside the component:
- `/admin` → `You do not have admin access.` (if not `profile.isAdmin`).
- `/superuser` → `Superuser access required.` (if not superuser).
The URL stays; no crash. Sidebar Admin/Superuser links are hidden for non-privileged users. Test asserts
the URL holds + one of {panel heading, denied message} shows.

## `/admin/*` AdminPanel — 7 state tabs (same URL, NOT nested routes)

User Management, Subscriptions, Revenue, System Metrics, Workflows, Queues, Email Bounces.
- **User Management**: search, status filter, `+ Create User` (inline form), per-row role editor
  (superuser-gated options), Edit / Tier / Lock-Unlock / Credits / Impersonate (superuser only). Dialogs:
  LockUserDialog, AdjustCreditsDialog, EditUserDialog, AssignSubscriptionDialog.
- Other tabs are mostly read-only tables with filter selects; Workflows/Queues/Bounces auto-refresh.

## `/superuser/*` SuperuserPanel — 3 state tabs

Impersonation (Quick Impersonate table → `startImpersonation` → `window.location.assign('/')`),
Tier Management (per-tier Edit → TierEditDialog), System Config (per-op credit costs + maintenance mode
+ Save Configuration).

**ImpersonationBanner** (app-wide when impersonating): `role="alert"`, `End Impersonation` is the only exit.

## FINDINGS

- No route-level redirect / 403 page — assert the **in-page** denied text, not a redirect.
- `/admin/subscriptions` etc. do NOT deep-link — tab state is `useState`, not URL-driven.
- DELETE user endpoint is intentionally unwired (Lock/Unlock replaced it) — assert no delete-user button.
- Per-row action buttons repeat identically — selectors MUST be row-scoped.
- Impersonation start is a full `window.location.assign` (not SPA nav) — wait for load.
- Impersonation/users fetch swallows errors to empty arrays — assert a known row, not just "table renders".
