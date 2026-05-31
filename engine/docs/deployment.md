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
