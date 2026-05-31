---
name: Multi-tenancy
description: Tenant isolation model for the B2B backend. API key resolution, RLS-equivalent enforcement, data leakage prevention, deletion semantics.
type: concept
tags: [architecture, python-backend, multi-tenancy, security]
last_reviewed: 2026-05-09
---

# Multi-tenancy

Author Agent API serves both:
- **Internal callers** (Workbench, n8n hub) via `/internal/*` — no tenancy; uses existing user_id-scoped Supabase RLS.
- **External customers** (B2B) via `/v1/*` — strict tenancy isolation. Every operation scoped to `tenant_id`.

This page is about the external `/v1/*` model.

## Data model

### `tenants_v2`

```sql
CREATE TABLE tenants_v2 (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  subscription_tier text NOT NULL CHECK (subscription_tier IN ('free','starter','pro','scale','enterprise')),
  stripe_customer_id text,
  monthly_token_cap int NOT NULL,
  rpm_cap         int NOT NULL,
  features        jsonb NOT NULL DEFAULT '{}',
  webhook_secret  text NOT NULL,             -- for outgoing webhook signatures
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  deleted_at      timestamptz
);
```

### `api_keys_v2`

```sql
CREATE TABLE api_keys_v2 (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants_v2(id) ON DELETE CASCADE,
  key_prefix      text NOT NULL,             -- e.g. 'aa_live_abc123' (first 14 chars; visible)
  key_hash        text NOT NULL,             -- argon2id hash of full key
  label           text,                       -- user-visible label
  created_at      timestamptz DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);

CREATE UNIQUE INDEX api_keys_prefix_idx ON api_keys_v2 (key_prefix) WHERE revoked_at IS NULL;
```

### `api_usage_v2`

```sql
CREATE TABLE api_usage_v2 (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants_v2(id),
  api_key_id      uuid REFERENCES api_keys_v2(id),
  endpoint        text NOT NULL,
  request_id      text NOT NULL,
  status_code     int NOT NULL,
  input_tokens    int DEFAULT 0,
  output_tokens   int DEFAULT 0,
  llm_used        text,                       -- 'claude-sonnet-4-5' | 'claude-haiku-4-5' | 'perplexity' | etc.
  cost_usd        numeric NOT NULL DEFAULT 0,
  duration_ms     int,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX api_usage_tenant_time ON api_usage_v2 (tenant_id, created_at);
```

Aggregated nightly into Stripe usage records.

### Tenant-scoped tables

All existing `*_v2` tables that hold customer data get a `tenant_id` column added:

```sql
-- Migration 020: tenant_id additions for B2B
ALTER TABLE writing_projects_v2 ADD COLUMN tenant_id uuid REFERENCES tenants_v2(id);
ALTER TABLE published_content_v2 ADD COLUMN tenant_id uuid REFERENCES tenants_v2(id);
ALTER TABLE story_bible_v2 ADD COLUMN tenant_id uuid REFERENCES tenants_v2(id);
ALTER TABLE research_reports_v2 ADD COLUMN tenant_id uuid REFERENCES tenants_v2(id);
ALTER TABLE generated_images_v2 ADD COLUMN tenant_id uuid REFERENCES tenants_v2(id);
ALTER TABLE social_posts_v2 ADD COLUMN tenant_id uuid REFERENCES tenants_v2(id);
ALTER TABLE outline_versions_v2 ADD COLUMN tenant_id uuid REFERENCES tenants_v2(id);
ALTER TABLE content_versions_v2 ADD COLUMN tenant_id uuid REFERENCES tenants_v2(id);
ALTER TABLE token_usage_v2 ADD COLUMN tenant_id uuid REFERENCES tenants_v2(id);
```

**WAIT** — this is forbidden by [[base-tables|schema governance]] for migrations ≥008 on base tables.

**Resolution:** the Workbench schema can NOT be retroactively tenant-aware via base table mutations. Two options:

1. **Maintain two schemas:** Workbench (existing, user-id-scoped) + B2B (new tenant-id-scoped). Backend service queries the right one based on auth path.
2. **Add tenant_id via meta tables:** new `tenant_resource_meta_v2 (tenant_id, resource_type, resource_id)` mapping. Less ergonomic but governance-compliant.

