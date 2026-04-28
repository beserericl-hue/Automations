# Railway Deployment Reference

**Scope:** Every service that will run on Railway across the full Writer's Workbench architecture. Organized by sprint so you know when each gets deployed.

**Current state (as of 2026-04-19):** 2 services deployed (prod + dev Workbench). The rest come online across Sprints 10.a, 10.b, 11, 13, Newsletter Agent Migration.

---

## Complete service inventory

| # | Service name | Image | Purpose | Sprint |
|---|-------------|-------|---------|--------|
| 1 | `writers-workbench` | (custom Dockerfile) | Production Express + React | ✅ deployed |
| 2 | `writers-workbench-dev` | (custom Dockerfile) | Development Express + React | ✅ deployed |
| 3 | `redis` | `redis:7-alpine` | BullMQ job queue + SSE session store | 10.b |
| 4 | `postal-mariadb` | `mariadb:10.11` | Postal metadata DB | Newsletter / Sprint 11 |
| 5 | `postal-rabbitmq` | `rabbitmq:3-management` | Postal internal job queue | Newsletter / Sprint 11 |
| 6 | `postal` | `ghcr.io/postalserver/postal:3` | Email server for `@courseworx.media` | Newsletter / Sprint 11 |
| 7 | `n8n-prod` | `n8nio/n8n:latest` | n8n prod tier (standalone with embedded SQLite OR bound to own Postgres) | 13 |
| 8 | `n8n-prod-postgres` | `postgres:16-alpine` | n8n-prod's execution data (optional — can use SQLite instead) | 13 |
| 9 | `n8n-dev` | `n8nio/n8n:latest` | n8n dev tier (separate instance, separate DB, separate webhooks) | 13 |
| 10 | `n8n-dev-postgres` | `postgres:16-alpine` | n8n-dev's execution data (optional) | 13 |
| 11+ | `n8n-prod-2`, `n8n-prod-3`, ... | `n8nio/n8n:latest` | Additional prod-tier standalone instances added as user volume grows. Each independent, each routed via partitioning logic in Workbench. | 13+ |

**Total at full buildout (2 n8n tiers): 10 services.** Each additional n8n instance for scale adds 1 container (+ optionally 1 Postgres if using PG over SQLite) = ~$25/mo per instance.

**NOT on Railway** (SaaS or external):
- Supabase (3 projects: V1 baseline / V2 prod / Dev) — SaaS
- ElevenLabs (3 agents: V1 / V2 / Dev) — SaaS
- GitHub Actions CI — SaaS
- Resend/SendGrid — not using (self-hosted Postal instead)
- Cloudflare R2 — SaaS (optional, Sprint 14)

---

## Phase-by-phase setup

### Phase 1 — Already deployed (no action needed)

**Service 1: `writers-workbench` (production)**
- Source: GitHub `main` branch, builds via `writers-workbench/Dockerfile`
- Public domain: `writers-workbench.up.railway.app` (or your custom domain)
- Branch: `main`
- Auto-deploy: ON

**Service 2: `writers-workbench-dev`**
- Source: GitHub `develop` branch, same Dockerfile
- Public domain: `writers-workbench-dev.up.railway.app`
- Branch: `develop`
- Auto-deploy: ON

---

### Phase 2 — Redis (Sprint 10.b)

**Service 3: `redis`**

Setup steps:
1. Railway dashboard → `writers-workbench` project → **New** → **Database** → **Add Redis** (or deploy from image)
2. If deploying from image manually:
   - **New** → **Deploy from Docker Image** → `redis:7-alpine`
   - Networking → Private (no public endpoint)
   - Storage → New Volume, 1 GB, mount at `/data`
   - Start command (override default to enable persistence):
     ```
     redis-server --appendonly yes --dir /data
     ```
3. No env vars to set on the Redis service itself
4. Capture the private connection URL: `redis://default:<password>@redis.railway.internal:6379` (Railway auto-generates)

**Add to `writers-workbench` service env:**
```
REDIS_URL=redis://default:<password>@redis.railway.internal:6379
```

