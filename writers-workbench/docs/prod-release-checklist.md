# PROD release checklist (engine cutover)

| | |
|---|---|
| **Status** | Not started. Nothing below has been run against PROD |
| **Written** | 2026-11-03, from `origin/develop` at `600be4b` (PR #260) |
| **Verified against** | the migrations folder, engine `config.py`, server `process.env` reads, DEV Railway variable **names** (`railway variables -e develop`; no values read), read-only queries on DEV Supabase, the n8n workflow list |
| **Not verified** | anything on PROD. PROD's schema, variables and deploy branch must be checked on the day, step 2 and step 3 below |

This release is an **engine cutover**, not an n8n promotion. DEV runs the Python engine
(`HUB_BACKEND=engine`, `NEWSLETTER_BACKEND=python`) with its Workbench n8n workflows switched off.
PROD is still entirely n8n, has no engine services, and is about 4 months behind DEV. Do the steps in
order. Every step that writes to PROD needs Eric's explicit go-ahead (CLAUDE.md, Tiers 2 and 3).

Related: [stripe-billing.md](stripe-billing.md) (live-mode steps), [workflow-governance.md](workflow-governance.md),
[`engine/docs/deployment.md`](../engine/docs/deployment.md) (engine variables), wiki
`Engineering/sprints/remaining-work-inventory.md` (what is still open).

---

## A. Before release day

1. **Code is finished on DEV.** The open items in the remaining-work inventory's "Before PROD" list
   are closed or explicitly deferred by Eric.
2. **Confirm what PROD deploys from.** `release/v1.0` (tip 2026-04-28) and `main` (tip `fba46c9`,
   2026-06-30) disagree with PROD's last reported deploy (2026-07-01). Check the PROD
   `WritersWorkbench` service's source branch in the Railway dashboard. Both branches' commits are
   now in `develop` (PR #224; `04038cc` is an ancestor of `develop`).
3. **Take a schema-only dump of PROD** (`pg_dump --schema-only`, read-only) and record which of the
   migrations in section B are already there. The docs disagree on 013–017 (wiki said NO, the
   2026-05-28 log said applied). 015 is a data-only template update, so check the template row,
   not the schema.
4. **CI and E2E green on `develop`**: required checks plus a full `writer-e2e` pass on DEV (Playwright
   Pass A/B/C and the 157-test engine suite, which the runner now runs every pass, PR #221).
5. **Rotate exposed credentials** (Eric): PROD user passwords that were published in the vault, the
   PROD Postgres password and the 4 API keys flagged since May, the old n8n API key (still written
   into `PROD - Sub - Token Usage Tracker` `dk75OYTASeu6NkTr`, so move that header to an n8n
   credential first), the RPI sandbox key.
6. **Decide on a hub acceptance run and a shadow period** (inventory D2; never run).
7. **Hotfix path:** `main` requires the `Engine CI` check, but `.github/workflows/engine-ci.yml`
   exists only on `develop`. Until the release PR merges, a `hotfix/*` PR to `main` cannot get that
   check. The release PR itself is fine (it carries the workflow).

## B. Database — PROD Supabase (`faklxfakgzkpkbxfihzh`)

Apply in file order, each once, after step A3. `018`–`022` were never written. All of these are applied
on DEV (checked 2026-11-03: every table, column, function, trigger and policy below exists on DEV).
Every doc records 023 onwards as DEV-only; confirm against the dump. 050 and 051 were applied to DEV on 2026-11-03; 052 on 2026-11-03; 054 on 2026-11-03.

| # | What it does | PROD note |
|---|---|---|
| 013–017 | Newsletter: genre URLs, templates, the template `{{body_md}}` zone (015, data only), feed sources, logos/subscribers/sign-off | Only if the dump says they are missing |
| 023 | Engine approval mirror (`newsletter_approvals_v2` compatibility) | |
| 024 | `newsletter_sends_v2` unique (edition, date) | Needed by the engine newsletter saga |
| 025 | `chapter_qa_v2` (CR-005) | |
| 026 | `research_report_projects_v2` (CR-006) | Then run `scripts/backfill_research_project_links.py` (repo root) against PROD, dry run first |
| 027 | `match_writing_embeddings_v2` vector search | Engine canon retrieval |
| 028 | `engine_job_runs` run ledger | Run lease + reaper depend on it |
| 029 | `newsletter_feed_sources_v2.item_type` | |
| 030 | `user_login_tokens_v2` (passwordless login) | |
| 031 | `credit_transactions` gains `trial_grant` | |
| 032, 033 | Author profiles, pronouns | |
| 034 | `generated_images_v2` image type `reference_photo` | |
| 035, 037 | Landing-page reservations, mailings | |
| 036 | `print_orders_v2` (RPI) | |
| 038 | Post calendar, radars, two editions | |
| 039 | Stripe | Never add a second FK from `user_subscriptions` to `subscription_tiers` (the DEV PGRST201 incident) |
| 040 | RLS on `writing_embeddings_v2` | |
| 041 | Newsletter issue numbers | **Backfills**: numbers every existing send per edition and rewrites the "Issue #1" text in stored `html_body`. Generic, but it does touch PROD rows; review on the dump first |
| 042 | `social_schedule_v2.humanize` | |
| 043 | `user_integrations_v2` (encrypted per-user keys) | Moves a Blotato `account_id` out of `social_channels_v2.config`. Needs `INTEGRATIONS_ENCRYPTION_KEY` (section D) before anyone saves a key |
| 044 | Exact cost recording on `token_usage_v2` | **Drops the RLS policy `"Own data only"`** on `token_usage_v2` (it was `USING (true) WITH CHECK (true)`). Reads keep `"Users see own token usage"` + `"Admins see all token usage"`. Before applying: confirm the PROD n8n token tracker writes with the **service-role** key, not anon, or PROD token tracking stops until n8n is off. Also re-prices Haiku 4.5 / Opus 4.8 rows |
| 045 | `app_config_global_v2` | Then set the shared settings in Admin → Global Settings |
| 046 | Backfill `token_usage_v2.user_id` for newsletter + ingestion rows | Data only, generic rules |
| 047 | Price n8n-era zero-cost rows; provider `google` → `gemini` | Data only. The row counts in its header are DEV's |
| 048 | `token_usage_v2_default_labels` insert trigger | Its backfill filters `created_at >= '2026-11-02'` for one DEV shape; on PROD it should match nothing. Harmless |
| 049 | Provider aliasing in the 048 trigger | Requires 048 |
| 050 | Content Studio: `social_schedule_v2` gains `draft`/`approved` states (undated), `edition_id`, `post_at`, `image_url`, `studio`, source `studio`, and a new posting-time trigger; `newsletter_issue_selections_v2` / `_items_v2`; `newsletter_edition_feeds_v2` (RSS tokens). Owner-only RLS | Requires 038. **Backfills** `edition_id` on existing `trend_batch` / `roundup_batch` rows from the radar subscriptions (on PROD that is only rows made after 038). Replaces the trigger function `social_schedule_before_write` |
| 051 | `newsletter_sends_v2`: one saved issue per **edition** per day instead of one per user per day (drops `idx_newsletter_sends_v2_user_date_unique`, adds a partial unique index for edition-less n8n-era rows) | Indexes only, no data change. Without it, a user's second edition on the same day fails before sending |
| 052 | Final "Send to subscribers" gate: `newsletter_approvals_v2` stage CHECK gains `send`, decision CHECK gains `reject`; new `newsletter_owner_emails_v2` (test copies + slate emails sent to the owner). Owner-only RLS | **Apply before deploying the engine/Workbench release that contains the send gate**: without it the engine cannot mirror the final gate and every newsletter run errors at the send gate (nothing is sent). CHECKs only widen; new table |
| 053 | Book plans + Billing page: `credit_packs_v2` (Half Book 1,000/$99, Full Book 2,000/$199, Top-up 250/$29, Top-up 500/$55) and `billing_settings_v2` (auto-recharge settings + once-per-crossing claim). Owner-only / read-only RLS | Then run the Stripe seed (section D, **live** key) so each pack gets its Product + one-time Price, and add `payment_intent.payment_failed` to the PROD webhook endpoint's events (docs/stripe-billing.md) |
| 055 | Blotato posts to every platform: `social_channels_v2.kind` CHECK widened from (website, linkedin) to all nine Blotato platforms; existing LinkedIn channels get their `account_id` / `target_id` back in config. The Blotato row's config now stores the accounts synced from the key | Without it switching on a Facebook / Threads / X … account in Settings → Integrations fails the kind CHECK (500), and the three LinkedIn channels show as "not on the synced list" until re-switched. No key values touched |
| 054 | Promotion copy assistant: `book_copy_v2` (per-book subtitle, inside-flap copy, the Also-by list), one FK each to `users_v2` and `writing_projects_v2`. Owner-read / service-role RLS | New table only. Without it the Publish tab's subtitle / inside flap / Also by cannot be saved (the save answers 503 MIGRATION_PENDING) and the exports print none of them; everything else works. The assistant's price is the new credit key `promo_copy` (2 per field), editable in the superuser panel |
| 056 | Audiobooks: `audiobooks_v2` (voice, delivery style, spoken credits, per book) and `audiobook_chapters_v2` (one recording per chapter: the narrated text, build state, the stored MP3 and its measured loudness), plus the private `audiobooks` storage bucket. Owner-read / service-role RLS | New tables only. Needs the engine runtime image with `ffmpeg` (added to `services/runtime/Dockerfile`; a PROD engine deploy picks it up) and `OPENAI_API_KEY` on the engine (already set on DEV). Without the migration the Publish tab's Audiobook section cannot load. The price is the new credit key `audiobook_narration` (8 credits per started 1,000 words, an estimate from the speech model's list price; owner decision pending), editable in the superuser panel |
| 057 | Audiobook pronunciation guide: `audiobooks_v2.pronunciations` (JSONB, default `[]`) | One new column on a table 056 created (not a base table). Apply after 056. Without it saving the narrator's pronunciation guide fails; everything else about the audiobook works |

After the migrations:

8. **Storage buckets.** DEV has `author-content, cover-images, newsletter-archive,
   newsletter-ingestion, newsletter-logos, print-files, social-images, writing-samples`. Create the
   public `newsletter-archive` bucket on PROD if missing; `print-files` is created by the server on
   first use (`server/src/routes/print.ts`).
9. **Supabase Auth** (PROD and DEV): Site URL and redirect URLs set to the tier's own URL (still the
   factory `localhost:3000`, inventory I9).

## C. Railway PROD — create the engine

10. Create `writer-engine-gateway` and `writer-engine-runtime` in the `production` environment,
    **repo-connected** (root `writers-workbench/engine`, Dockerfiles `services/gateway/Dockerfile`
    and `services/runtime/Dockerfile`), deploying from the release branch, not `develop`. Never
    `railway up`.
11. Replicas: 4 gateway, 4 runtime, set per environment (not in the toml).
12. Redis: provision HA Redis like DEV (`redis-ha.railway.internal`), or explicitly accept a single
    Redis with external alerting.

## D. Railway PROD — variables

Names below are the DEV names (read 2026-11-03). Generate **new** PROD values for every secret;
never copy a DEV secret.

**Both engine services**

| Variable | Note |
|---|---|
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | **60**. Railway's default 0 makes the graceful drain dead code |
| `RAILWAY_DOCKERFILE_PATH`, `PORT` | gateway 8000, runtime 8001 |
| `SERVICE_SHARED_SECRET` | new; same value on the Workbench |
| `ADMIN_TOKEN` | new; the Workbench reads it as `ENGINE_ADMIN_TOKEN` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | PROD project |
| `REDIS_URL` | PROD Redis |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`, `KIEAI_API_KEY` | |
| `POSTAL_API_KEY`, `POSTAL_API_URL`, `ALERT_EMAIL` | |
| `ARCHIVE_BASE_URL`, `WORKBENCH_API_URL`, `INGESTION_SECRET` | PROD bucket / PROD Workbench |
| `ENABLE_PYTHON_EMBEDDINGS` | set on DEV; the code default is **false**, so without it chapters lose canon retrieval |
| `PICKER_MODEL`, `LOG_LEVEL`, `METRICS_PORT` | as DEV |

Gateway only: `ORCHESTRATOR_URL=http://writer-engine-runtime.railway.internal:8001`.

**Runtime only**

| Variable | Note |
|---|---|
| `INTEGRATIONS_ENCRYPTION_KEY` | new PROD key (`openssl rand -base64 32`), **same value on the Workbench**; never DEV's |
| `SCRAPERAPI_API_KEY` | optional tuning: `SCRAPERAPI_MAX_CONCURRENCY` (default 3, plan allows 5), `SCRAPER_ENABLED`, `SCRAPER_RENDER_FALLBACK`, `SCRAPERAPI_COUNTRY_CODE`. Watch credit burn (5,000/month plan) |
| `STEALTHGPT_API_KEY` | optional. Humanizer switches default on: `HUMANIZE_RADAR_DRAFTS`, `HUMANIZE_COLLAPSE_RETRY_MODE=Medium`. `HUMANIZE_NEWSLETTER_SEGMENTS` defaults **off** since 2026-11-03 (on DEV the sections mostly failed the guards and still billed); leave it unset on PROD |
| `NEWSLETTER_CALLBACK_SECRET` | same as the Workbench |
| `WORKBENCH_CRON_SECRET` | equal to the Workbench's `CRON_SECRET` |
| `AUTOSCALE_ENABLED`, `AUTOSCALE_MIN_REPLICAS=4`, `AUTOSCALE_MAX_REPLICAS`, `RAILWAY_AUTOSCALE_TOKEN` (production-scoped), `AUTOSCALE_ALLOW_PRODUCTION=true` | |
| `SOCIAL_POSTING_MODE` | leave unset (dry run) until section H |
| `YOUTUBE_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | optional; not set on DEV. Without ElevenLabs the Eve callback and the KB prune cron are dry runs |

Do not set `FIRECRAWL_*`, `BLOTATO_API_KEY` or `TECHAHIR_BLOG_API_KEY`: no longer read (Blotato and blog
keys are per user, Settings → Integrations).

**Workbench (`WritersWorkbench`)**

| Variable | Note |
|---|---|
| `ALLOWED_ORIGINS`, `NODE_ENV=production` | PROD URL |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `DATABASE_URL` | PROD |
| `HUB_BACKEND=engine`, `NEWSLETTER_BACKEND=python` | the cutover switches. `NEWSLETTER_BACKEND` defaults to `n8n` |
| `ENGINE_GATEWAY_URL`, `NEWSLETTER_SERVICE_URL` | PROD gateway |
| `SERVICE_SHARED_SECRET`, `ENGINE_ADMIN_TOKEN` | match the engine (`ENGINE_ADMIN_TOKEN` = engine `ADMIN_TOKEN`; the server falls back to `ADMIN_TOKEN` if unset). Needed by Admin → Engine Fleet / scheduler |
| `INTEGRATIONS_ENCRYPTION_KEY` | same value as the runtime |
| `CRON_SECRET` | still unset on PROD (inventory D9) |
| `NEWSLETTER_CALLBACK_SECRET`, `REDIS_URL`, `ALERT_EMAIL` | |
| `RPI_PRINT_MODE=production`, `RPI_PRINT_AUTH`, `RPI_PRINT_WEBHOOK_SECRET` | live RPI values |
| `DRY_RUN_EMAIL=false`, `SENDER_NAME` (no "(Dev)") | |
| `N8N_*` / `VITE_N8N_WEBHOOK_URL` on `_v2` | keep for rollback |
| Stripe | section E |

Do not create `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` or a `writer-e2e` service on PROD. The PROD
Workbench must not sleep.

## E. Stripe live mode

13. Follow [stripe-billing.md](stripe-billing.md) "Setting up an environment": live keys, webhook
    registration + `STRIPE_WEBHOOK_ENDPOINT_ID`, `npx tsx scripts/seed-stripe-products.ts`, the
    billing backfill, and `STRIPE_WEBHOOK_SECRET` last.

## F. Deploy

14. Cut `release/vX.Y` from `develop`, PR to `main`, tag `vX.Y.0`, point the PROD services
    (Workbench and both engine services) at the release, merge `main` back into `develop`.

## G. Seed and switch on (each needs Eric's go-ahead)

15. **Social set-up:** `engine/scripts/seed_social.py --target prod --confirm` (dry run; reads only),
    review, then add `--apply`. Rows are written `enabled=false` on PROD unless `--enable`. It refuses
    a DEV key under `--target prod`. Each user then enters their Blotato and blog keys in Settings →
    Integrations.
16. **Uptime:** add the PROD URLs to `.github/uptime-targets.txt`
    (`https://writersworkbench-production.up.railway.app/api/health`, and the two PROD engine
    `/admin/health` URLs once their domains exist). The scheduled check only runs from `main`, so it
    starts with this release.