**Recommended: Option 1 (two schemas).**

```
Schema A (Workbench): user_id-scoped existing tables. RLS via get_current_user_id().
Schema B (B2B):       tenant_id-scoped new tables. RLS via get_current_tenant_id().
```

The base Schema A tables remain immutable. Schema B is a fresh set: `b2b_writing_projects_v2`, `b2b_published_content_v2`, etc. — same shape but tenant-scoped from the start.

This costs schema duplication but preserves governance + clean isolation. Worth the trade.

For Phase 1 (internal Workbench only on the Python backend), Schema A is the only thing exercised. Schema B is added in Phase 3 (B2B GA).

## Auth flow (`/v1/*`)

```
1. Request arrives with `Authorization: Bearer aa_live_abc123def456...`

2. Extract key prefix (first 14 chars: `aa_live_abc123`).

3. Lookup api_keys_v2 WHERE key_prefix = ? AND revoked_at IS NULL
   → Returns row with key_hash.

4. Verify argon2id hash of full provided key against stored hash.
   → Constant-time comparison.

5. Resolve tenant_id from the row.

6. Lookup tenants_v2 WHERE id = ? AND status = 'active' AND deleted_at IS NULL.
   → Returns tier, monthly_token_cap, rpm_cap, features.

7. Check rate limit: Redis `rl:{tenant_id}:{minute}` counter against rpm_cap.
   → If exceeded: 429 RATE_LIMITED.

8. Check feature gate: if endpoint requires feature not in tier → 403 FORBIDDEN.

9. Inject context: req.state.tenant_id = tenant_id; req.state.tier = tier.

10. Call route handler. Every DB query must filter by req.state.tenant_id.

11. After response: INSERT api_usage_v2 with tenant_id, tokens, cost.
```

API key prefix format: `aa_live_<random>` for production; `aa_test_<random>` for sandbox.

### Why argon2id

Slow on purpose (~100ms verify). Mitigates timing attacks + brute force. Trade vs SHA-256 (fast): we accept ~100ms auth overhead for the security benefit. Cached for the duration of the request.

For frequently-used keys: cache `(prefix, hash, tenant_id)` in Redis with 5-min TTL after first verification. Reduces auth latency for hot keys.

## Tenant scoping enforcement

**Three layers:**

### Layer 1 — Code review

Every database query in B2B routes goes through a wrapper:

```python
def db(req: Request) -> SupabaseTenantClient:
    """Tenant-aware Supabase client. Auto-injects tenant_id filter."""
    return SupabaseTenantClient(req.state.tenant_id, supabase_client)

# Usage:
@router.post("/v1/chapters/write")
async def write_chapter(req: Request, body: WriteChapterRequest):
    project = await db(req).from_('b2b_writing_projects_v2').select('*').eq('id', body.project_id).single()
    # Auto-applies: .eq('tenant_id', req.state.tenant_id)
```

`SupabaseTenantClient` is a wrapper enforcing tenant_id on every operation. No raw `supabase.from(...)` allowed in B2B routes. Lint rule prevents.

### Layer 2 — Postgres RLS

Even though backend uses service-role (bypasses RLS), defensive RLS policies on B2B tables:

```sql
ALTER TABLE b2b_writing_projects_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON b2b_writing_projects_v2
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

Service role bypasses, but `app.tenant_id` is set per-connection at request entry:

```python
async with supabase.transaction() as tx:
    await tx.execute("SELECT set_config('app.tenant_id', %s, true)", [str(req.state.tenant_id)])
    # all queries within transaction now have RLS
```

If code accidentally uses raw client without setting app.tenant_id → RLS rejects. Defense-in-depth.

### Layer 3 — Test enforcement

Mandatory integration test for every B2B endpoint:

```python
async def test_chapters_write_does_not_leak_across_tenants():
    tenant_a = await create_test_tenant("A")
    tenant_b = await create_test_tenant("B")
    project_a = await create_test_project(tenant_a)

    # Tenant B tries to write a chapter on tenant A's project
    response = await client.post(
        "/v1/chapters/write",
        headers={"Authorization": f"Bearer {tenant_b.api_key}"},
        json={"project_id": str(project_a.id), ...}
    )

    assert response.status_code == 404  # NOT 403; don't leak existence
    assert "NOT_FOUND" in response.json()["error"]