**Add to `writers-workbench-dev` service env:**
```
REDIS_URL=<dev-redis-url-if-separate-or-same>
```
(If cost-sensitive, prod and dev can share one Redis with different BullMQ queue prefixes — Sprint 10.b S10b-1 decides this.)

---

### Phase 3 — Postal email stack (Newsletter Sprint S7 / Sprint 11)

Three services deploy together. Order matters: MariaDB first, then RabbitMQ, then Postal.

#### Service 4: `postal-mariadb`

1. **New** → **Deploy from Docker Image** → `mariadb:10.11`
2. Environment:
   ```
   MARIADB_ROOT_PASSWORD=<openssl rand -base64 24>
   MARIADB_DATABASE=postal
   MARIADB_USER=postal
   MARIADB_PASSWORD=<openssl rand -base64 24>
   ```
3. Storage → New Volume, 5 GB, mount at `/var/lib/mysql`
4. Networking → Private only
5. Capture internal hostname: `postal-mariadb.railway.internal`

#### Service 5: `postal-rabbitmq`

1. **New** → **Deploy from Docker Image** → `rabbitmq:3-management`
2. Environment:
   ```
   RABBITMQ_DEFAULT_USER=postal
   RABBITMQ_DEFAULT_PASS=<openssl rand -base64 24>
   RABBITMQ_DEFAULT_VHOST=postal
   ```
3. Storage → New Volume, 1 GB, mount at `/var/lib/rabbitmq`
4. Networking → Private only
5. Capture internal hostname: `postal-rabbitmq.railway.internal`

#### Service 6: `postal`

1. **New** → **Deploy from Docker Image** → `ghcr.io/postalserver/postal:3`
2. Environment (populate with captured values from services 4 and 5):
   ```
   POSTAL_SIGNING_KEY=<openssl rand -hex 64>
   MAIN_DB_HOST=postal-mariadb.railway.internal
   MAIN_DB_USERNAME=postal
   MAIN_DB_PASSWORD=<from service 4>
   MAIN_DB_DATABASE=postal
   MESSAGE_DB_HOST=postal-mariadb.railway.internal
   MESSAGE_DB_USERNAME=postal
   MESSAGE_DB_PASSWORD=<from service 4>
   MESSAGE_DB_PREFIX=postal
   RABBITMQ_HOST=postal-rabbitmq.railway.internal
   RABBITMQ_USERNAME=postal
   RABBITMQ_PASSWORD=<from service 5>
   RABBITMQ_VHOST=postal
   RAILS_ENV=production
   ```
3. Config file → mount `/config/postal.yml` with the template from Newsletter sprint doc Appendix A (Postal needs this file)
4. Public domain → attach `postal-admin.courseworx.media`
5. Initial command (run once, via Railway shell):
   ```
   postal initialize-config && postal initialize && postal make-user
   ```
6. Main command: `postal start`
7. After it's up → visit `https://postal-admin.courseworx.media` → create organization, mail server, sending domain `courseworx.media`
8. Publish 6 DNS records on `courseworx.media` (DKIM, SPF, verification, return-path, DMARC — all shown in Postal admin UI)
9. Generate API credential in Postal → save as env var on `writers-workbench` + `writers-workbench-dev`:

**Add to `writers-workbench` and `writers-workbench-dev` envs:**
```
POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1
POSTAL_API_KEY=<from Postal admin UI>
EMAIL_SECRET=<openssl rand -hex 32>
SENDER_EMAIL=eve@courseworx.media
SENDER_NAME=The Writers Workbench
REPLY_TO_EMAIL=support@courseworx.media
```

---

### Phase 4 — n8n migration to Railway (Sprint 13) — **Independent Instances Model**

Currently n8n runs at `n8n.agileadautomation.com` (external infra). Sprint 13 moves it to Railway as **independent standalone instances** rather than n8n's queue mode (main + workers).

