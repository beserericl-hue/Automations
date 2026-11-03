# Engine deployment — Railway DEV

Current as of 2026-11-03 (`develop` at PR #260). The engine runs on DEV only; the PROD cutover is
`writers-workbench/docs/prod-release-checklist.md`.

## Live URLs

- **Gateway:** https://writer-engine-gateway-develop.up.railway.app
- **Runtime (supervisor → orchestrator + 2 arq workers + one `steps_app` serving all 20 steps):** https://writer-engine-runtime-develop.up.railway.app

## How it deploys

Both services are **repo-connected**: a merge to `develop` builds and deploys them. **Never
`railway up`.** Each service reads its own config-as-code file (`railway.gateway.toml`,
`railway.runtime.toml`, root directory `/writers-workbench/engine`), which sets the Dockerfile and the
`/admin/health` healthcheck. Replica counts are set per environment on Railway (below), not in the toml.

## Required service env (gotchas)

Each engine Railway service MUST have an explicit `PORT` env var matching the port its app binds to — without
it Railway's edge proxy 502s "Application failed to respond" even though the container is running fine. Set
*alongside* the `--port` flag on `railway domain`, not as a replacement for it.

| Service | PORT | Notes |
|---|---|---|
| `writer-engine-gateway` | `8000` | Gateway uvicorn binds 8000 in its Dockerfile CMD |
| `writer-engine-runtime` | `8001` | The orchestrator binds `$PORT` (default 8001). Inside the container the steps run in one uvicorn on localhost:8030, told apart by mount path (`/steps/<name>`); process table in `writer_engine/runtime_processes.py` |

## The two services

- Railway project `bubbly-solace`, environment `develop`:
  - `writer-engine-gateway` (id `f87274f7-9068-4065-b7cf-c8c993435e6c`)
  - `writer-engine-runtime` (id `8e87e53d-9f25-4ee5-b345-6ab8e5fd68c8`)
- Gateway has `ORCHESTRATOR_URL=http://writer-engine-runtime.railway.internal:8001` so it reaches the runtime over Railway's private network.
- The runtime container is supervised (`python -m writer_engine.supervisor`; `services/runtime/entrypoint.sh` is a one-line `exec`): orchestrator, `arq_worker_heavy`, `arq_worker_interactive` and `steps_app`. A dead child is restarted in place; repeated deaths exit the container so Railway restarts it.
- Redis is the HA set (`redis-ha.railway.internal`, HAProxy in front of 5 nodes), shared by the gateway, the runtime and the Workbench.

## Variables (names as set on DEV, 2026-11-03)

Secrets are never in GitHub. Each environment generates its own; never copy a DEV secret to PROD.

| Variable | Gateway | Runtime | Notes |
|---|---|---|---|
| `PORT` | 8000 | 8001 | see above |
| `RAILWAY_DOCKERFILE_PATH` | ✓ | ✓ | |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | 60 | 60 | Railway's default 0 SIGKILLs at once and the graceful drain never runs |
| `SERVICE_SHARED_SECRET` | ✓ | ✓ | same value on the Workbench |
| `ADMIN_TOKEN` | ✓ | ✓ | the Workbench holds the same value as `ENGINE_ADMIN_TOKEN` (it falls back to `ADMIN_TOKEN`); used for Admin → Engine Fleet and the scheduler view |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL` | ✓ | ✓ | |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`, `KIEAI_API_KEY` | ✓ | ✓ | |
| `POSTAL_API_KEY`, `POSTAL_API_URL`, `ALERT_EMAIL` | ✓ | ✓ | |
| `ARCHIVE_BASE_URL`, `WORKBENCH_API_URL`, `INGESTION_SECRET` | ✓ | ✓ | |
| `ENABLE_PYTHON_EMBEDDINGS` | ✓ | ✓ | code default **false**; without it chapters get no canon retrieval |
| `PICKER_MODEL`, `LOG_LEVEL`, `METRICS_PORT` | ✓ | ✓ | |
| `ORCHESTRATOR_URL` | ✓ | | |
| `NEWSLETTER_CALLBACK_SECRET` | | ✓ | same value on the Workbench |
| `WORKBENCH_CRON_SECRET` | | ✓ | equals the Workbench's `CRON_SECRET`; drives the hourly trial/credit lifecycle |
| `INTEGRATIONS_ENCRYPTION_KEY` | | ✓ | same value on the Workbench (section below) |
| `SCRAPERAPI_API_KEY` | | ✓ | section below |
| `STEALTHGPT_API_KEY` | | ✓ | humanizer, section below |
| `AUTOSCALE_*`, `RAILWAY_AUTOSCALE_TOKEN` | | ✓ | section below |

Read by the code but not set on DEV (defaults apply): `HUB_MEMORY_ENABLED` (true),
`HUB_CONVERSATION_TTL_SECONDS` (43200), `HUB_VOICE_CONVERSATION_TTL_SECONDS` (1800),
`RUN_REAPER_POLL_SECONDS` (900), `EVE_KB_PRUNE_POLL_SECONDS` (21600), `EVE_KB_MAX_AGE_HOURS` (24),
`SOCIAL_POSTING_MODE` (`dry_run`), `YOUTUBE_API_KEY`, and `ELEVENLABS_API_KEY` / `ELEVENLABS_AGENT_ID` /
`ELEVENLABS_PHONE_NUMBER_ID` (read with `os.environ` in `writer_engine/eve.py`; unset = the Eve callback
and the KB prune job are dry runs). Every setting is in `packages/writer_engine/src/writer_engine/config.py`.

### Humanizer (StealthGPT, non-fiction only)

| Variable | Default | What it does |
|---|---|---|
| `STEALTHGPT_API_KEY` | — | without it nothing is humanized |
| `STEALTHGPT_MODEL` / `STEALTHGPT_MODE` / `STEALTHGPT_OUTPUT_FORMAT` | `standard` / `Low` / `markdown` | |
| `HUMANIZE_NON_FICTION` | true | blog, newsletter op, social posts, editor passage |
| `HUMANIZE_NEWSLETTER_SEGMENTS` | true | the newsletter saga's story sections (prose only; headings and labels kept) |
| `HUMANIZE_RADAR_DRAFTS` | true | posts the radars draft onto the calendar (`social_schedule_v2.humanize`) |
| `HUMANIZE_COLLAPSE_RETRY_MODE` | `Medium` | retry a `structure_collapsed` chunk once at this mode; empty = no retry |
| `HUMANIZE_MAX_WORDS_PER_RUN` | 20000 | spend ceiling per run (a newsletter shares one ceiling across its sections) |

A rejected chunk still bills. Every call writes a `token_usage_v2` row (provider `stealthgpt`).

## Verify

```bash
curl https://writer-engine-gateway-<railway-id>.up.railway.app/admin/health
# {"status":"ok","service":"gateway"}

curl -X POST \
  -H "X-Service-Secret: $SERVICE_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  https://writer-engine-gateway-<railway-id>.up.railway.app/internal/write/library \
  -d '{"op":"retrieve","user_id":"00000000-0000-0000-0000-000000000000"}'
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

## Scraping (ScraperAPI, replaced Firecrawl 2026-11-01)

Newsletter ingestion, the newsletter's source scrape and `media.scrape-url` all fetch pages through
ScraperAPI and read the article body out with `trafilatura` (`writer_engine/scraping.py`). No model
call is involved in reading the page, so the body is the page's own text.

Variables on `writer-engine-runtime` (never in GitHub):

| Variable | What it does | Without it |
|---|---|---|
| `SCRAPERAPI_API_KEY` | ScraperAPI key, sent as the `x-sapi-api_key` header (never in the URL). | No scraping: ingestion records items as deferred, the newsletter's story sources come back empty |
| `SCRAPER_ENABLED` | `false` stops spending without removing the key. Default `true`. | — |
| `SCRAPER_RENDER_FALLBACK` | When a page has no readable body (a JavaScript shell), fetch it once more with `render=true` — 10 credits instead of 1. Default `true`. | JS-only pages are skipped |
| `SCRAPERAPI_COUNTRY_CODE` | Optional proxy country, e.g. `us`. | ScraperAPI chooses |
| `SCRAPERAPI_MAX_CONCURRENCY` | Requests in flight at once, per process. The plan allows 5 and answers 429 past it. Default `3`. | — |

Cost, measured on the DEV account 2026-11-02 (plan: 5,000 credits/month, 5 concurrent): a plain page
is 1 credit, but ScraperAPI bills protected sites at its premium rate even without rendering (The
Verge: 10 credits), and a protected page that also needs rendering costs more again (abc.xyz: 30 for
the plain fetch plus the rendered one). Each request's cost is in its `sa-credit-cost` header.

`FIRECRAWL_API_KEY` and `FIRECRAWL_ENABLED` are no longer read and can be deleted from both engine
services.

## Post calendar, radars and the two editions (port of the n8n blog / LinkedIn system)

Migration 038. The engine now owns what n8n's `Cron - Post Scheduled Website Blogs`, Trend Radar,
Dev Radar, Batch Week and Roundup Batch did. Workbench: **Newsletter → Post calendar** and
**Newsletter → Radars**. Code: `writer_engine/social/` (queue, channels, publisher, edition feed) and
`writer_engine/radar/` (the two radars and the week drafting).

Variables on `writer-engine-runtime` (never in GitHub):

| Variable | What it does | Without it |
|---|---|---|
| `SOCIAL_POSTING_MODE` | `live` posts for real. Anything else (default `dry_run`) records each channel's exact request as a `dry_run` delivery and sends nothing. | dry run |
| `INTEGRATIONS_ENCRYPTION_KEY` | 32 random bytes, base64. Decrypts each user's Blotato key and blog tokens (`user_integrations_v2`, migration 043). **Must be the same value on `WritersWorkbench`** (which encrypts them) — set on those two services only. | per-user keys cannot be read: deliveries fail with "INTEGRATIONS_ENCRYPTION_KEY is not set on this service" |
| `YOUTUBE_API_KEY` | Dev Radar's YouTube search (8 queries, 800 quota units a week). | Dev Radar uses the 45-day video archive only |
| `KIEAI_API_KEY` | Sketchnote images (already set). | posts go out without an image |

**Blotato and blog keys are per user, not variables.** `BLOTATO_API_KEY` and `TECHAHIR_BLOG_API_KEY`
are **no longer read** (and the website channel's `auth_env` is gone) — delete them from
`writer-engine-runtime` if present. Each user enters their own Blotato API key, Blotato LinkedIn
account id, LinkedIn page ids, and each blog's endpoint / auth header / token in the Workbench under
**Settings → Integrations**. The server encrypts every key with AES-256-GCM
(`INTEGRATIONS_ENCRYPTION_KEY`, bound to the user and channel) before storing it; the table has no
read policy for signed-in users, and the API returns only set / last 4 / updated. The engine decrypts
at send time with the post owner's credentials, and re-checks each blog endpoint for SSRF (https,
public addresses only, no redirects). A dry-run delivery's detail says which credentials would be
used, or "would fail: …" when one is missing.

Generating the key (never print it, never commit it), once per environment, and setting the SAME
value on both services:

```bash
KEY=$(openssl rand -base64 32)
railway variables -e <env> -s WritersWorkbench      --set "INTEGRATIONS_ENCRYPTION_KEY=$KEY" --skip-deploys
railway variables -e <env> -s writer-engine-runtime --set "INTEGRATIONS_ENCRYPTION_KEY=$KEY" --skip-deploys
unset KEY
```

Rotating it makes every stored key unreadable (each user re-enters theirs); there is no re-encrypt
job. DEV has its own key; **a PROD cutover generates a separate PROD key** — never copy DEV's.

Crons (engine internal timer, all US Eastern): publisher every 5 min (slots 09:00 / 14:00), radars
hourly check (Trend Monday 06:00, Dev Sunday 06:00), one run per user, radar and week.

**Cutover order — n8n is still posting the same calendar.** Turning on `SOCIAL_POSTING_MODE=live`
while n8n's cron is active would post everything twice. Order: deactivate n8n `Cron - Post Scheduled
Website Blogs` (Se2X0fmkLUFK6CCq), Trend Radar (q1yDjiztjdGRDblT) and Dev Radar (czBKvhON08FzFydK);
re-run `scripts/seed_social_dev.py --import-n8n` so the last n8n posts are in; then set `live`.
Imported n8n rows that were still `pending` are imported as `cancelled` on purpose — requeue the ones
the engine should post.

Setup on a database: `python scripts/seed_social_dev.py --seed` (channels, the Blotato account id,
radar subscriptions, the `ai-mvp` and `ai-dev-roundup` editions with their `radar://` and `social://`
sources). It inserts missing channels only and never overwrites what was changed in the UI, and it
seeds no keys: those are entered in Settings → Integrations. DEV only; it
refuses any other Supabase URL.