```

Every endpoint in B2B surface needs a parallel cross-tenant test.

## Privacy: 404 vs 403 on cross-tenant access

Cross-tenant access returns **404 NOT_FOUND**, not 403 FORBIDDEN. This prevents leaking the existence of resources the caller doesn't own.

If tenant B can probe `/v1/projects/{id}` and get 403 → they know that ID exists somewhere. If 404 → they can't distinguish "doesn't exist" from "owned by someone else."

## Tenant deletion (GDPR right-to-erasure)

When a tenant requests deletion:

```
1. Customer hits /v1/account/delete (or admin invokes /admin/tenants/{id}/delete).

2. Validate confirmation (typed "DELETE" or admin-token).

3. Set tenants_v2.status = 'deleted', deleted_at = now(). Tenant immediately suspended.

4. Background job (cron-group) processes deletion queue:
   - DELETE all rows from b2b_* tables WHERE tenant_id = ?
   - DELETE from Supabase Storage buckets all objects under <tenant_id>/ prefix
   - DELETE api_keys_v2 rows for tenant
   - DELETE api_usage_v2 rows older than 90 days; aggregate the rest into a summary row for billing record-keeping
   - DELETE webhook_deliveries for tenant
   - Stripe customer.delete via Stripe API (or mark canceled if billing record needed)

5. Soft-delete becomes hard after 30 days (cooling-off for accidental deletes).

6. Audit trail: tenant_deletion_log row inserted (id, requested_at, completed_at, requester).
```

Idempotent: re-running the deletion job on an already-deleted tenant is a no-op.

## Tenant data export

Customer hits `/v1/account/export` → backend kicks off async export job:

```
1. INSERT job_queue_v2 row, type='tenant_export', tenant_id=X.

2. Background worker:
   - SELECT all rows from b2b_* tables WHERE tenant_id = X.
   - Bundle into JSON files per table.
   - Pack into zip + upload to private export bucket with 7-day expiry signed URL.
   - Email customer the signed URL.

3. Job completes; signed URL expires after 7 days.
```

Self-service. No manual ops involvement.

## Storage isolation

Supabase Storage buckets gain tenant prefix:

```
b2b-cover-images/
├── tnt_abc/
│   ├── proj_def/
│   │   ├── chapter_001.png
│   │   └── chapter_002.png
└── tnt_ghi/
    └── ...
```

RLS policies on `storage.objects`:

```sql
CREATE POLICY tenant_isolation_b2b ON storage.objects FOR ALL
  USING (
    bucket_id LIKE 'b2b-%'
    AND (storage.foldername(name))[1] = current_setting('app.tenant_id', true)
  );
```

## Prompt isolation

Customers in Scale + Enterprise tiers can override default prompts. Stored as:

```sql
CREATE TABLE tenant_prompts_v2 (
  tenant_id   uuid NOT NULL REFERENCES tenants_v2(id) ON DELETE CASCADE,
  prompt_name text NOT NULL,            -- 'chapter_writer.system' | 'continuity_merge.system' | ...
  prompt_text text NOT NULL,
  updated_at  timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, prompt_name)
);
```

Resolution at request time:

```python
async def resolve_prompt(name: str, tenant_id: uuid | None) -> str:
    if tenant_id:
        custom = await get_tenant_prompt(tenant_id, name)
        if custom: return custom
    return get_default_prompt(name)
