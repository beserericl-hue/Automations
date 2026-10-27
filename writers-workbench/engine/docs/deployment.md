# Engine deployment — Railway DEV

## Live URLs

- **Gateway:** https://writer-engine-gateway-develop.up.railway.app
- **Runtime (orchestrator + arq + 11 step services):** https://writer-engine-runtime-develop.up.railway.app

## Required service env (gotchas)

Each engine Railway service MUST have an explicit `PORT` env var matching the port its app binds to — without
it Railway's edge proxy 502s "Application failed to respond" even though the container is running fine. Set
*alongside* the `--port` flag on `railway domain`, not as a replacement for it.

| Service | PORT | Notes |
|---|---|---|
| `writer-engine-gateway` | `8000` | Gateway uvicorn binds 8000 in its Dockerfile CMD |
| `writer-engine-runtime` | `8001` | entrypoint.sh uses `${PORT:-8001}` for the orchestrator; step services bind localhost:8002 + 8010-8019 internally |

## What's done

- 2 Railway services created in `bubbly-solace` / `develop` env:
  - `writer-engine-gateway` (id `f87274f7-9068-4065-b7cf-c8c993435e6c`)
  - `writer-engine-runtime` (id `8e87e53d-9f25-4ee5-b345-6ab8e5fd68c8`)
- 19 env vars bulk-set on each via `railway variables --set` (Anthropic / Gemini / Perplexity / OpenAI / Firecrawl / KIE.AI / Postal / Supabase / shared Redis at `redis.railway.internal` / Ingestion secret / etc.). Fresh `SERVICE_SHARED_SECRET` + `ADMIN_TOKEN` generated; `ARCHIVE_BASE_URL` pointed at Supabase Storage public bucket.
- Gateway has `ORCHESTRATOR_URL=http://writer-engine-runtime.railway.internal:8001` so it reaches the runtime over Railway's private network.
- Engine uses a 2-service runtime architecture (per `engine-framework-sprints` F2-3 pragmatic deploy): one image for the gateway, one for everything else. The `runtime` image starts orchestrator + arq worker + all 10 step services as background uvicorn processes; the orchestrator calls each step via `localhost:801x` set in `services/runtime/entrypoint.sh`.

## What's left — 2 minutes of UI click + 1 deploy each

Railway API requires UI-level permissions to set per-service Root Directory + Dockerfile Path, which the CLI access token doesn't have. Set them by hand:

1. https://railway.com/project/87cb760d-784b-42cc-920f-712483a81664 → `writer-engine-gateway` → Settings → Source:
   - **Root Directory:** `engine`
   - **Builder:** `Dockerfile`
   - **Dockerfile Path:** `services/gateway/Dockerfile`
   - **Networking:** add a public domain → "Generate Domain" (port `8000`)
2. Same on `writer-engine-runtime` with:
   - **Root Directory:** `engine`
   - **Dockerfile Path:** `services/runtime/Dockerfile`
   - **Networking:** add a public domain → port `8001` (or leave private if only the gateway calls it)

Then deploy each from the repo root:

```bash
cd /Users/ericbeser/Documents/GitHub/Automations
railway up --service writer-engine-runtime -e develop --detach
# wait for /admin/health to be 200
railway up --service writer-engine-gateway -e develop --detach
```

## Verify

```bash
curl https://writer-engine-gateway-<railway-id>.up.railway.app/admin/health
# {"status":"ok","service":"gateway"}

curl -X POST \
  -H "X-Service-Secret: $SERVICE_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  https://writer-engine-gateway-<railway-id>.up.railway.app/internal/library/retrieve \
  -d '{"user_id":"00000000-0000-0000-0000-000000000000","limit":3}'
```

## Wire WW DEV to the engine

Once both services are healthy:

```bash
railway variables --service WritersWorkbench -e develop \
  --set "NEWSLETTER_BACKEND=python" \
  --set "NEWSLETTER_SERVICE_URL=http://writer-engine-gateway.railway.internal:8000" \
  --set "SERVICE_SHARED_SECRET=<copy from writer-engine-gateway>"
```

Then redeploy WritersWorkbench DEV (which already has the `NEWSLETTER_BACKEND` flag from Item 2). The next UI-triggered generate routes through the Python engine via the synchronous-acks-then-arq-resume flow.

## Splitting to per-step services (later)

When traffic justifies the cost, replace `writer-engine-runtime` with one Railway service per step (`writer-engine-gather`, `writer-engine-pick`, …). Use each `services/<step>/Dockerfile`; orchestrator's `*_STEP_URL` env vars already point at the `*-step` hostnames so the change is config-only.

## Replicas, the fleet view and the autoscaler (CR-010 C1/C4)

**Replica counts are set per environment on Railway, not in `railway.*.toml`.** A count in the toml
would apply to every environment that deploys the file. DEV runs **2** gateway and **2** runtime
replicas. PROD is to run **4** of each, set at the PROD cutover and not before.

Changing a count adds or removes replicas on the running deployment; the existing replicas are not
redeployed (verified on DEV 2026-10-26). Railway spreads public traffic across replicas at random,
and the private DNS name resolves to all of them. Each engine response carries `X-Engine-Instance`,
so you can see which replica answered.