**Why independent instances instead of queue mode?** Queue mode requires shared state (Postgres + Redis) across workers, a single encryption key, and careful ops coordination — any change propagates to all workers instantly. We're taking a different model: **each n8n instance is fully self-contained** — its own database, own workflows, own webhooks. When we need more capacity, we launch another full instance. Routing to the right instance is the caller's responsibility (the Workbench Express server, or a router service in front).

**Trade-off:**
- ✅ Full isolation — one instance failure can't cascade
- ✅ Simpler to reason about (no shared state bugs)
- ✅ Can run different n8n versions per instance (blue-green friendly)
- ❌ Workflow changes must be applied to each instance separately (sync via n8n API)
- ❌ Routing logic needed at caller layer

Initial deployment = **2 standalone instances** (prod tier + dev tier). Each handles its own users. Scale adds more prod instances as user count grows.

---

#### Service 7: `n8n-prod` (production-tier standalone)

1. **New** → **Deploy from Docker Image** → `n8nio/n8n:latest`
2. Storage → **New Volume**, 5 GB, mount at `/home/node/.n8n`
   - This is where n8n stores its SQLite DB, credentials, and workflow data
   - Using SQLite (default) keeps this instance fully self-contained — no external Postgres needed
3. Environment:
   ```
   N8N_HOST=n8n.agileadautomation.com
   N8N_PORT=5678
   N8N_PROTOCOL=https
   WEBHOOK_URL=https://n8n.agileadautomation.com
   GENERIC_TIMEZONE=America/New_York
   N8N_ENCRYPTION_KEY=<openssl rand -hex 64>   # UNIQUE per instance
   
   # DB: SQLite (default — on the mounted volume)
   # Override to Postgres only if you need concurrent reads beyond what SQLite provides
   
   # Externalized workflow credentials (Sprint 13 S13-1) — replaces hardcoded values in Code nodes
   N8N_SUPABASE_URL=<V2 Supabase URL>
   N8N_SUPABASE_SERVICE_KEY=<V2 service role key>
   N8N_ANTHROPIC_API_KEY=sk-ant-...
   N8N_PERPLEXITY_API_KEY=pplx-...
   N8N_OPENAI_API_KEY=sk-proj-...
   N8N_KIEAI_API_KEY=<KIE.AI key>
   N8N_FIRECRAWL_API_KEY=fc-...
   N8N_WORKBENCH_API_URL=https://writers-workbench.up.railway.app
   N8N_POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1
   N8N_POSTAL_API_KEY=<Postal API key>
   ```
4. Public domain → attach `n8n.agileadautomation.com` (currently this is where the external n8n lives; DNS cutover at migration time)
5. Command: `n8n start` (default)
6. After boot: log in via n8n UI, set admin credentials, import V2 workflows from repo JSONs (or migrate from the existing external n8n via workflow export/import)
7. **Capture N8N API key** (Settings → API → Create API Key) → save as `N8N_PROD_API_KEY` env on the Workbench

#### Service 8 (optional): `n8n-prod-postgres`

Only deploy if you've outgrown SQLite. Most single-instance deployments don't need this.

1. **New** → **Database** → **Add PostgreSQL**, OR image `postgres:16-alpine`
2. Storage: 10 GB volume at `/var/lib/postgresql/data`
3. Env: `POSTGRES_USER=n8n`, `POSTGRES_PASSWORD`, `POSTGRES_DB=n8n`
4. Add to `n8n-prod` service env:
   ```
   DB_TYPE=postgresdb
   DB_POSTGRESDB_HOST=n8n-prod-postgres.railway.internal
   DB_POSTGRESDB_PORT=5432
   DB_POSTGRESDB_DATABASE=n8n
   DB_POSTGRESDB_USER=n8n
   DB_POSTGRESDB_PASSWORD=<from postgres service>
   ```

#### Service 9: `n8n-dev` (dev-tier standalone)

Identical pattern to `n8n-prod`, but completely separate:
1. Same image, same setup, own Volume (5 GB)
2. Public domain → `n8n-dev.agileadautomation.com` (new subdomain)
3. Env: **unique `N8N_ENCRYPTION_KEY`** (must not match prod), `WEBHOOK_URL=https://n8n-dev.agileadautomation.com`
4. Points at Dev Supabase in `N8N_SUPABASE_URL` (not V2)
5. Add to Workbench dev env: `VITE_N8N_WEBHOOK_URL=https://n8n-dev.agileadautomation.com/webhook/author_request_dev`

