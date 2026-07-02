---
name: Auth + Onboarding regression
description: login, signup, forgot/reset password, onboarding wizard + PricingCards.
type: reference
last_reviewed: 2026-07-02
---

# Auth + Onboarding

Existing spec: `e2e/login.spec.ts` (chromium-noauth project). Components: `auth/LoginPage`, `SignupPage`,
`ForgotPasswordPage`, `ResetPasswordPage`, `OnboardingPage`, `credits/PricingCards`, `shared/PasswordInput`.

## `/login`

Email input, Password (PasswordInput with Show/Hide toggle `aria-label`), **Sign in** (submit),
"Forgot password?" link, "Sign up" link, "Continue with Google" (**only when
`VITE_GOOGLE_OAUTH_ENABLED==='true'`** — absent by default). Already-authed users redirect to `/`.

## `/signup`

Email, Password (min 8), Confirm password; **Create account** (validates match + length). On success
unmounts the form → "Check your email" panel + "Back to sign in".

## `/forgot-password`

Email + **Send reset link** → `supabase.auth.resetPasswordForEmail`. Non-enumerating success copy.

## `/reset-password`

**Requires an authenticated recovery session** (redirects to `/login` if `!user`). New password + confirm
→ `supabase.auth.updateUser`. Success panel "Go to dashboard". Hard to E2E without a real recovery token.

## `/onboarding`

Step 1 profile: Your name*/Phone*/Email → writes `users_v2` + `app_config_v2` **directly from the client**.
Step 2 tier: `PricingCards` (Monthly/Annual toggle; "Start free trial"; per-tier "Choose"; "Most popular"
ribbon) → `POST /api/account/subscribe`. Redirects onboarded users to `/`.

## FINDINGS / test hazards

- Google buttons are **build-time env-gated** — not in the baseline suite.
- Redirect guards make `/login`, `/signup` (→`/` if authed), `/reset-password`, `/onboarding` (→`/login`
  if not authed) conditionally unreachable — the authenticated regression session can't hit the form pages.
- Onboarding writes directly to Supabase + calls `/api/account/subscribe`; PricingCards needs `GET /api/tiers`
  — any failure dead-ends the step. Needs a disposable test user + cleanup to exercise fully.
- PasswordInput toggle is `tabIndex=-1` (not keyboard-reachable); its accessible name flips Show↔Hide.
- "Choose" CTA repeats per tier (strict-mode ambiguity) — scope by tier card.
