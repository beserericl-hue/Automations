---
name: Credentials map
description: All n8n credentials, Supabase keys, ElevenLabs API keys, Postal mail-server keys.
type: reference
tags: [operations, credentials, secrets]
last_reviewed: 2026-05-09
---

# Credentials map

Reference for every credential / secret in the system. Values themselves are NOT in this wiki — refer to the specified location.

## n8n credentials (live in n8n at `n8n.agileadautomation.com`)

| Credential name | ID | Used by | Notes |
|-----------------|----|----|----|
| Anthropic | `5LhCYKsaFO3fF7II` | All chainLlm + lmChatAnthropic nodes | Shared across V1/PROD/DEV (same Anthropic account) |
| Perplexity | `ggr9QCRobQVA6Lwb` | Native Perplexity nodes (research + brainstorm + newsletter) | Shared |
| Firecrawl | `oWli4irymtVqSDyC` | `Node - Scrape Url V2` | Shared |
| OpenAI native | `xSzPIySN61drme77` | `openAiApi` node — DALL-E 3 cover art (V1) | Working |
| OpenAI httpHeaderAuth | `BZku8v1a2K12iFGQ` | (none — broken) | DO NOT USE — was wired to broken `[OLD] Node - Scrape Url` |
| Gmail OAuth2 | `CPCSZOInV8Zj1PI1` | V1 Send/Email nodes | V1-only; PROD/DEV moved to Postal |
| DEV Workbench Email Secret | `kxrSg24PIR2Npfvw` | DEV email-sending workflows → `/api/email/send` | Header `X-Email-Secret` |
| DEV Workbench Ingestion Secret | `jQBRJbmiUeTk8c11` | DEV - Newsletter Ingestion Cron → `/api/ingestion/*` | Header `X-Ingestion-Secret` |
| DEV Workbench Approval Secret | `ytjKAO1BESVf6Cnz` | (DEV approval flows) | Header `X-Approval-Secret` |
| PROD Workbench Email Secret | (created at v1.1.0 promotion) | PROD email workflows → `/api/email/send` | |
| PROD Workbench Ingestion Secret | (not yet created — pending newsletter promotion) | | |
| PROD Workbench Approval Secret | (not yet created) | | |
| KIE.AI | (n8n credential id varies) | `Tool - Generate Cover Art` (newer alternative to DALL-E) | |

## Supabase service-role keys (Railway env vars)

| Tier | Env var | Value prefix | Lives in |
|------|---------|--------------|----------|
| DEV | `SUPABASE_SERVICE_ROLE_KEY` on `WritersWorkbenchDev` | `sb_secret_8GDV…` | Railway dashboard |
| PROD | `SUPABASE_SERVICE_ROLE_KEY` on `WritersWorkbench` | `sb_secret_huxH…` | Railway dashboard |

DO NOT bundle. Bypasses RLS.

## Supabase anon keys (also Railway env vars)

| Tier | Env var | Value prefix | Lives in |
|------|---------|--------------|----------|
| DEV | `VITE_SUPABASE_ANON_KEY` on `WritersWorkbenchDev` | `sb_publishable_…` | Railway dashboard + bundle |
| PROD | `VITE_SUPABASE_ANON_KEY` on `WritersWorkbench` | `sb_publishable_HsIkelEZaIr0VauiB3GgIQ_59XJRoWc` | Railway dashboard + bundle |

Public via bundle. RLS protects.

## Supabase database passwords (psql / pg_dump)

Same DB password for PROD and DEV (user choice). Stored in user vault.

Connection strings:
- PROD: `postgresql://postgres.faklxfakgzkpkbxfihzh:<pwd>@aws-0-us-west-2.pooler.supabase.com:5432/postgres`
- DEV: `postgresql://postgres.gvbvwcnmjkdpclcisqrr:<pwd>@aws-1-us-east-2.pooler.supabase.com:5432/postgres`

Direct `db.<ref>.supabase.co` is IPv6-only on new projects.

## ElevenLabs

| Resource | ID | Notes |
|----------|----|----|
| ELEVENLABS_API_KEY | starts `sk_cb81…` | Lives in user vault + scripts (NOT committed) |
| V1 Eve agent | `agent_6401kjwqy66nfhabj82dvy8pnh2b` | Frozen |
| V1 Eve phone | `phnum_1201kks4nfxpetpvc0n3xdkj2rx5` (`+17622495331`) | Active |
| V1 Eve original phone | `phnum_8201kectdg3ze30shnq7wsm8bm84` (`+14435012219`) | Historical |
| DEV Eve agent | `agent_0001kpr667v6ffctex0a8dt4fk71` | Active |
| DEV Eve forwarding tool | `tool_0801kprf5a14ee9b5ts7b8d2tetf` (`forward_writing_request_dev`) | |
| PROD Eve agent | `agent_2801kks580vnf5q80j3bd0n0x45v` | Active |
| PROD Eve forwarding tool | `tool_2301kksb78ygewvv3q3cm82wcfjs` (`forward_writing_request_v2`) | |

