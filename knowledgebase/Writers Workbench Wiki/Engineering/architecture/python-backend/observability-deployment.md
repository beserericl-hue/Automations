---
name: Observability + deployment
description: Logging, metrics, tracing, deployment model (blue-green per service group), rollback procedure, on-call runbook for the Python backend.
type: concept
tags: [architecture, python-backend, observability, deployment, ops]
last_reviewed: 2026-05-09
---

# Observability + deployment

## Logging

### Format

Structured JSON via `structlog`. Every log line includes:

```json
{
  "timestamp": "2026-05-09T14:23:11.123Z",
  "level": "info",
  "logger": "chapter.writer",
  "request_id": "req_abc123",
  "tenant_id": "tnt_xyz",            // or "user_id" for /internal/
  "module": "chapter",
  "endpoint": "/v1/chapters/write",
  "duration_ms": 12345,
  "input_tokens": 8000,
  "output_tokens": 27000,
  "cost_usd": 0.405,
  "llm_used": "claude-sonnet-4-5",
  "status": "ok",
  "message": "chapter write complete"
}
```

### Sensitive data redaction

Logger middleware redacts:
- `Authorization` headers
- `X-Service-Secret`, `X-Admin-Token`, `X-Webhook-Signature`
- `api_key`, `webhook_secret` fields in any payload
- API key prefixes are OK (they're public metadata)

### Sinks

- **stdout** → Railway log stream (default). Tail via Railway CLI.
- **Optional**: Datadog / Honeycomb / Loki shipper via env-var-controlled second sink.

Retention: Railway 7 days; long-term in object storage if needed for compliance.

## Metrics

### Prometheus format at `/admin/metrics`

```
# HELP author_agent_requests_total Total HTTP requests
# TYPE author_agent_requests_total counter
author_agent_requests_total{module="chapter",endpoint="/v1/chapters/write",tenant_id="tnt_xyz",status="200"} 1247

# HELP author_agent_request_duration_seconds Request latency
# TYPE author_agent_request_duration_seconds histogram
author_agent_request_duration_seconds_bucket{module="chapter",endpoint="/v1/chapters/write",le="0.1"} 0
author_agent_request_duration_seconds_bucket{module="chapter",endpoint="/v1/chapters/write",le="1"} 0
author_agent_request_duration_seconds_bucket{module="chapter",endpoint="/v1/chapters/write",le="10"} 5
author_agent_request_duration_seconds_bucket{module="chapter",endpoint="/v1/chapters/write",le="60"} 89
author_agent_request_duration_seconds_bucket{module="chapter",endpoint="/v1/chapters/write",le="300"} 1100
author_agent_request_duration_seconds_bucket{module="chapter",endpoint="/v1/chapters/write",le="600"} 1247
author_agent_request_duration_seconds_bucket{module="chapter",endpoint="/v1/chapters/write",le="+Inf"} 1247

# HELP author_agent_llm_tokens_total Total LLM tokens
# TYPE author_agent_llm_tokens_total counter
author_agent_llm_tokens_total{model="claude-sonnet-4-5",direction="output",tenant_id="tnt_xyz"} 4523890

# HELP author_agent_anthropic_budget_remaining Estimated remaining tokens in current minute window
# TYPE author_agent_anthropic_budget_remaining gauge
author_agent_anthropic_budget_remaining{model="claude-sonnet-4-5"} 32400

# HELP author_agent_inflight_requests Currently in-flight requests
# TYPE author_agent_inflight_requests gauge
author_agent_inflight_requests{module="chapter"} 7

# HELP author_agent_queue_depth BullMQ queue depth
# TYPE author_agent_queue_depth gauge
author_agent_queue_depth{queue="heavy-ops"} 23
```

### Business metrics

Exposed but tenant-scoped:

- `author_agent_chapters_written_total{tenant_id, llm_used}` counter
- `author_agent_cost_usd_total{tenant_id}` counter (running tally; reconcile nightly with billing)
- `author_agent_active_tenants` gauge

### Dashboards

Grafana dashboards (open-source self-hosted or Grafana Cloud free tier):

1. **Service health** — request rate, error rate, p50/p95/p99 latency per endpoint.
2. **LLM costs** — tokens/min, $/min, per-model breakdown.
3. **Anthropic budget** — token budget remaining over time, 429 rate.
4. **Tenant usage** — top tenants by request volume + spend.
5. **Queue health** — BullMQ depth per tier, oldest job age.
6. **Capacity** — in-flight per service group, CPU/memory per replica.

Stored as code: `dashboards/*.json` provisioned via Grafana API on deploy.

## Tracing

OpenTelemetry SDK. Spans per:
- Incoming HTTP request (root span).
- Each LLM call (Anthropic, Perplexity).
- Each Supabase query.
- Each background task enqueue + execution.
- Each HTTP outbound call (e.g. n8n hub callbacks, ElevenLabs).

Auto-instrumentation via `opentelemetry-instrumentation-fastapi` + `-httpx` + `-asyncpg`.

Export: OTLP → Honeycomb / Tempo / Jaeger. Configurable via env var. Sampling: 100% in DEV, 10% in PROD (with tail-sampling of error traces always retained).

## Health checks

`GET /admin/health` returns:

```json
{
  "status": "ok",
  "version": "<git-sha>",
  "service_group": "heavy",
  "deployed_at": "2026-05-09T...",
  "uptime_seconds": 1234567,
  "checks": {
    "supabase": "ok",
    "redis": "ok",
    "anthropic": "ok",
    "perplexity": "ok"
  },
  "queues": {
    "heavy-ops": {"depth": 5, "oldest_job_age_s": 12},
    "medium-ops": {"depth": 0}
  },
  "in_flight": {
    "chapter": 2,
    "research": 1
  }
}
```

Railway uses this for liveness check (5s timeout, restart after 3 consecutive fails).

`GET /admin/ready` returns:
- 200 if ready to accept traffic (deps healthy, queues responsive).
- 503 during startup (DB not yet connected) or shutdown (draining).

LB uses `/admin/ready` for routing decisions.

## Deployment

### Repo structure

```
author-agent-backend/
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI app factory
│   ├── modules/             # one package per module
│   │   ├── chapter/
│   │   ├── brainstorm/
│   │   ├── research/
│   │   ├── media/
│   │   ├── library/
│   │   ├── story_bible/
│   │   ├── approval/
│   │   ├── notify/
│   │   ├── newsletter/
│   │   └── scheduler/
│   ├── shared/              # cross-module
│   │   ├── auth.py
│   │   ├── tenant.py
│   │   ├── supabase_client.py
│   │   ├── anthropic_client.py
│   │   ├── redis_client.py
│   │   ├── rate_limit.py
│   │   ├── idempotency.py
│   │   ├── audit.py
│   │   ├── telemetry.py
│   │   └── prompts.py
│   ├── service_groups/      # entry points
│   │   ├── heavy.py         # imports modules: chapter, brainstorm, research, media (incl. qa)
│   │   ├── light.py         # imports: library, story_bible, approval, notify
│   │   └── cron.py          # imports: scheduler, newsletter (cron entry points)
│   └── tests/
├── Dockerfile.heavy
├── Dockerfile.light
├── Dockerfile.cron
├── docker-compose.dev.yml
├── pyproject.toml
├── poetry.lock              # or uv.lock
├── .env.example
├── pytest.ini
└── README.md
```

### Three Dockerfiles, one image base

```dockerfile
# Dockerfile.heavy
FROM python:3.12-slim AS base
RUN pip install poetry==1.8.2
WORKDIR /app
COPY pyproject.toml poetry.lock ./
RUN poetry config virtualenvs.create false && poetry install --no-dev
COPY app ./app
ENV PORT=8080
CMD ["uvicorn", "app.service_groups.heavy:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "4"]
```

`Dockerfile.light` and `Dockerfile.cron` are identical except for `service_groups.<name>`.

### Build pipeline

GitHub Actions on push to `develop` / `main`:

```yaml
- Lint: ruff + mypy
- Test: pytest -p no:cacheprovider
- Build:
    - docker build -f Dockerfile.heavy  -t author-agent-api:heavy:$SHA .
    - docker build -f Dockerfile.light  -t author-agent-api:light:$SHA .
    - docker build -f Dockerfile.cron   -t author-agent-api:cron:$SHA .
- Push to Railway image registry
- Deploy:
    - railway deploy --service author-agent-heavy --image author-agent-api:heavy:$SHA
    - railway deploy --service author-agent-light --image author-agent-api:light:$SHA
    - railway deploy --service author-agent-cron --image author-agent-api:cron:$SHA
```

### Service topology per environment

| Environment | heavy replicas | light replicas | cron replicas | Redis | Supabase |
|---|---|---|---|---|---|
| DEV | 1 | 1 | 1 | Redis_Dev | DEV |
| TEST | 3 | 1 | 1 | (testbed Redis) | Testbed |
| PROD (initial) | 3 | 2 | 1 | Redis | PROD |
| PROD (scaled) | 5-10 | 3-4 | 1 | Redis (clustered if needed) | PROD |

### Railway service naming

| Service name | Image |
|---|---|
| `author-agent-heavy-prod` | `author-agent-api:heavy` |
| `author-agent-light-prod` | `author-agent-api:light` |
| `author-agent-cron-prod` | `author-agent-api:cron` |
| `author-agent-heavy-dev` | same |
| ...etc |

Plus ELB / Cloudflare Load Balancer in front of heavy + light groups (cron is internal-only, no LB needed).

## Blue-green deployment per group

For zero-downtime deploys:

```
1. Current state: heavy-prod-blue (3 replicas) handling all traffic.
2. Deploy new SHA to heavy-prod-green (3 replicas, no traffic yet).
3. Health-check green: all replicas healthy + DB reachable + queues responsive.
4. Smoke test: synthetic chapter via green. Verify response.
5. Shift LB: 10% to green, 90% to blue. Wait 5 min. Verify error rates equal or better.
6. 50% / 50%. Wait 5 min.
7. 100% green. Wait 5 min.
8. Drain blue: stop accepting new requests; let in-flight finish.
9. Tear down blue.
10. Mark green as new blue for next deploy.
```

Railway-native this is two services + LB rule swap. Or run on Kubernetes for native blue-green.

For light + cron groups: same procedure but lower stakes (CRUD endpoints + scheduled jobs).

## Rollback

If post-deploy:
- Error rate spikes
- Quality scores drop
- Customer-reported regression

```
1. LB swap traffic back to blue (last known-good version). ~30 seconds.
2. Drain green; tear down.
3. Triage: collect logs + traces from the bad green window.
4. File issue; fix forward in next deploy.
```

Database migrations are **not auto-rolled-back** (irreversible by default). Forward-fix via compensating migration.

## Capacity planning

Per heavy-group replica:
- CPU: 2 vCPU (Anthropic streams use mostly I/O, not CPU; spike during JSON parse + extract_bible)
- Memory: 1 GB (Python + libs + per-request context cache)
- Concurrency target: 4 chapters in flight (matches Anthropic per-request output limit pattern)

Per light-group replica:
- CPU: 1 vCPU
- Memory: 512 MB
- Concurrency: 50 (CRUD-bound, not LLM)

Per cron-group replica:
- CPU: 0.5 vCPU
- Memory: 256 MB
- Concurrency: 10

Scaling triggers:
- **Heavy**: BullMQ heavy-ops queue depth > 20 → add replica.
- **Light**: p95 latency > 500ms → add replica.
- **Cron**: never scale beyond 1 (singleton invariant).

## Secrets management

Per environment, set via Railway dashboard or CLI:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
PERPLEXITY_API_KEY
KIE_AI_API_KEY
OPENAI_API_KEY
ELEVENLABS_API_KEY
FIRECRAWL_API_KEY
REDIS_URL
WORKBENCH_API_URL
SERVICE_SHARED_SECRET    # X-Service-Secret value
ADMIN_TOKEN              # /admin/* auth
HMAC_WEBHOOK_SECRET      # default per-tenant fallback
SENTRY_DSN
HONEYCOMB_API_KEY
```

Rotation procedure: same as Workbench (see [[credentials-map]]).

## On-call runbook

### Symptom: high error rate on `/v1/chapters/write`

```
1. Check /admin/health on heavy replicas. Are deps green?
2. Check Anthropic 429 rate. Token budget exhausted?
   → Wait for next minute window OR upgrade tier.
3. Check Postgres connection pool exhaustion.
   → Scale Supabase tier OR add PgBouncer.
4. Check stuck jobs in heavy-ops queue.
   → Dead-letter the oldest 5; investigate.
```

### Symptom: chapter wall time p95 > 15 minutes

```
1. Check Anthropic API latency. Provider degradation?
2. Check token budget gatekeeper hold time. Many waits?
3. Check sub-chapter parallelism — is asyncio.gather actually running parallel?
4. Profile a representative request via OTel trace.
```

### Symptom: cron-group missed a run

```
1. Check cron container logs. Crash? Schedule trigger fired?
2. Check Redis advisory locks (cron-group uses these to prevent dual runs).
   → Stale lock? Manually release.
3. Re-run manually via /admin/cron/<name>.
```

### Symptom: tenant complaining of unexpected 404s

```
1. Verify tenant API key is active.
2. Check audit_log for that tenant_id + endpoint.
3. Spot-check: are they trying to access another tenant's resource? (404 by design.)
4. Check rate limit: were they 429-throttled and confused?
```

## Observability checklist for a new endpoint

When adding a new endpoint:

- [ ] Logger emits request_id, tenant_id (or user_id), endpoint, status, duration_ms.
- [ ] Prometheus counter increments.
- [ ] Prometheus histogram records latency.
- [ ] OTel span auto-created via instrumentation.
- [ ] Token usage (if LLM call) logged + sent to api_usage_v2.
- [ ] Error responses include request_id (for support correlation).
- [ ] Idempotency-Key honored if mutating.

Lint rule enforces structured response envelope.

## Cost tracking

Every `/v1/*` request creates an `api_usage_v2` row with `cost_usd`. Cost computed:

```python
cost = (input_tokens * INPUT_PRICE_PER_TOKEN[model]) + (output_tokens * OUTPUT_PRICE_PER_TOKEN[model])
markup = cost * MARKUP_MULTIPLIER[tenant.tier]   # 0 for internal, ~1.33 for B2B
billable = cost * markup
```

Nightly aggregation cron rolls up:
- `tenant_usage_daily_v2` (per-tenant, per-day totals)
- Stripe usage records (for tenants on metered billing)
- Internal cost report (LLM spend by tier and module)

## Scaling math

For each replica:
- 4 in-flight chapters × 5-min average wall time = 0.8 chapters/replica/min = 48/replica/hour.
- 3 replicas × 48 = 144 chapters/hour ceiling.
- Anthropic Tier 3 ceiling (80k tokens/min ÷ 27k/chapter) = ~178 chapters/hour. Tier 3 is the tighter constraint.

So 3 replicas saturates Tier 3. Adding more replicas without Tier 4 just queues longer.

When Tier 4 (400k tokens/min):
- Ceiling: ~889 chapters/hour.
- Need replicas: 889/48 = ~19 replicas.
- Cost: 19 × $7/mo = ~$133/mo for compute. Fine.

So the upgrade lever is Anthropic tier. Backend replica count follows.

## Disaster recovery

| Scenario | Recovery |
|---|---|
| All heavy-group replicas crash | Railway auto-restart; LB routes to surviving + restored replicas |
| Redis goes down | Idempotency cache lost (24h replay possible); rate limits become permissive temporarily; jobs queue in BullMQ which uses Redis (so queue stalls). Critical incident. Fail-fast, don't accept new jobs. |
| Supabase regional outage | All writes fail. Backend returns 503 until Supabase recovers. Customers retry per spec. |
| Anthropic outage | All write/research calls fail with LLM_RATE_LIMITED 503. CRUD endpoints unaffected. |
| Postal down | Email delivery fails; chapter writes complete but emails queue locally for retry. |
| Cloudflare LB down | Direct service URLs accessible (per-tenant whitelist for emergency). |

DR drills: quarterly. Simulate Redis outage; verify backend degrades gracefully.

## SLA commitments (B2B)

| Tier | Uptime | Response time SLA | Recovery |
|---|---|---|---|
| Free | None | None | Best-effort |
| Starter | None | None | Best-effort |
| Pro | 99.5%/mo | p95 < 30s sync, p95 < 10min async | Credit refund per service credit policy |
| Scale | 99.9%/mo | p95 < 20s sync, p95 < 8min async | Same |
| Enterprise | 99.95%/mo + custom | Negotiated | Custom contract |

Status page at `status.authoragent.dev` reports incidents in real-time.

## Quarterly review

Once per quarter, ops + engineering review:
- Capacity utilization vs scaling triggers (right-size).
- Top 10 errors by frequency (fix or document).
- Customer-reported issues by category.
- LLM cost trends (predict next quarter).
- SLA attainment per tier.
- Pending architectural debt.

Output: capacity plan + roadmap input for next quarter.
