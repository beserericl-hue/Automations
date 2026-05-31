---
name: Middleware
description: requireAuth, requireAdmin/Superuser, requireTierFeature, requireCredits, shared-secret factory, validate.
type: concept
tags: [backend, middleware, auth]
last_reviewed: 2026-05-09
---

# Middleware

`server/src/middleware/`. Five files.

## auth.ts

[`server/src/middleware/auth.ts`](../../../../writers-workbench/server/src/middleware/auth.ts).

### `requireAuth`

```ts
async function requireAuth(req, res, next) {
  // 1. Pull JWT from Authorization: Bearer
  const jwt = req.headers.authorization?.split(' ')[1];
  if (!jwt) return res.status(401).json({error:'Unauthorized'});

  // 2. Validate via supabase.auth.getUser
  const { data: { user: authUser } } = await supabase.auth.getUser(jwt);
  if (!authUser) return res.status(401);

  // 3. Load users_v2 row by supabase_auth_uid
  const userRow = await supabaseAdmin.from('users_v2').select('*').eq('supabase_auth_uid', authUser.id).maybeSingle();
  if (!userRow.data) return res.status(404).json({error:'No profile — complete onboarding'});

  // 4. Load role meta + account meta + subscription in parallel
  const [roleMeta, accountMeta, subscription] = await Promise.all([...]);

  // 5. Compute effective role: meta.role OR users_v2.role OR 'user'
  const effectiveRole = roleMeta?.role ?? userRow.data.role ?? 'user';

  // 6. Block if account_status != 'active' (superuser bypass)
  if (accountMeta?.account_status && accountMeta.account_status !== 'active' && effectiveRole !== 'superuser') {
    return res.status(403).json({error:`Account ${accountMeta.account_status}`});
  }

  // 7. Honor X-Impersonate-User header
  const impersonateHeader = req.headers['x-impersonate-user'];
  let userId = userRow.data.user_id;
  let isImpersonating = false;
  if (impersonateHeader && effectiveRole === 'superuser') {
    const activeImpersonation = await supabaseAdmin.from('impersonation_log')
      .select('id').eq('superuser_id', userId).is('ended_at', null).maybeSingle();
    if (activeImpersonation.data) {
      userId = impersonateHeader;
      isImpersonating = true;
    }
  }

  // 8. Attach to req
  req.userId = userId;
  req.role = effectiveRole;
  req.accountStatus = accountMeta?.account_status ?? 'active';
  req.subscription = subscription?.data;
  req.isImpersonating = isImpersonating;
  next();
}
```

### Variants

```ts
function requireAdmin(req, res, next) {
  if (!['admin','superuser'].includes(req.role)) return res.status(403);
  next();
}

function requireSuperuser(req, res, next) {
  if (req.role !== 'superuser') return res.status(403);
  next();
}

function requireTierFeature(featureName: string) {
  return (req, res, next) => {
    const tierFeatures = req.subscription?.tier?.features ?? {};
    if (!tierFeatures[featureName]) return res.status(403).json({error:`Feature '${featureName}' not in your tier`});
    next();
  };
}

function requireCredits(opName: string) {
  return async (req, res, next) => {
    const cost = await getOpCost(opName);   // reads app_config_v2.sprint8_superuser_config.credit_costs
    if ((req.subscription?.credits_remaining ?? 0) < cost) {
      return res.status(402).json({
        error:'INSUFFICIENT_CREDITS',
        creditsRequired: cost,
        creditsRemaining: req.subscription?.credits_remaining ?? 0
      });
    }
    req.opCost = cost;
    next();
  };
}
```

`requireCredits` does NOT deduct — it pre-flights. Deduction happens after the operation succeeds (in chat.ts and elsewhere). Header set on response: `X-Credits-Remaining`.

## error-handler.ts

[`server/src/middleware/error-handler.ts`](../../../../writers-workbench/server/src/middleware/error-handler.ts). Final middleware — catches any error thrown in upstream handlers and returns JSON.

```ts
function errorHandler(err, req, res, next) {
  logger.error({err, url: req.url, userId: req.userId}, 'request error');
  if (err instanceof ZodError) return res.status(400).json({error:'validation', issues: err.issues});
  if (err.statusCode) return res.status(err.statusCode).json({error: err.message});
  res.status(500).json({error:'Internal server error'});
}
```

## shared-secret.ts

[`server/src/middleware/shared-secret.ts`](../../../../writers-workbench/server/src/middleware/shared-secret.ts). Factory:

```ts
function requireSecret(headerName: string, envVar: string) {
  return (req, res, next) => {
    const expected = process.env[envVar];
    if (!expected) return res.status(503).json({error:`${envVar} not configured`});
    const actual = req.headers[headerName.toLowerCase()];
    if (actual !== expected) return res.status(401).json({error:'Bad secret'});
    next();
  };
}
```

Used for n8n→server callbacks:
- `/api/email/send` → `requireSecret('X-Email-Secret', 'EMAIL_SECRET')`
- `/api/ingestion/*` → `requireSecret('X-Ingestion-Secret', 'INGESTION_SECRET')`
- `/api/approvals/:token` → `requireSecret('X-Approval-Secret', 'APPROVAL_SECRET')`
- `/api/cron/*` → `requireSecret('X-Cron-Secret', 'CRON_SECRET')` — currently 503 (unset)
- `/api/newsletter/cron-callback` → `requireSecret('X-Newsletter-Callback-Secret', 'NEWSLETTER_CALLBACK_SECRET')`

## validate.ts

[`server/src/middleware/validate.ts`](../../../../writers-workbench/server/src/middleware/validate.ts). Generic Zod validator:

```ts
function validate(schema: ZodSchema, source: 'body'|'query'|'params' = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return res.status(400).json({error:'validation', issues: result.error.issues});
    req[source] = result.data;   // typed + transformed
    next();
  };
}
```

Schemas in `schemas.ts`. Examples:
- `OnboardSchema`
- `SubscribeSchema`
- `IngestionUploadSchema`, `IngestionKeySchema`, `IngestionSearchQuerySchema`
- `RewriteWithResearchSchema`
- `AnnotationApplySchema`
- `AdminUserUpdateSchema`, `AdminUserFullUpdateSchema`
- `CreateUserWithSubscriptionSchema`
- `EmailSendSchema`
- `DeleteAccountSchema`

## Per-tier policies

| Concern | Mechanism |
|---------|-----------|
| Tier-feature gating | `requireTierFeature(featureName)` reads `subscription.tier.features` |
| Credit gating | `requireCredits(opName)` reads `subscription.credits_remaining` vs `app_config_v2.sprint8_superuser_config.credit_costs` |
| Admin gating | `requireAdmin` (effective role admin/superuser) |
| Superuser gating | `requireSuperuser` (effective role === superuser) |
| Account-status gating | Inside `requireAuth` — blocks locked/suspended/pending unless superuser |

## Common gotchas

- **`requireAuth` MUST run before Zod validation** so 401s have a meaningful body.
- **`req.userId` is the impersonation-aware id** — use it for ALL scoping. Never use `req.user.id` (auth UUID) or rely on the JWT `sub`.
- **`requireCredits` does not deduct** — call `deductCredits()` after success. If you skip, ops are free.
- **`requireSecret` returns 503 when env var unset** — distinguishes from 401 "wrong secret." Useful diagnostic.
- **`X-Impersonate-User` without an active impersonation_log row** is silently ignored. Doubly-defended.
- **Trigger `prevent_role_meta_escalation`** still fires even if the JWT has admin role — only superuser-via-direct-call OR service-role (with `auth.uid() IS NULL`) can write to user_role_meta_v2.