## Postal (mail server)

| Tier | Mail server name | Mode | API key location |
|------|------------------|------|------------------|
| DEV | `writers-workbench-mail-dev` | Development (swallows mail) | Postal admin → server → API Keys; Railway env var `POSTAL_API_KEY` on `WritersWorkbenchDev` |
| PROD | `writers-workbench-mail-prod` | Live | Postal admin → server → API Keys; Railway env var `POSTAL_API_KEY` on `WritersWorkbench` |

Postal admin login: `eric@agileadtesting.com` at `https://postal-admin.courseworx.media`.

## n8n API key (REST API access)

`N8N_API_KEY` — single key for the shared n8n instance. Same key works for PROD and DEV workflows.

Locations:
- `writers-workbench/.env` (gitignored)
- `.mcp.json` (gitignored — env var in the n8n-mcp server config)
- Railway `WritersWorkbench` env var
- Railway `WritersWorkbenchDev` env var

## GitHub secrets (CI)

Set in repo Settings → Secrets:
- `VITE_SUPABASE_URL` (DEV value — only DEV used in CI build)
- `VITE_SUPABASE_ANON_KEY` (DEV value)
- `E2E_TEST_EMAIL` = `eric@agileadtesting.com`
- `E2E_TEST_PASSWORD` = `Fr332bafami!y`

PROD service-role keys / Postal keys NOT in CI — they're per-tier runtime concerns.

## Auth user passwords

`Fr332bafami!y` — Eric's password on both PROD and DEV (same value as `E2E_TEST_PASSWORD`). Reset by service-role admin call during v1.1.0 release Site URL incident.

`Wr!ters1` — JR's (`+17063338699` / `racemert@yahoo.com`) PROD password. Set during v1.1.2 hotfix repair.

## Secrets in n8n workflow JSON

Shared secrets that need to be substituted at promotion:
- Supabase URL/key — every Set node + HTTP Request node referencing Supabase.
- Webhook paths — `_dev` ↔ `_v2`.
- Workbench API URL — `https://writersworkbenchdev-…` ↔ `https://writersworkbench-…`.
- (No raw API keys — those live in n8n credentials, referenced by id.)

`scripts/promote-dev-to-prod.py` and `scripts/clone-prod-to-dev.py` handle the substitution.

## Secrets NOT in n8n workflow JSON (safer practice)

API keys and shared secrets live in n8n credentials, referenced by id from the workflow. The workflow JSON itself only references `credentials: {httpHeaderAuth: {id: 'jQBRJbmiUeTk8c11'}}` etc. — values not embedded.

## Rotation procedure

For each secret category:

| Category | Steps |
|----------|-------|
| Workbench shared secret (EMAIL_SECRET, etc.) | New value (`openssl rand -hex 32`) → Railway env → n8n credential → confirm 200 on test op |
| Postal API key | Postal admin → server → API Keys → revoke old + issue new → Railway env (per tier) |
| Supabase service-role | Supabase Dashboard → Settings → API → rotate; update Railway env immediately (5-min downtime) |
| n8n API key | n8n admin → Settings → API → rotate; update everywhere it lives (`.env`, `.mcp.json`, Railway env on both tiers) |
| ElevenLabs API key | ElevenLabs dashboard → API → rotate; update wherever (scripts, knowledge upload) |
| User password (Supabase Auth) | Service-role: `PATCH /auth/v1/admin/users/{id} {"password":"…"}` |

## Where these credentials are referenced in code

| Cred | Code reference |
|------|---------------|
| `EMAIL_SECRET` | `server/src/middleware/shared-secret.ts` factory call in `routes/email.ts` |
| `INGESTION_SECRET` | same, in `routes/ingestion.ts` |
| `APPROVAL_SECRET` | same, in `routes/approvals.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | `server/src/services/supabase-admin.ts` |
| `POSTAL_API_KEY` | `server/src/lib/email.ts` |
| `N8N_API_KEY` | manual scripts in `scripts/` (REST API calls) |
| `ELEVENLABS_API_KEY` | `scripts/` for agent admin + KB upload |

## Common gotchas

- **`.mcp.json` is gitignored** — secrets in it (n8n API key) don't propagate via clone. Each contributor must set their own.
- **Service-role key in client bundle is a critical leak.** Never reference `SUPABASE_SERVICE_ROLE_KEY` from anything `VITE_*`-prefixed.
- **n8n credential id changes** when re-imported (n8n generates new ids). Don't hardcode credential ids in script logic — read from a config map.
- **Anthropic key is shared across all tiers** (single account). Spending tracked at the account level; can't isolate DEV vs PROD costs without separate accounts.