For PROD use `python scripts/seed_social.py` (PR #233), which reuses the same row definitions: a dry
run by default (`--apply` writes), `--target prod` refuses to touch the network without `--confirm`
and refuses a DEV key, rows are written `enabled=false` on PROD unless `--enable`, and `--offline`
prints the plan without reading any database. Run it only at the cutover, with Eric's go-ahead.

### Content Studio (port of the n8n studio chat agents)

Migration 050. **Newsletter → Content Studio** (`/newsletter/studio/<edition>`), shown only to a user
with an edition fed by one of their own radars (today only Eric's `ai-mvp` and `ai-dev-roundup`).
Replaces the interactive n8n agents `Content - AI & MVP Content Studio (Workflow B)` (fTRYiQOaQgdAmu7w)
and `Content - AI Dev Roundup (Social Studio)` (y0vIznzMeiGoxouX), their queue tool `Sub - Manage
Scheduled Posts` (HgRagIb4C3klIJa0), `Studio - Email Post with Featured Image` (oYxlkOY7J0eK4yxo),
`Dev Roundup - Weekly Digest Email` (WiG2AmTTf6rUj6gS) and the two Substack RSS webhooks
(uSFq6y6YombFzzfT per item, K6peMqAydbdr7Ldt weekly digest).

- **Studio edition** = the caller owns the edition AND subscribes to the radar that feeds it
  (`radar_subscriptions_v2.settings.edition_id`, or an active `radar://<radar>` feed source). Anything
  else is a 404 on every route (server `lib/studio.ts`, engine `studio.core.resolve_edition`); the new
  tables' RLS is owner-only (no admin read).
- **Draft → review → publish.** Drafts are `social_schedule_v2` rows in state `draft` / `approved`
  with no day or slot, so neither the publisher (claims `pending`) nor the calendar (reads by date)
  sees them. Scheduling sets `pending` with the next free slot, a day + slot, or an exact `post_at`
  ("publish now" = the next 5-minute publisher tick). A chosen `image_url` replaces the sketchnote.
  `SOCIAL_POSTING_MODE` still decides whether anything is sent (dry run on DEV).
- **Engine:** step service `studio` (`services/studio_step`, mounted in the runtime like every step;
  `STUDIO_STEP_URL` is set by `runtime_processes`, nothing to configure). Ops `slate`, `queue`,
  `generate` (heavy queue), `revise` (revise / regenerate / undo), `update`, `schedule`, `issue`,
  `email`. Drafting reuses the radar prompts (`radar/drafts.py`) and the humanizer.
- **Assistant:** `POST /api/studio/<ed>/assistant` calls the hub with `context.surface=content_studio`
  and the edition. The hub parses the studio command grammar first (`studio/commands.py`: "generate
  1-5, 8", "revise #3 to be shorter", "schedule all approved", "cancel 4", "put 1-6 in the
  newsletter"), then falls back to Gemini over the studio ops only. The general chat never routes to
  studio ops. The edition always comes from the page context, never from the message.
- **Credits:** `studio.generate` = `social_repurpose` × topics, `studio.revise` = `social_repurpose`,
  the rest free (`credit-costs.ts`; no new prices — pricing is pending Eric's decision).
- **Newsletter:** an edition's open selection (`newsletter_issue_selections_v2` / `_items_v2`) is
  authoritative. The saga's gathering stage writes one `content_ingestion_v2` story per chosen item
  (key `<send_date>/<slug>.<edition>`, feed_url `studio://<edition>`), skips the LLM pick, puts exactly
  those stories in order on the stories gate, and locks the selection to the run. Without a selection
  the edition behaves as before (radar:// + social:// sources, LLM pick). Generate / approve / send
  use the existing screens.
- **RSS:** `GET /feeds/<token>/items.xml` (posts that went out; subscribe-CTA and hashtag lines
  removed) and `/feeds/<token>/digest.xml` (one item per week: the whole slate). The token
  (`newsletter_edition_feeds_v2`, 32 url-safe random characters) is made on first view in the studio
  and can be rotated there. Public, no login, no private data.

**n8n workflows this makes redundant — deactivate in this order at the cutover, with Eric's
go-ahead (never delete; archive):**

1. Point Substack at the new feed URLs (Studio → Next issue & feeds) and wait for one successful sync;
   then deactivate `uSFq6y6YombFzzfT` and `K6peMqAydbdr7Ldt` (the old feed URLs stop).
2. The two chat studios `fTRYiQOaQgdAmu7w`, `y0vIznzMeiGoxouX` and their tools `HgRagIb4C3klIJa0`,
   `oYxlkOY7J0eK4yxo`, `kw8qbViDZjaiDPeV`, `6eQyuNp2A2bEIx1a`, `rkwZa88G7EJc7HY8`, `427jMgRQEYzDA1IN`,
   `hZq4ix2Te4vtPIuo`, `oxYeY4EXPctC7L3o`, `FaxRBqptjRfk8YuB` — after the calendar cutover above
   (Se2X0fmkLUFK6CCq, q1yDjiztjdGRDblT, czBKvhON08FzFydK off; `SOCIAL_POSTING_MODE=live`), because the
   chat studios can post directly through Blotato.
3. `Dev Roundup - Weekly Digest Email` (WiG2AmTTf6rUj6gS): once `ai-dev-roundup` has a cadence and
   its first studio-chosen issue has gone out.

Not ported on purpose: the n8n studios' Perplexity research step before an interactive draft (the
radar slate already carries the summary the drafting prompt cites), posting a **condensed blog** to
LinkedIn ("post blog to linkedin" — use Revise with AI on the LinkedIn text instead), and Blotato's
native scheduling (every scheduled post is on the calendar instead, so it can be listed and edited).
The KIE.ai key that n8n hard-codes in four of these workflows should be rotated after they are off.
