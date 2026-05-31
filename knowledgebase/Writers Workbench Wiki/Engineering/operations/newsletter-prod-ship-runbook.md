---
name: Newsletter PROD-ship runbook
description: Concrete remaining steps to ship the newsletter cluster DEV→PROD as of 2026-05-28. The 4 newsletter workflows have NO PROD counterparts, so they must be CREATED (not updated by promote-dev-to-prod.py). Covers env var, webhook-path collision, callback retargeting, ID map, seed, smoke, release.
type: concept
tags: [operations, promotion, newsletter, runbook, gate-1]
last_reviewed: 2026-05-28
---

# Newsletter PROD-ship runbook

Supersedes the newsletter-specific parts of [[promotion-dev-to-prod]] (which assumes every workflow already has a `PROD - X` pair updated in-place). **The newsletter cluster is the exception** — its workflows have no PROD copies yet, so they must be **created**, and `scripts/promote-dev-to-prod.py` (UPDATE-in-place only) does **not** handle them. This page is the actual procedure, written from a live n8n + Railway audit on 2026-05-28.

## Status as of 2026-05-28

Already done (Gate 1.1–1.4 + an unplanned infra fix):
- E2E suite green; PR #76 (E2E) and PR #68 (migration 015 + render-html node) merged to `develop`.
- PROD Supabase migrations **013, 014, 015, 016, 017 applied + verified** (`faklxfakgzkpkbxfihzh`, us-west-2 pooler). public table count 30 → 35; seeded Workbench template html=12573 with `body_md`.
- **PROD Redis outage fixed** — it had been down since 2026-05-19; redeployed Redis then Workbench; `/api/health` = all ok. See [[prod-redis-outage-risk]] in auto-memory. This was a prerequisite: newsletter generation rides BullMQ + SSE on Redis.

Still to do: everything below.

## The 4 newsletter workflows (live IDs + triggers)

| Workflow | n8n ID | Trigger(s) | Callbacks today point at |
|---|---|---|---|
| Content - Newsletter Agent V2 | `bMvMKyK8obwYZmNb` | `formTrigger` **+** `webhook` (path `compose-newsletter-dev`) — both feed `set_trigger_inputs` | `writersworkbench-develop` (~30 httpRequest nodes) |
| AI News Data Ingestion V2 | `2T3TwGHhdGQlTpQ5` | 6 RSS + 11 scheduleTrigger (no webhook) | `writersworkbench-develop` |
| DEV - Newsletter Cadence Cron | `7l1z4uMS9kdkYIT4` | `scheduleTrigger` | `writersworkbench-develop` (fetch_due_editions + post_to_webhook) |
| DEV - Newsletter Ingestion (Multi-User Cron) | `JAQ8rmCaDoddqt2k` | `scheduleTrigger` | `writersworkbench-develop` |

All four are effectively **DEV-tier** (callbacks hardwired to the DEV Workbench). The two without a `DEV -` prefix (`Content - Newsletter Agent V2`, `AI News Data Ingestion V2`) are shared/legacy names that never got tier-split.

## How the app triggers generation

`server/src/routes/newsletter.ts:351` — `POST /api/newsletter/generate` reads a single env var **`N8N_NEWSLETTER_WEBHOOK_URL`** and POSTs to it with header `X-Ingestion-Secret`. There is **no `_DEV`/`_PROD` variant** — each Workbench environment's own value decides which workflow it hits.

**Current bug:** `N8N_NEWSLETTER_WEBHOOK_URL` is **unset on both** develop and production (verified via Railway). So the in-app Generate button is dead on both tiers; newsletters only run if the n8n form/cron is fired directly.

## Callback auth — shared secrets (no new n8n credentials needed)

The callback nodes use `httpHeaderAuth` n8n credentials for `X-Ingestion-Secret`, `X-Callback-Secret`, `X-Email-Secret`. The underlying secret VALUES are **identical across DEV and PROD** Railway envs (`INGESTION_SECRET`, `NEWSLETTER_CALLBACK_SECRET`, `EMAIL_SECRET` all match). So PROD workflow copies can **reuse the existing n8n credentials** — only the callback host + Supabase refs change, not the auth.

---

