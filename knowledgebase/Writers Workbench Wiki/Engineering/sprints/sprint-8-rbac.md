---
name: Sprint 8 — RBAC + tiers + credits + impersonation
description: 10 stories / 55 pts. Migration 011 + 6 new tables + admin role hierarchy + 5 subscription tiers + credit ledger + superuser impersonation read+write data plane.
type: concept
tags: [sprints, sprint-8, rbac, tiers, credits, impersonation]
last_reviewed: 2026-05-09
---

# Sprint 8 — RBAC + tiers + credits + impersonation

**Released:** v1.1.0 (2026-04-28).
**PRs:** [#50](https://github.com/beserericl-hue/Automations/pull/50) (main feature), [#51](https://github.com/beserericl-hue/Automations/pull/51) (onboarding tour), #53, #54, #55, #57 (admin follow-ups + v1.1.1 hotfix).
**Spec:** `writers-workbench/sprint_document.md` Sprint 8 section.

10 stories / 55 pts. Adapted away from spec's literal SQL because spec called for `ALTER users_v2` which schema-governance check on migrations ≥008 forbids. Used the meta-table pattern.

## Migration 011 — what landed in DEV (2026-04-26) + PROD (2026-04-28)

Six new tables, additive, governance-clean.

### `user_account_meta_v2`

Account lifecycle. Absence of a row = active.

```
user_id        text PK REFERENCES users_v2(user_id) ON DELETE CASCADE
account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','locked','suspended','pending'))
locked_at      timestamptz
locked_by      text REFERENCES users_v2(user_id)
locked_reason  text
```

### `user_role_meta_v2`

Elevated role. Absence of a row = ordinary user.

```
user_id     text PK REFERENCES users_v2(user_id) ON DELETE CASCADE
role        text NOT NULL CHECK (role IN ('admin','superuser'))
granted_by  text REFERENCES users_v2(user_id)
granted_at  timestamptz DEFAULT now()
```

The legacy `users_v2.role` column from migration 001 is left untouched (its frozen CHECK doesn't accept `'superuser'`). Effective role:

```
COALESCE(user_role_meta_v2.role, users_v2.role, 'user')
```

Trigger `prevent_role_meta_escalation` (BEFORE INSERT/UPDATE/DELETE) blocks non-superuser callers. Service role bypasses (auth.uid() IS NULL).

### `subscription_tiers`

Public catalog. 5 seeded:

| name | credits/mo | trial days | monthly $ | annual $ | features | publicly_selectable | default_for_signup |
|------|-----------|-----------|-----------|----------|----------|---------------------|--------------------|
| trial | 200 | 30 | 0 | 0 | basic | true | false (offered alt) |
| standard | 100 | 0 | 19.99 | 199 | kdp_export | true | true |
| pro | 500 | 0 | 49.99 | 499 | kdp_export, cover_art, social_media | true | false |
| paid_full | 1000 | 0 | 49.99 | 499 | all | true | false |
| free_full | 1000 | 0 | 0 | 0 | all | false | false (admin-only) |

Each row has `features` JSONB and `credit_purchase_price_cents` (default 100¢ = $1.00/credit).

### `user_subscriptions`

```
user_id                   text PK FK ON DELETE CASCADE  (UNIQUE so 1:1)
tier_id                   uuid FK
status                    text CHECK ('trialing','active','past_due','cancelled','expired')
billing_cycle             text CHECK ('monthly','annual','none')
period_start, period_end  timestamptz
trial_start, trial_end    timestamptz
credits_remaining         int
credits_used_this_period  int
auto_renew                boolean DEFAULT true
trial_warnings_sent       jsonb DEFAULT '[]'   -- ['7d','3d','1d']
```

### `credit_transactions`

Audit ledger. 5 transaction types:
- `monthly_reset` — resets credits to tier baseline
- `usage` — chat-proxy debit
- `admin_adjustment` — admin balance change
- `purchase` — placeholder; Stripe replaces this Sprint 9
- `refund` — placeholder

Includes `balance_after` so a single row tells you the running balance.

### `impersonation_log`

Superuser audit trail. UNIQUE active session per superuser via partial index.

```
id              uuid PK
superuser_id    text FK
target_user_id  text FK
reason          text
started_at      timestamptz DEFAULT now()
ended_at        timestamptz                 -- NULL = active
actions_taken   jsonb DEFAULT '[]'          -- cap 500 per session
```

### Helper functions

- `is_admin_v2()` — `true` if `auth.uid()` user has role IN admin/superuser
- `is_superuser_v2()` — strictly superuser
- `is_account_active_v2()` — false if `account_status` not 'active'
- `get_user_effective_role_v2(p_user_id)` — `COALESCE` of meta + legacy

## Server endpoints added

See [[express-routes]] for full list. Top-level:
- `creditsRouter` — `/api/credits/{balance,pricing,transactions,purchase}`
- `superuserRouter` — `/api/superuser/{impersonate*,tiers*,config}`
- `tiersRouter` — `/api/tiers` (public)
- `cronRouter` — `/api/cron/*` (X-Cron-Secret)
- `impersonateDataRouter` — `/api/impersonate/data/*` (~25 endpoints)
- `impersonateWriteRouter` — `/api/impersonate/write/*`

`requireAuth` extended to load role meta + account meta + subscription in parallel + honor `X-Impersonate-User` header. New variants: `requireAdmin` (now treats superuser as admin), `requireSuperuser`, `requireTierFeature`, `requireCredits`.

`/api/chat/proxy` does pre-flight credit check (402 INSUFFICIENT_CREDITS), deducts on success, sets `X-Credits-Remaining` header. Costs configurable in `app_config_v2.sprint8_superuser_config.credit_costs`.

`/api/admin/users/:id/role` is the canonical role-change. Writes `user_role_meta_v2` (insert for admin/superuser, delete for user). Only superusers grant elevated roles. Cannot demote yourself.

## Client UI added

- New routes: `/credits` (CreditsPage with Buy More + transactions), `/superuser` (SuperuserPanel with 3 tabs).
- Banners in AppShell: `ImpersonationBanner` (live timer + End), `TrialBanner` (red ≤3d).
- Sidebar: credit pill (color-coded), Credits link, Superuser link (visible only to superusers).
- AdminPanel rebuilt — 7 tabs. User row: tier badge, account status, credits, trial countdown. Inline role dropdown. Action buttons: Edit / Lock / Unlock / Credits / Impersonate / Set Tier.
- Subscriptions tab: filter by tier/status, sortable.
- Revenue tab: MRR, ARR, active counts, breakdown.
- Onboarding flow: 2-step (profile → tier-selection via PricingCards).

## Impersonation data plane

Every read view in the app honors impersonation. Surfaces audited as wired: Dashboard, ProjectList, ProjectDetail (8 tabs incl. nested), ContentLibrary, ContentDetail, ResearchList/Detail, ImageGallery/Detail, SocialMediaPanel, StoryBiblePanel, TrashView, OutlineList, VersionHistory, ProvenancePanel, CostDashboard, Sidebar projects, TopBar breadcrumb + global search.

Every write the impersonator triggers persists as the target user with audit:
- ProjectEditForm save, ProjectDetail delete (cascade)
- ContentDetail save / status / schedule / cover-image / delete + content_versions snapshot
- StoryBiblePanel + EntryForm CRUD
- ResearchDetail save/delete, ResearchList delete
- TrashView restore
- ContentLibrary bulk approve/publish/delete (per-id PATCH for audit)
- AnnotationsPanel apply/dismiss

Server-mediated routes that already used `req.userId` (image gen, chat/brainstorm, rewrite-with-research, Q/A) work transparently.

## v1.1.1 hotfix

PR #57. PasswordInput show/hide toggle on all 6 password fields. New endpoint `/api/admin/users/:id/full` for combined profile + email-prefs + password edit.

## v1.1.2 hotfix (in flight)

Bug: admin-create user only inserted into `users_v2`, never created auth user. Password set later returned `password: { ok: false, error: 'User has no linked Supabase Auth UUID' }`.

Fix:
- `POST /api/admin/users/:id/full` — when password provided AND `supabase_auth_uid IS NULL`, calls `supabase.auth.admin.createUser` + writes UID back.
- `POST /api/admin/users-with-subscription` — accepts optional password; when supplied, creates auth user before users_v2 insert + rolls back on failure.
- AdminPanel Create User form — added password + confirm fields.
- EditUserDialog toast — surfaces `note: 'Created Supabase Auth account and linked it'`.

## Test coverage

- Server: `sprint8-qa.test.ts` (14), `sprint8-gaps.test.ts` (3), `sprint8-impersonate-write.test.ts` (3).
- Client: `sprint8-qa.test.tsx` (18), `sprint8-gaps.test.tsx` (5).
- 508/508 tests passing at PR #51 squash.

## Open follow-ups

1. Self-signup auto-create trial subscription. Currently if user skips tier selection, no row → credits=0 → chat 402s. Pragmatic fix: have onboarding "Skip" auto-create trial.
2. UserSettings profile edits via impersonation not wired (admin EditUserDialog covers).
3. GenreList private genre management via impersonation not wired.
4. Sprint 9 (Stripe) replaces placeholder credit-purchase flow.