```

Default prompts in `app_config_v2.prompts` (Workbench-side) or filesystem.

## Webhook isolation

Each tenant has their own `webhook_secret` (rotated on demand via `/v1/webhooks/rotate-secret`). Outgoing webhook signatures use that tenant's secret. Tenants can't impersonate each other's webhooks.

Inbound webhook deliveries (when we send to customer's webhook URL) verify their signature using the same secret. Cross-tenant signature reuse impossible.

## Audit logging

Every B2B mutation produces an audit row:

```sql
CREATE TABLE tenant_audit_log_v2 (
  id          uuid PK,
  tenant_id   uuid NOT NULL,
  api_key_id  uuid,
  action      text NOT NULL,           -- 'chapter.write' | 'api_key.create' | 'tenant.suspend' | etc.
  resource    text,                     -- 'chapter:abc123' | 'api_key:def456' | etc.
  ip          inet,
  user_agent  text,
  request_id  text NOT NULL,
  details     jsonb,
  created_at  timestamptz DEFAULT now()
);
```

Customer can fetch their own log via `GET /v1/account/audit-log` (filtered to their tenant_id; SOC 2 compliance evidence).

## Rate limiting

Per-tenant rate limit at the API layer (Redis sliding window):

```python
async def check_rate_limit(tenant_id: uuid, rpm_cap: int) -> RateLimitResult:
    key = f"rl:{tenant_id}:{minute_bucket()}"
    count = await redis.incr(key)
    await redis.expire(key, 70)
    if count > rpm_cap:
        return RateLimitResult(allowed=False, remaining=0, reset_at=next_minute_boundary())
    return RateLimitResult(allowed=True, remaining=rpm_cap - count, reset_at=next_minute_boundary())
```

Headers always returned: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. 429 when exceeded.

Tenant-level token-budget gate also exists (vs. monthly cap):
- 90% used → warning email + dashboard alert.
- 100% used → 402 INSUFFICIENT_CREDITS for `/v1/*` endpoints. Customer must increase tier or wait for next period.

## Tenant suspension

Admin can suspend a tenant via `POST /admin/tenants/{id}/suspend {reason}`:

```
1. UPDATE tenants_v2 SET status = 'suspended'.
2. Invalidate Redis auth cache for tenant.
3. New requests return 403 FORBIDDEN with reason.
4. In-flight jobs complete (we don't kill running work).
5. Webhook deliveries paused.
6. Stripe billing paused (no metering during suspension).
```

Resume via `POST /admin/tenants/{id}/resume`.

Reasons for suspension:
- Payment failure (auto, after 3 retries).
- Abuse (manual, ops decision).
- Customer request.

## Cross-tenant secret leakage prevention

Code patterns enforced:

1. **Never log API keys.** Logger middleware redacts `Authorization` headers.
2. **Never include API key in error responses.**
3. **Never expose another tenant's webhook_secret** even via error message.
4. **API key visible to customer once at creation.** After that, only `key_prefix` shown. To "view" again, customer rotates.

Code review enforced via lint rule + automated test scanning logs for key leaks.

## Defense-in-depth summary

| Layer | Protection |
|---|---|
| API key auth | Argon2id; can't be forged |
| Auth cache | Short-lived (5 min); invalidated on key revocation |
| Application-level filter | Wrapper client auto-filters by tenant_id |
| Postgres RLS | `app.tenant_id` enforced at DB |
| Test suite | Cross-tenant isolation tests for every endpoint |
| Storage RLS | `(storage.foldername(name))[1]` matches tenant_id |
| Webhook secrets | Per-tenant rotation |
| Audit log | Full mutation history per tenant |
| Tenant suspension | Single switch disables all access |
| Tenant deletion | Background sweep cleans all data |

If any single layer fails, others contain the breach.

## Implementation phases

| Phase | Multi-tenancy work |
|---|---|
| Phase 1 (internal migration) | None — Workbench `/internal/*` only |
| Phase 2 (cross-chapter + new capabilities) | Tenant_id added to new tables only (no migration of existing) |
| Phase 3 (B2B beta) | Schema B (b2b_*) tables created; auth flow + tenant resolution; cross-tenant tests; rate limiting |
| Phase 4 (B2B GA) | Audit log; data export; deletion; storage RLS; webhook isolation; tier-based feature gating |
| Phase 5 (Enterprise) | Custom prompts; SOC 2 evidence; self-hosted option |

See [[python-migration-roadmap]].
