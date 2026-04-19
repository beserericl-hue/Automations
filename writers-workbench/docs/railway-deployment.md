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
| 7 | `n8n-postgres` | `postgres:16-alpine` | n8n execution data DB | 13 |
| 8 | `n8n-main` | `n8nio/n8n:latest` | n8n webhook entry point + UI | 13 |
| 9 | `n8n-worker-1` | `n8nio/n8n:latest` | n8n worker (queue mode) | 13 |
| 10 | `n8n-worker-2` | `n8nio/n8n:latest` | n8n worker (scale) | 13 |

**Total at full buildout: 10 services.**

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

### Phase 4 — n8n migration to Railway (Sprint 13)

Currently n8n runs at `n8n.agileadautomation.com` (external infra). Sprint 13 moves it to Railway in queue mode. Four new services replace the single external instance.

#### Service 7: `n8n-postgres`

1. **New** → **Database** → **Add PostgreSQL** (Railway template), OR deploy from image `postgres:16-alpine`
2. Environment:
   ```
   POSTGRES_USER=n8n
   POSTGRES_PASSWORD=<openssl rand -base64 24>
   POSTGRES_DB=n8n
   ```
3. Storage → New Volume, 10 GB, mount at `/var/lib/postgresql/data`
4. Networking → Private only
5. Capture internal hostname: `n8n-postgres.railway.internal`

#### Service 8: `n8n-main` (webhook + UI, main process)

1. **New** → **Deploy from Docker Image** → `n8nio/n8n:latest`
2. Environment:
   ```
   N8N_HOST=n8n.agileadautomation.com           # keep existing domain
   N8N_PORT=5678
   N8N_PROTOCOL=https
   WEBHOOK_URL=https://n8n.agileadautomation.com
   GENERIC_TIMEZONE=America/New_York
   
   # Database (shared with workers)
   DB_TYPE=postgresdb
   DB_POSTGRESDB_HOST=n8n-postgres.railway.internal
   DB_POSTGRESDB_PORT=5432
   DB_POSTGRESDB_DATABASE=n8n
   DB_POSTGRESDB_USER=n8n
   DB_POSTGRESDB_PASSWORD=<from service 7>
   
   # Queue mode
   EXECUTIONS_MODE=queue
   QUEUE_BULL_REDIS_HOST=redis.railway.internal
   QUEUE_BULL_REDIS_PORT=6379
   QUEUE_BULL_REDIS_PASSWORD=<from service 3>
   
   # Encryption
   N8N_ENCRYPTION_KEY=<openssl rand -hex 64>
   
   # API
   N8N_API_KEY_PATH=/public-api
   
   # Workflow credentials (externalized per Sprint 13 S13-1 — replaces hardcoded Supabase URLs in Code nodes)
   N8N_SUPABASE_URL=<V2 Supabase URL>
   N8N_SUPABASE_SERVICE_KEY=<V2 service role key>
   N8N_ANTHROPIC_API_KEY=<Claude API key>
   N8N_PERPLEXITY_API_KEY=<Perplexity key>
   N8N_OPENAI_API_KEY=<OpenAI key>
   N8N_KIEAI_API_KEY=<KIE.AI key>
   N8N_FIRECRAWL_API_KEY=<Firecrawl key>
   N8N_WORKBENCH_API_URL=https://writers-workbench.up.railway.app
   N8N_POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1
   N8N_POSTAL_API_KEY=<Postal API key>
   ```
3. Public domain → attach `n8n.agileadautomation.com` (custom domain — update DNS to point at Railway after cutover; during migration, run parallel)
4. Command: `n8n start` (handles webhooks + UI; not workers)
5. No volume needed (state is in Postgres + Redis)

#### Services 9 & 10: `n8n-worker-1`, `n8n-worker-2`

