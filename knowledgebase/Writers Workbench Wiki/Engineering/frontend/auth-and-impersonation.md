---
name: Auth + impersonation (frontend)
description: AuthContext, UserContext, AuthGuard, Onboarding flow, impersonation banner + flag.
type: concept
tags: [frontend, auth, impersonation, sprint-8]
last_reviewed: 2026-05-09
---

# Auth + impersonation (frontend)

Two contexts: `AuthContext` (Supabase Auth session) and `UserContext` (loaded `users_v2` row + role + subscription + impersonation state).

## AuthContext

[`client/src/contexts/AuthContext.tsx`](../../../../writers-workbench/client/src/contexts/AuthContext.tsx).

```ts
type AuthState = {
  session: Session | null;
  user: User | null;          // Supabase auth user (UUID)
  loading: boolean;
};

const AuthContext = createContext<AuthState>(...);

function AuthProvider({ children }) {
  const [state, setState] = useState({...});
  useEffect(() => {
    supabase.auth.getSession().then(({data}) => setState({session: data.session, ...}));
    const sub = supabase.auth.onAuthStateChange((_event, session) => setState({session, ...}));
    return () => sub.subscription.unsubscribe();
  }, []);
  ...
}
```

Used by `AuthGuard` to gate the app shell.

## UserContext

[`client/src/contexts/UserContext.tsx`](../../../../writers-workbench/client/src/contexts/UserContext.tsx).

Loads the user's profile after auth succeeds:

```ts
type UserState = {
  user: UserRow | null;             // users_v2 row
  role: 'user' | 'admin' | 'superuser';
  accountStatus: 'active' | 'locked' | 'suspended' | 'pending';
  subscription: UserSubscription | null;
  isImpersonating: boolean;
  impersonatedUserId: string | null;  // E.164 phone of target user
  impersonateAs: (targetUserId: string, reason: string) => Promise<void>;
  endImpersonation: () => Promise<void>;
  refresh: () => Promise<void>;
};
```

`UserProvider` lookup flow:

```
1. Get auth.user.id (UUID) from AuthContext.
2. supabase.from('users_v2').select(...).eq('supabase_auth_uid', authUid).maybeSingle()
3. If no row → <Navigate to="/onboarding" />
4. Load user_role_meta_v2, user_account_meta_v2, user_subscriptions in parallel.
5. Compute effective role: meta.role OR users_v2.role OR 'user'.
6. If impersonation token in localStorage AND role==='superuser' → set impersonating state.
```

`impersonateAs(targetUserId, reason)`:
1. POST `/api/superuser/impersonate {target_user_id, reason}` (creates `impersonation_log` row).
2. Set `localStorage.impersonating_target_id = targetUserId`.
3. Set state `isImpersonating: true`.
4. Reload page (clears all TanStack Query caches; routes refetch as target).

`endImpersonation()`:
1. POST `/api/superuser/impersonate/end`.
2. Clear localStorage.
3. State `isImpersonating: false`.
4. Reload page.

## Onboarding flow

`/onboarding` is hit when the user has an `auth.users` row but no `users_v2` row.

Step 1 — Profile:
- Display name
- Recipient email (where Eve sends drafts)
- BCC email (optional)
- Phone number (E.164 — becomes the user_id)

POST `/api/account/onboard {display_name, recipient_email, bcc_email, phone}`:
- Validates phone format
- INSERT users_v2 with phone as user_id, link supabase_auth_uid
- INSERT app_config_v2 row with recipient_email + bcc_email

Step 2 — Tier selection (PricingCards):
- Selects a tier
- POST `/api/account/subscribe {tier_name, billing_cycle}`
- Creates user_subscriptions row, status=`active` (or `trialing` for trial)

After step 2, `<Navigate to="/" replace />` — UserProvider refetches on the next route.

**Known TODO:** if user skips tier selection, no subscription row exists → credits=0 → chat 402s. Pragmatic fix: auto-create trial subscription on skip (Sprint 9 follow-up).

## ImpersonationBanner

[`client/src/components/layout/ImpersonationBanner.tsx`](../../../../writers-workbench/client/src/components/layout/ImpersonationBanner.tsx). Renders only when `isImpersonating`:

```tsx
<div className="bg-amber-200 px-4 py-2 flex justify-between items-center">
  <div>
    <strong>Impersonating</strong> {targetUser.display_name} ({targetUser.user_id})
    <span> · Started {timeAgo}</span>
  </div>
  <button onClick={endImpersonation}>End impersonation</button>
</div>
```

## Apifetch + impersonation header

`client/src/lib/api-fetch.ts` is the helper:

```ts
async function apiFetch(url, opts) {
  const headers = new Headers(opts?.headers);
  const session = supabase.auth.getSession();
  headers.set('Authorization', `Bearer ${session.access_token}`);
  if (UserContext.isImpersonating) {
    headers.set('X-Impersonate-User', UserContext.impersonatedUserId);
  }
  return fetch(url, {...opts, headers});
}
```

**Every component that does mutations during impersonation must use `apiFetch`** instead of `supabase.from(...).update(...)`. Direct Supabase calls would bypass the impersonation routing and update the superuser's data.

Surfaces audited as wired (Sprint 8 review):
- ProjectEditForm
- ProjectDetail delete (cascade)
- ContentDetail save / status / schedule / cover-image / delete + content_versions snapshot
- StoryBiblePanel + EntryForm CRUD
- ResearchDetail save / delete
- ResearchList delete
- TrashView restore
- ContentLibrary bulk approve / publish / delete (per-id PATCH for audit)
- AnnotationsPanel apply / dismiss

Surfaces NOT wired (lower priority):
- UserSettings profile edit (admin EditUserDialog covers this need)
- GenreList private genre management

## Server-mediated routes (already work)

Routes that use `req.userId` (set by `requireAuth` from the impersonation header) work transparently:
- `/api/chat/proxy` — reads target user's credit balance, deducts from theirs.
- `/api/brainstorm/*`
- `/api/content/*` (rewrite-with-research, annotations)
- `/api/images/*`

## SignupPage password validation

Sprint 8 / v1.1.1 hotfix added:

```ts
- min 8 chars
- two password fields must match (inline error)
- Submit disabled on mismatch
- PasswordInput show/hide toggle on each
- autoComplete="new-password"
```

## EditUserDialog (admin)

Three fieldsets:
- Profile — display_name, email
- Email delivery — recipient_email, bcc_email
- Password — collapsed behind "Reset this user's password" button → reveals PasswordInput

`POST /api/admin/users/:id/full` covers all three in one call. Per-field success result, surfacing partial-success toast: "Saved with 1 issue: password: User has no linked Supabase Auth UUID" — fixed in v1.1.2 by auto-creating the auth row on first password set.

## Common gotchas

- **Login → blank screen** — Site URL not set in Supabase Auth → email links go `localhost:3000`. Set on both projects.
- **Impersonation persists across refresh** because state lives in localStorage. Intentional. Use End button to clear.
- **TanStack Query caches don't auto-clear on impersonation switch** — that's why `impersonateAs` reloads the page.
- **`X-Impersonate-User` set without active impersonation_log row** → server-side `requireAuth` ignores the header; route operates on superuser's own data. Doubly-defended.
- **Forgot to use `apiFetch`** — silent privilege miss. Code review for raw `fetch` and direct `supabase.from(...).update(...)` during impersonation surfaces.