**What multi-replica changed in the code:**

- The arq heartbeat is per instance: `engine:arq:health-check:<queue>:<RAILWAY_REPLICA_ID>`.
  - The sampler adds every instance's heartbeat together, so `running`, `max_jobs` (slots) and `saturation` are fleet totals.
  - `/admin/ready` checks only this replica's own worker.
- Scheduled jobs run on one replica per interval.
  - The lock is `engine:singleton:<job>`, with a TTL of 95% of the job's interval.
  - Before this, two replicas could both publish (and email) the same scheduled post.
  - The queue-metrics sampler is the exception and runs on every replica.
- Every replica records itself in `engine:fleet:<service>:<instance>` (TTL 90s). The view of that registry is:
  - `GET /admin/fleet` on the orchestrator (admin token);
  - `GET /internal/fleet` on the gateway (service secret);
  - **Admin → Engine Fleet** in the Workbench.
- New Prometheus metrics:
  - `engine_instance_info`;
  - `engine_fleet_instances{service}`;
  - `engine_autoscale_current_replicas`;
  - `engine_autoscale_target_replicas`;
  - `engine_autoscale_decisions{action}`.

**The autoscaler** (`writer_engine/autoscale.py`) runs on the runtime as a singleton job every
`AUTOSCALE_POLL_SECONDS` (default 60). It scales only the runtime; the gateway stays at its floor.

| Verdict | Action |
|---|---|
| `scale_out` or `backlog`, for 2 samples in a row | +1 replica |
| `tpm_bound` | hold (another replica shares the same token budget) |
| `scale_in`, idle for 15 minutes, no heavy job running | −1 replica |
| below `AUTOSCALE_MIN_REPLICAS` | back to the floor at once |

There is at most one change per `AUTOSCALE_COOLDOWN_SECONDS` (default 300), always one replica at a
time, and the count stays between the floor and the ceiling.

| Variable (runtime service) | DEV | Notes |
|---|---|---|
| `AUTOSCALE_ENABLED` | `true` | Off unless set. |
| `RAILWAY_AUTOSCALE_TOKEN` | a Railway **project token for the develop environment** | Railway scopes it to that one environment, so it cannot change PROD. |
| `AUTOSCALE_MIN_REPLICAS` / `AUTOSCALE_MAX_REPLICAS` | `2` / `4` | PROD at cutover: `4` / its ceiling. |
| `AUTOSCALE_ALLOW_PRODUCTION` | unset | Required as well before it acts in an environment named `production`. |

## Post calendar, radars and the two editions (port of the n8n blog / LinkedIn system)

Migration 038. The engine now owns what n8n's `Cron - Post Scheduled Website Blogs`, Trend Radar,
Dev Radar, Batch Week and Roundup Batch did. Workbench: **Newsletter → Post calendar** and
**Newsletter → Radars**. Code: `writer_engine/social/` (queue, channels, publisher, edition feed) and
`writer_engine/radar/` (the two radars and the week drafting).

Variables on `writer-engine-runtime` (never in GitHub):

| Variable | What it does | Without it |
|---|---|---|
| `SOCIAL_POSTING_MODE` | `live` posts for real. Anything else (default `dry_run`) records each channel's exact request as a `dry_run` delivery and sends nothing. | dry run |
| `BLOTATO_API_KEY` | LinkedIn posts via Blotato (`blotato-api-key` header), and the status check. | LinkedIn deliveries fail with "BLOTATO_API_KEY is not set" (live mode only) |
| `TECHAHIR_BLOG_API_KEY` | The TechAhir blog API token. The header it goes in is the website channel's `auth_header` in `social_channels_v2` (default `Authorization`, sent as `Bearer …`). | website deliveries fail (live mode only) |
| `YOUTUBE_API_KEY` | Dev Radar's YouTube search (8 queries, 800 quota units a week). | Dev Radar uses the 45-day video archive only |
| `KIEAI_API_KEY` | Sketchnote images (already set). | posts go out without an image |

Crons (engine internal timer, all US Eastern): publisher every 5 min (slots 09:00 / 14:00), radars
hourly check (Trend Monday 06:00, Dev Sunday 06:00), one run per user, radar and week.

**Cutover order — n8n is still posting the same calendar.** Turning on `SOCIAL_POSTING_MODE=live`
while n8n's cron is active would post everything twice. Order: deactivate n8n `Cron - Post Scheduled
Website Blogs` (Se2X0fmkLUFK6CCq), Trend Radar (q1yDjiztjdGRDblT) and Dev Radar (czBKvhON08FzFydK);
re-run `scripts/seed_social_dev.py --import-n8n` so the last n8n posts are in; then set `live`.
Imported n8n rows that were still `pending` are imported as `cancelled` on purpose — requeue the ones
the engine should post.

Setup on a database: `python scripts/seed_social_dev.py --seed` (channels, radar subscriptions, the
`ai-mvp` and `ai-dev-roundup` editions with their `radar://` and `social://` sources). DEV only; it
refuses any other Supabase URL.