For each worker:
1. **New** → **Deploy from Docker Image** → `n8nio/n8n:latest`
2. Environment: SAME as `n8n-main` except:
   - `EXECUTIONS_MODE=queue` (same)
   - No public domain (workers don't receive HTTP traffic)
   - Command: `n8n worker`
3. No volume needed
4. Scale horizontally by duplicating (worker-3, worker-4, etc.) — all read from the same Redis queue

**Alternative:** instead of separate `worker-1` and `worker-2` services, use Railway's **replica count** on a single `n8n-worker` service. Set replica count = 2 (or more). Same effect, less service sprawl.

---

## Load balancer question

**Short answer: No, you don't need a separate Railway load balancer service.**

**Why:**

1. **For the Workbench Express services (`writers-workbench`, `writers-workbench-dev`):** Railway automatically load-balances across replicas when you scale a service (Service settings → Replicas = N). It fronts replicas with its own edge proxy. You do nothing.

2. **For n8n in queue mode:**
   - The **main** process receives HTTP traffic (webhooks + UI). You typically run **one** main. If you scale main to 2+ replicas, Railway load-balances between them — fine, since they're stateless with respect to webhook reception. Both write webhook-received payloads into the Redis queue.
   - **Workers** don't receive HTTP traffic at all — they pull jobs from Redis. Adding more workers = more throughput, no load balancer needed.

3. **If you ever wanted n8n sharded across truly independent instances** (not queue-mode workers, but fully separate n8n brains) — then yes you'd need a custom router. But that's NOT what this architecture does. Queue mode with 1 main + N workers is the horizontal scaling path.

**When Railway's built-in LB is enough:**
- One service, multiple replicas (e.g., `n8n-worker` with replica count = 3)
- Different services on different domains/subdomains (e.g., `writers-workbench` on one domain, `n8n-main` on another)

**When you'd need something more:**
- Blue-green deployment with custom traffic splits → use Railway environments (not an LB service)
- Geographic routing → Cloudflare in front of Railway
- Authentication at the edge → Cloudflare Access or a sidecar Cloudflared tunnel

None of those apply today.

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

### `n8n-postgres` service (Sprint 13)

```bash
POSTGRES_USER=n8n
POSTGRES_PASSWORD=<openssl rand -base64 24>
POSTGRES_DB=n8n
```

### `n8n-main` and `n8n-worker` services (Sprint 13)

```bash
# Core
N8N_HOST=n8n.agileadautomation.com
N8N_PORT=5678
N8N_PROTOCOL=https
WEBHOOK_URL=https://n8n.agileadautomation.com
GENERIC_TIMEZONE=America/New_York
N8N_ENCRYPTION_KEY=<openssl rand -hex 64>

# DB (shared)
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=n8n-postgres.railway.internal
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=n8n
DB_POSTGRESDB_USER=n8n
DB_POSTGRESDB_PASSWORD=<from n8n-postgres>

# Queue mode (shared Redis)
EXECUTIONS_MODE=queue
QUEUE_BULL_REDIS_HOST=redis.railway.internal
QUEUE_BULL_REDIS_PORT=6379
QUEUE_BULL_REDIS_PASSWORD=<from redis>

# Externalized workflow credentials (replaces hardcoded values in Code nodes)
N8N_SUPABASE_URL=https://<v2-project-ref>.supabase.co
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

---

## Cost totals

| Service | vCPU | RAM | Volume | Monthly |
|---------|------|-----|--------|---------|
| writers-workbench | 0.5 | 512 MB | — | $15 |
| writers-workbench-dev | 0.5 | 512 MB | — | $15 |
| redis | 0.25 | 256 MB | 1 GB | $7.75 |
| postal-mariadb | 0.25 | 512 MB | 5 GB | $11 |
| postal-rabbitmq | 0.25 | 256 MB | 1 GB | $8 |
| postal | 0.5 | 1 GB | — | $15 |
| n8n-postgres | 0.5 | 1 GB | 10 GB | $22.50 |
| n8n-main | 0.5 | 1 GB | — | $15 |
| n8n-worker-1 | 0.75 | 1.5 GB | — | $27.50 |
| n8n-worker-2 | 0.75 | 1.5 GB | — | $27.50 |
| Railway Pro plan | — | — | — | $20 |
| **Infra subtotal** | | | | **~$184/mo** |

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
Sprint 13:        Add n8n-postgres, n8n-main, n8n-worker-1, n8n-worker-2
```

At the end: 10 Railway services, ~$184/mo infrastructure.

---

## Load balancing at a glance

| Concern | Solution |
|---------|----------|
| Scale Workbench Express for more concurrent users | Increase replica count on `writers-workbench` service. Railway auto-balances. |
| Scale n8n throughput | Add more `n8n-worker` replicas. They pull from shared Redis queue — no HTTP routing needed. |
| High webhook volume to n8n | Scale `n8n-main` to 2–3 replicas. Railway load-balances incoming HTTP. Webhook payloads go into Redis queue; workers process async. |
| Prod vs dev traffic separation | Already solved — separate Railway services (`writers-workbench` vs `writers-workbench-dev`), separate webhook paths (`/webhook/author_request_v2` vs `/webhook/author_request_dev`). |
| Geographic distribution | Not applicable at current scale. If needed, put Cloudflare in front of Railway. |

**You don't need a dedicated load balancer service on Railway for this architecture.**