## Step 0 — Prove the flow on DEV first (do before any PROD work)

The full generate→approve→send path has never been run end-to-end via the app (env var was unset).

1. Set on **DEV** WritersWorkbench (bubbly-solace, `develop` env):
   ```
   N8N_NEWSLETTER_WEBHOOK_URL = https://n8n.agileadautomation.com/webhook/compose-newsletter-dev
   ```
2. Redeploy DEV Workbench (also re-attaches private networking).
3. From the DEV UI: Newsletter → Generate → pick edition → run. Watch stages: gathering → picking → stories approval → subject → segments → render-html → save → subscribers. Verify a row lands in DEV `newsletter_sends_v2` with `html_body` containing the Workbench masthead (`Playfair Display`).
4. Fix anything that breaks here BEFORE replicating to PROD.

## Step 1 — Create the 4 PROD workflow copies

For each DEV/shared workflow, create a new `PROD - <name>` on n8n via `n8n_create_workflow` (or REST POST), transforming:

- **Callback host:** `https://writersworkbench-develop.up.railway.app` → `https://writersworkbench-production.up.railway.app` (every httpRequest node URL).
- **Webhook path** (Agent V2 only): `compose-newsletter-dev` → `compose-newsletter-v2` (avoids the active-webhook path collision; the original keeps `-dev`).
- **Supabase refs** (if any Set/Code/HTTP node hits Supabase directly): DEV `gvbvwcnmjkdpclcisqrr` → PROD `faklxfakgzkpkbxfihzh` + service key.
- **`executeWorkflow` refs:** `Content - Newsletter Agent V2` calls a scraper sub-workflow via `scrape_segment_external_source_url`. Point the PROD copy at the PROD scraper id (or a shared scraper) — verify the target exists before activating.
- **Keep** the shared httpHeaderAuth credential refs as-is (secrets are tier-shared, see above).
- Cron workflows (`scheduleTrigger`): no webhook path; just retarget the fetch/post URLs to PROD and the Supabase refs.

Create them **inactive first**; activate only after Step 4 smoke.

## Step 2 — Set PROD env var

On **PROD** WritersWorkbench (bubbly-solace, `production` env):
```
N8N_NEWSLETTER_WEBHOOK_URL = https://n8n.agileadautomation.com/webhook/compose-newsletter-v2
```
Redeploy PROD Workbench.

## Step 3 — Map the IDs

Add the 4 new PROD↔DEV pairs to `scripts/workflow-id-map.json` under `prod_to_dev` so future `promote-dev-to-prod.py` runs keep them in sync in-place. Record the new PROD ids here too.

## Step 4 — Seed PROD demo (Gate 1.6)

Seed a demo edition + a few placeholder subscribers in PROD Supabase so the smoke + marketing screenshots have data. (PROD already has the `ai-news` / "The Workbench" edition from migration 012.)

## Step 5 — PROD smoke (Gate 1.7)

- `curl .../api/health` → all ok (already true).
- Run the regression suite's read-only describe against PROD.
- Fire one real generation on PROD via the UI; confirm the row lands in **PROD** `newsletter_sends_v2` (not DEV) and the email send hits Postal with the right From.

## Step 6 — Release (Gate 1.8)

Per [[promotion-dev-to-prod]] Steps 7–12: cut `release/v-newsletter` from `develop` → PR to `main` → tag → push deploy ref → verify → sync `develop` ← `main` → update [[releases-and-tags]] + SESSION_CONTEXT.

## Gotchas specific to this cluster

- **Webhook path collision:** two active workflows cannot share a webhook path. The PROD Agent V2 MUST use `compose-newsletter-v2`, not `compose-newsletter-dev`.
- **`promote-dev-to-prod.py` won't create these** — it only updates existing PROD pairs. First promotion is a manual create (this runbook). Subsequent updates can use the script once the pairs are in the id map.
- **Scraper sub-workflow dependency** — don't activate PROD Agent V2 until its `executeWorkflow` target resolves to a live PROD (or shared) scraper.
- **Don't point PROD's env var at the shared `-dev` workflow** — that's the tier-crossover trap (PROD data written to DEV).
- **Redis must be up** (it is now) or generation hangs in the queue — see [[prod-redis-outage-risk]].