## H. Post-release checks

17. `/api/health` reports `environment: production`, all checks ok, the release SHA.
18. Engine `/admin/health` and `/admin/ready` on both services; Admin → Engine Fleet shows 8 instances
    and its scheduler section shows all 10 cron jobs ticking (`ingestion`, `newsletter-cadence`,
    `publish-scheduled`, `social-publish`, `radar`, `queue-metrics`, `autoscale`,
    `workbench-lifecycle`, `eve-kb-prune`, `run-reaper`).
19. Response headers: `no-cache` on `index.html`; `blob:` and `wasm-unsafe-eval` in `script-src`;
    Supabase in `connect-src` (the 2026-06-30 CSP hotfix).
20. Read-only smoke: sign in, open a project, story bible, chat (a list then "pick #2" proves hub
    memory).
21. One engine newsletter send (issue number filled in), one live Stripe checkout, one cost row per
    provider visible on the Cost page (`/cost`, per-operation view) with operation, user and project.
22. Run the uptime workflow by hand once (`workflow_dispatch`) and confirm the PROD targets pass.
23. **After a soak period, with sign-off:** point the PROD Eve agent `agent_2801kks580vnf5q80j3bd0n0x45v`
    at the PROD gateway `/internal/hub/voice` (inventory A8; never the V1 agent); deactivate n8n
    `Se2X0fmkLUFK6CCq`, `q1yDjiztjdGRDblT`, `czBKvhON08FzFydK`, then set `SOCIAL_POSTING_MODE=live`;
    archive (never delete) the 24 `PROD - …` Workbench workflows with a 90-day rollback window.
24. **Content Studio cutover** (after 23, with sign-off): point Substack at the edition feed URLs shown
    in Newsletter → Content Studio → Next issue & feeds (PROD URLs, new tokens — DEV tokens do not
    carry over), confirm one sync, then deactivate the RSS webhooks `uSFq6y6YombFzzfT` /
    `K6peMqAydbdr7Ldt`, the studio chat agents `fTRYiQOaQgdAmu7w` / `y0vIznzMeiGoxouX` and their tools,
    and later `WiG2AmTTf6rUj6gS` (weekly digest email). Full list and order: `engine/docs/deployment.md`
    → Content Studio. No new variables: the `studio` step is part of the runtime image.