#### Service 10 (optional): `n8n-dev-postgres` — same optional pattern as Service 8

---

#### Scaling beyond 2 instances — when user volume demands it

When the single `n8n-prod` starts saturating (typical sign: executions queuing up past 30s, webhook timeouts), the path forward is more standalone prod instances:

1. Deploy `n8n-prod-2` (same pattern as `n8n-prod`, own volume, own encryption key, own webhook URL)
2. Import the same V2 workflows into it (via n8n API — `scripts/sync-workflows-across-instances.sh` would be Sprint 13 scope)
3. Add its webhook URL to the Workbench's instance routing table (see Load Balancing section below)
4. Partition users across instances (user_id hash → instance)

**Each additional instance adds ~$20-25/mo to Railway cost.** Plan for one instance per ~100-500 concurrent users depending on workflow intensity — chapter writes (long-running) are much more expensive than sync ops.

**Sync discipline:** Any workflow change must be applied to ALL prod instances. Sprint 10.a's promotion scripts (`scripts/promote-dev-to-v2.sh`) need to iterate across every prod instance's n8n API when promoting. Track instance list in `scripts/n8n-instances.json`.

---

## Load balancer question — **YES, eventually needed for n8n fleet**

Since we're using **independent n8n instances** (not queue mode), routing decisions are now real. Here's the breakdown by layer.

### Layer 1 — Workbench Express: no separate LB needed

Railway auto-balances across replicas of the same service. When the `writers-workbench` service needs more capacity, set replica count = 2 or 3 in Railway; Railway's edge proxy round-robins. Stateless Express requests — works cleanly.

### Layer 2 — Postal, Redis, Postgres: no LB needed

All single-instance services (or, for Postgres, single-primary with eventual read replicas). No load balancing.

### Layer 3 — n8n instances: **this is where routing happens**

At **1 instance**: no LB. `n8n.agileadautomation.com` DNS points at one Railway service. Done.

At **2+ prod instances**, three options:

| Option | Where routing lives | Complexity | When to use |
|--------|---------------------|-----------|-------------|
| **A. Workbench routes via user partition** | Express server's chat proxy picks instance based on `user_id` hash | Low — just code in Workbench | Best for us. Deterministic per-user routing; same user always hits same instance. |
| **B. Cloudflare Load Balancer** in front | External SaaS — round-robins or weighted routing between Railway domains | Medium — requires Cloudflare DNS + LB product ($5/mo) | When we want round-robin or geo-routing without touching code |
| **C. Nginx/HAProxy sidecar on Railway** | New Railway service runs Nginx, fronts multiple n8n instances | Medium-high — another service to maintain, custom config | Only if we need path-based routing (e.g., `/webhook/chapter/*` → instance A, `/webhook/brainstorm/*` → instance B) |

**Recommendation: Option A (Workbench routes).** Reasoning:
1. We already have a single entry point in the Workbench chat proxy — just extend it
2. User-partition routing keeps the "same user always hits same n8n" invariant (useful for n8n's in-flight execution state with chat memory, session keys, etc.)
3. Zero new services to deploy
4. Config: a JSON file `writers-workbench/server/src/config/n8n-instances.json` listing instance URLs and their load shares

Skeleton for Option A:

```typescript
// server/src/lib/n8n-router.ts
const instances = [
  { url: 'https://n8n.agileadautomation.com', weight: 1 },
  { url: 'https://n8n-2.agileadautomation.com', weight: 1 },
  { url: 'https://n8n-3.agileadautomation.com', weight: 1 },
];

export function pickN8nInstance(userId: string): string {
  const hash = simpleHash(userId);
  const totalWeight = instances.reduce((s, i) => s + i.weight, 0);
  const pick = hash % totalWeight;
  let acc = 0;
  for (const inst of instances) {
    acc += inst.weight;
    if (pick < acc) return inst.url;
  }
  return instances[0].url;
}
```

Chat proxy then POSTs to `${pickN8nInstance(userId)}/webhook/author_request_v2`.

### Layer 4 — Prod vs Dev tiers

Always separate webhooks, never balanced together:
- Prod Workbench → `pickN8nInstance(userId)` over **prod-tier instances only** → `/webhook/author_request_v2`
- Dev Workbench → `n8n-dev.agileadautomation.com` (single instance in dev tier) → `/webhook/author_request_dev`

### Summary answer

- **Today** (1 n8n instance): no LB needed.
- **Tomorrow** (multiple prod n8n instances): add ~20 lines of routing code to the Workbench Express. **No new Railway service, no third-party LB, no Cloudflare LB product needed.**
- **If you later want round-robin / geo-routing / path-based splits**: then Cloudflare Load Balancer ($5/mo) OR an Nginx service on Railway. Not needed at current or near-future scale.

Sprint 13 adds this story: **S13-X "Multi-instance n8n routing in Workbench"** (~3 pts) — ships when we stand up the 2nd prod n8n.

---

## Complete `.env.example` reference

Separated into service scope. Copy the block that applies to the service you're configuring. For local development, set ALL of them in your single `.env` file at `writers-workbench/.env`.

### `writers-workbench` (and `writers-workbench-dev` with adjusted values)

```bash
# ───────────── Server basics ─────────────
NODE_ENV=production          # "development" for local + dev Railway
PORT=3001
ALLOWED_ORIGINS=http://localhost:5173,https://writers-workbench.up.railway.app

# ───────────── Supabase ─────────────
# Prod service uses V2 Supabase; dev service uses Dev Supabase (Sprint 10.a S10a-6)
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...

# ───────────── n8n webhook ─────────────
# Prod service uses V2 webhook; dev uses Dev webhook (Sprint 10.a S10a-9)
VITE_N8N_WEBHOOK_URL=https://n8n.agileadautomation.com/webhook/author_request_v2
N8N_API_URL=https://n8n.agileadautomation.com
N8N_API_KEY=eyJhbGci...                # n8n Public API key (Settings → API)

# ───────────── ElevenLabs ─────────────
# Prod service uses V2 agent; dev uses Dev agent (Sprint 10.a S10a-11)
VITE_ELEVENLABS_AGENT_ID=agent_2801kks580vnf5q80j3bd0n0x45v

# ───────────── Redis / Queue (Sprint 10.b) ─────────────
REDIS_URL=redis://default:<pw>@redis.railway.internal:6379

# ───────────── Postal / Email (Newsletter Sprint) ─────────────
POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1
POSTAL_API_KEY=<from Postal admin>
EMAIL_SECRET=<openssl rand -hex 32>
SENDER_EMAIL=eve@courseworx.media
SENDER_NAME=The Writers Workbench
REPLY_TO_EMAIL=support@courseworx.media

# ───────────── Ingestion / Approvals (Newsletter Sprint) ─────────────
INGESTION_SECRET=<openssl rand -hex 32>
APPROVAL_SECRET=<openssl rand -hex 32>
APPROVAL_BASE_URL=https://writers-workbench.up.railway.app
FIRECRAWL_API_KEY=fc-...
NEWSLETTER_USER_ID=+14105914612

# ───────────── Image generation ─────────────
KIEAI_API_KEY=<KIE.AI key>

# ───────────── E2E testing ─────────────
E2E_TEST_EMAIL=test@example.com
E2E_TEST_PASSWORD=<test password>
```

### `redis` service
No env vars on the Redis container itself. Railway injects `REDIS_PRIVATE_URL` and `REDIS_PASSWORD` into other services that reference it via the service binding feature.

### `postal-mariadb` service

```bash
MARIADB_ROOT_PASSWORD=<openssl rand -base64 24>
MARIADB_DATABASE=postal
MARIADB_USER=postal
MARIADB_PASSWORD=<openssl rand -base64 24>
```

### `postal-rabbitmq` service

```bash
RABBITMQ_DEFAULT_USER=postal
RABBITMQ_DEFAULT_PASS=<openssl rand -base64 24>
RABBITMQ_DEFAULT_VHOST=postal
```

### `postal` service

```bash
POSTAL_SIGNING_KEY=<openssl rand -hex 64>
MAIN_DB_HOST=postal-mariadb.railway.internal
MAIN_DB_USERNAME=postal
MAIN_DB_PASSWORD=<from postal-mariadb>
MAIN_DB_DATABASE=postal
MESSAGE_DB_HOST=postal-mariadb.railway.internal
MESSAGE_DB_USERNAME=postal
MESSAGE_DB_PASSWORD=<from postal-mariadb>
MESSAGE_DB_PREFIX=postal
RABBITMQ_HOST=postal-rabbitmq.railway.internal
RABBITMQ_USERNAME=postal
RABBITMQ_PASSWORD=<from postal-rabbitmq>
RABBITMQ_VHOST=postal
RAILS_ENV=production
```

### `n8n-prod` / `n8n-dev` / `n8n-prod-N` services (Sprint 13) — standalone instances

Each n8n instance gets its own copy of this env block. Values that **must differ per instance**: `WEBHOOK_URL`, `N8N_ENCRYPTION_KEY`, `N8N_HOST`. Values that **must stay the same across prod instances** (so the same workflows behave identically): all `N8N_*` workflow credentials below.

```bash
# Core — UNIQUE PER INSTANCE
N8N_HOST=n8n.agileadautomation.com              # or n8n-2.agileadautomation.com, n8n-dev.agileadautomation.com
N8N_PORT=5678
N8N_PROTOCOL=https
WEBHOOK_URL=https://n8n.agileadautomation.com   # matches N8N_HOST — must be the publicly reachable URL
GENERIC_TIMEZONE=America/New_York
N8N_ENCRYPTION_KEY=<openssl rand -hex 64>       # DIFFERENT for every instance — do NOT reuse

# DB — SQLite (default) uses the mounted volume. No env vars needed.
# Uncomment below only if you want Postgres instead (optional upgrade)
# DB_TYPE=postgresdb
# DB_POSTGRESDB_HOST=n8n-prod-postgres.railway.internal
# DB_POSTGRESDB_PORT=5432
# DB_POSTGRESDB_DATABASE=n8n
# DB_POSTGRESDB_USER=n8n
# DB_POSTGRESDB_PASSWORD=<from postgres service>

# Externalized workflow credentials (replaces hardcoded values in Code nodes — Sprint 13 S13-1)
# Values below are IDENTICAL for every instance in the same tier (prod-1, prod-2, prod-N),
# different for dev tier.
N8N_SUPABASE_URL=https://<project-ref>.supabase.co
N8N_SUPABASE_SERVICE_KEY=sb_secret_...
N8N_ANTHROPIC_API_KEY=sk-ant-...
N8N_PERPLEXITY_API_KEY=pplx-...
N8N_OPENAI_API_KEY=sk-proj-...
N8N_KIEAI_API_KEY=<KIE.AI key>
N8N_FIRECRAWL_API_KEY=fc-...
N8N_WORKBENCH_API_URL=https://writers-workbench.up.railway.app
N8N_POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1
N8N_POSTAL_API_KEY=<Postal API key>
```

### Optional: `n8n-prod-postgres` / `n8n-dev-postgres` services

Only deploy if you've outgrown SQLite (typically hundreds of executions per minute on one n8n instance). Most single-instance deployments run SQLite indefinitely.

```bash
POSTGRES_USER=n8n
POSTGRES_PASSWORD=<openssl rand -base64 24>
POSTGRES_DB=n8n
```

### Workbench env addition for multi-instance routing (when > 1 prod n8n instance)

Add to `writers-workbench` service env:

```bash
# Comma-separated list of prod n8n instance URLs; Workbench router picks by user_id hash
N8N_PROD_INSTANCES=https://n8n.agileadautomation.com,https://n8n-2.agileadautomation.com
# Single dev instance
N8N_DEV_INSTANCE=https://n8n-dev.agileadautomation.com
# API keys for admin ops (sync workflows, etc.) — one per instance, comma-separated, same order as URLs
N8N_PROD_API_KEYS=<key-1>,<key-2>
N8N_DEV_API_KEY=<dev-key>
```

---

## Cost totals

### Baseline (2 n8n tiers — prod + dev, SQLite):

| Service | vCPU | RAM | Volume | Monthly |
|---------|------|-----|--------|---------|
| writers-workbench | 0.5 | 512 MB | — | $15 |
| writers-workbench-dev | 0.5 | 512 MB | — | $15 |
| redis | 0.25 | 256 MB | 1 GB | $7.75 |
| postal-mariadb | 0.25 | 512 MB | 5 GB | $11 |
| postal-rabbitmq | 0.25 | 256 MB | 1 GB | $8 |
| postal | 0.5 | 1 GB | — | $15 |
| n8n-prod | 0.75 | 1.5 GB | 5 GB | $28.75 |
| n8n-dev | 0.5 | 1 GB | 5 GB | $16.25 |
| Railway Pro plan | — | — | — | $20 |
| **Infra subtotal (baseline, 2 n8n instances)** | | | | **~$137/mo** |

### Adding a 2nd prod n8n instance for scaling (~$25/mo additional)

| Service | Monthly |
|---------|---------|
| n8n-prod-2 (0.75 vCPU, 1.5 GB, 5 GB volume) | $28.75 |

Each additional prod instance: +$25-30/mo. Plan for 1 instance per 100-500 concurrent active users depending on workflow intensity.

### Upgrading an instance from SQLite to Postgres (optional, +$22/mo per instance)

| Service | Monthly |
|---------|---------|
| n8n-prod-postgres (0.5 vCPU, 1 GB, 10 GB volume) | $22.50 |

Only needed when an instance saturates SQLite's write throughput — not expected at current scale.

**External services (not Railway):**
- Supabase Pro × 3 projects (V1 frozen baseline + V2 prod + Dev) = $75/mo
- ElevenLabs plan (depending on usage) = varies
- Anthropic API usage = varies by volume (dominant cost at scale)

**All-Railway + Supabase total: ~$260/mo baseline + API usage.**

---

## Setup order summary

```
Week 1 (current): writers-workbench + writers-workbench-dev  [DONE]
Sprint 10.a:      Supabase tier setup (NOT Railway — SaaS)
Sprint 10.b:      Add redis
Newsletter sprint: Add postal-mariadb, postal-rabbitmq, postal
Sprint 11:        No new Railway services (Postal workflow migration only)
Sprint 12:        No new Railway services (chapter parallelization is n8n-only)
Sprint 13:        Add n8n-prod + n8n-dev (standalone instances, SQLite)
                  Implement Workbench multi-instance router
Scale-as-needed:  Add n8n-prod-2, n8n-prod-3, ... (each is a new standalone)
```

Baseline: 8 services, ~$137/mo.
Each additional prod n8n instance: +1 service, +$25-30/mo.

---

## Load balancing at a glance

| Concern | Solution |
|---------|----------|
| Scale Workbench Express for more concurrent users | Increase replica count on `writers-workbench` service. Railway auto-balances. No LB service needed. |
| Scale n8n throughput | Deploy another standalone `n8n-prod-N` instance. Partition users across instances via Workbench router (user_id hash). No LB service needed. |
| Prod vs dev traffic separation | Separate Railway services + separate webhook URLs. No LB. |
| Multi-prod-instance routing | Workbench Express picks instance based on user_id hash before POSTing to n8n webhook. No LB service, just code. |
| Geographic distribution (future) | Cloudflare in front of Railway. Not Railway-native. |

**Summary: you don't need a dedicated LB service on Railway.** Routing across n8n instances lives in the Workbench Express server's chat proxy (~20 lines of code, one config file). Railway's built-in edge proxy handles within-service replica balancing for stateless Express. When user count demands it, spin up another `n8n-prod-N`, add its URL to the Workbench router config, and you're done.
