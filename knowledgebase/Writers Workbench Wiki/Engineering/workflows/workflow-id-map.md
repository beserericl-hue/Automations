---
name: Workflow ID map
description: Authoritative PROD ↔ DEV n8n workflow id table with the live names (checked 2026-11-03). Source of truth for promotion + cross-tier ref-rewriting.
type: reference
tags: [workflows, n8n, ids, reference]
last_reviewed: 2026-11-03
---

# Workflow ID map

Source of truth: [`scripts/workflow-id-map.json`](../../../../scripts/workflow-id-map.json) (generated 2026-04-20T20:50:08Z by `scripts/clone-prod-to-dev.py`). The JSON holds **ids only**; `scripts/promote-dev-to-prod.py` takes each workflow's name from live PROD, never from this page.

**Correction 2026-11-03.** The labels on this page were wrong for 15 of the 24 rows (inventory **D3**:
e.g. `TVNfTVwOrCAnWBo7` was labelled "Tool - QA Chapter" and is "Sub - Manage Research Reports"). The
JSON itself was right: a read-only check of live n8n found every PROD id paired with the DEV workflow of
the same name. The table below is the live names.

**DEV is off.** All 24 DEV workflows are inactive (the DEV Workbench runs on the engine since the E1
switch-off, 2026-10-17). All 24 PROD workflows are active.

## Core 24 (Sprint 10.a clone set) — names as in live n8n, 2026-11-03

| PROD id | DEV id | Workflow (`PROD - …` / `DEV - …`) |
|---------|--------|-----------------------------------|
| `roMDypuMXHv6ugaZ` | `FLA6xIDEvejihQLP` | The Author Agent (HUB) |
| `0c4ZDWNScdmcOtr1` | `idUcNunGWJX0h5Xu` | Tool - Brainstorm Chapter |
| `RbKpigBMgbRG8EZn` | `G91K85MhwA7Ws9Xh` | Tool - Brainstorm Story |
| `GzCpOrWwXHYkEAeX` | `PRk9abQLls91rLyQ` | Tool - Edit Outline |
| `NBNlHQ8kAy7nX8LO` | `SXKJ3jn4oLUWwAn4` | Tool - Email Research Report |
| `WEzf89RwAbkBxmQZ` | `wiOuQprPM0GNZE5V` | Tool - Format Kindle Book |
| `iWIcj915TYJQkdmC` | `0sQWPO5fsxnXyiWR` | Tool - Generate Cover Art |
| `t8xslqa3PWOFMAIM` | `Z3M57QWR8FCU3Omb` | Tool - QA Chapter |
| `6cF3os8cvTT6Ie1d` | `XDZdLA2SxvJJtBnW` | Tool - Repurpose to Social Posts |
| `G31zGaaG2vaTS1rw` | `tb4pvwzdHmnBXuPO` | Tool - Write Blog Post |
| `CQdwL0Wo1ZmelyXF` | `BH4hSN4KPmY0ZGgX` | Tool - Write Chapter (entrypoint that calls the Worker) |
| `wdRZw4bjqPMOYd64` | `oy8nhCED3njbCep4` | Tool - Write Newsletter |
| `x7bJLdHw2Hd8Gyer` | `7DDQM65ZVJ2MqmL2` | Tool - Write Short Story |
| `VxO2eG6uvImqaPA2` | `fsKRGkzphWT62rja` | Worker - Write Chapter |
| `DTjjVk51Z9aHgAg0` | `5P1kRrw4XoO0ROw5` | Sub - Embed Project Data |
| `Q0K3aQrBMhw48lCB` | `aNRBW0djYtpCwXRW` | Sub - Eve Knowledge Callback |
| `QJFwA21FgfRmrSap` | `uZ4X1OApVdAVwY2R` | Sub - Manage Library |
| `TVNfTVwOrCAnWBo7` | `7n1Fdy7JEqTyziJx` | Sub - Manage Research Reports |
| `iDCqICsm4OpQNV6C` | `coQixw5vB4AsnxVI` | Sub - Manage Story Bible |
| `2T7rElM5RqCKst51` | `lJ7xdTditKe9H9eH` | Sub - Retrieve Content |
| `dk75OYTASeu6NkTr` | `jsrbagwhV7rk3HZv` | Sub - Token Usage Tracker (PROD copy still has the old n8n API key typed into an HTTP header) |
| `Z18KOsqW17VQgt8i` | `rI1UIx7Zjqh04dS0` | 17 Cron: Scheduled Publisher |
| `Ugc2BonNNMCoeXP0` | `WxNETmq1GbjCSTuL` | Data: AI Scraping Pipeline |
| `z9E2vmG8sZux4aNH` | `rHnqFwnvr7T72fSE` | Data: Content Ingestion |

Not in the clone set: the old labels named "Tool - Reset Eve Greeting", "Sub - Approval Token
Generator", "Content - Newsletter Agent" and a top-level "Tool - Manage Library" — none of those is one
of these 24 ids.

## Sprint 12 additions (DEV ids)

| Workflow | DEV id | PROD id | Notes |
|----------|--------|---------|-------|
| `DEV - Sub - Build Chapter Context` | `jJe84zB3U1HA9xVv` | (mirrored to PROD) | LOCKED CHARACTER ROSTER context |
| `DEV - Tool - Rewrite Chapter with Research` | `O8EWqLrqxcTJiWGN` | (PROD id TBD — promoted) | citations toggle |
| `DEV - Sub - Research Pipeline` | `ACgIg1WPkIipiy5o` | (mirrored) | Perplexity + Claude derivation |
| `DEV - Tool - Evaluate Genre Compliance` | `e9LEpCM5L7zVpQxl` | (mirrored) | computed-before validator |
| `DEV - Tool - Scan Character Drift` | `fJWDHXhle345f6jY` | (mirrored) | deterministic regex v4 |
| `DEV - Sub - Backfill Story Bible (one-shot)` | `hXkfrkuiWbJtJlEl` | (none — manual backfill on PROD) | DEV one-shot driver |

All six are inactive on DEV (2026-11-03).

## Newsletter cluster (DEV) — states 2026-11-03

| Workflow | id | Active | Notes |
|----------|----|--------|-------|
| `Node - Scrape Url V2` | `BJaUNEt6PPIqbWLa` | yes | replaced broken `glJfsY6KaO0aoX0A` |
| `[OLD] Node - Scrape Url` | `glJfsY6KaO0aoX0A` | no | retired |
| `Content - Newsletter Agent V2` | `bMvMKyK8obwYZmNb` | no | the engine newsletter saga replaced it on DEV |
| `DEV - Newsletter Ingestion (Multi-User Cron)` | `JAQ8rmCaDoddqt2k` | no | replaced by engine ingestion (E1) |
| `DEV - Newsletter Cadence Cron` | `7l1z4uMS9kdkYIT4` | no | replaced by the engine scheduler (E10) |
| `AI News Data Ingestion V2` | `2T3TwGHhdGQlTpQ5` | no | broken since 2026-09-24 (J6), deactivated with E1 |
| `AI News Data Ingestion Orig` | `53SlwZMS21gpvz3H` | no | legacy single-trigger |

PROD has no newsletter cluster: PROD newsletters move to the engine at the cutover
(`writers-workbench/docs/prod-release-checklist.md`), not through n8n promotion.

## Parallel content system (not Workbench; still live)

| Workflow | id | Active |
|----------|----|--------|
| `Cron - Post Scheduled Website Blogs` | `Se2X0fmkLUFK6CCq` | yes |
| `Content - Trend Radar (Workflow A)` | `q1yDjiztjdGRDblT` | yes |
| `Dev Radar - Weekly AI+Dev Slate (ingestion)` | `czBKvhON08FzFydK` | yes |

The engine's post calendar replaces these; deactivate them before `SOCIAL_POSTING_MODE=live` or every
post goes out twice. See [[parallel-content-system-separation]].

## V1 frozen workflow IDs

| V1 workflow | ID | Notes |
|-------------|----|----|
| Hub | `RcHfwiB7uM2vFfJ3` | `/webhook/author_request` |
| Content Ingestion | `iLuMoCq0tNJJAH5n` | |
| AI Scraping Pipeline | `ZhVhnuJkIbQrhhNr` | |
| Write Blog Post | `iMBIWzO2PjsLNH9w` | |
| Write Newsletter | `cjIUEjrqvyGZyKwN` | |
| Generate Cover Art | `SxeLHxzvITEKyKc0` | |
| Repurpose Social | `95z13RGuzJDHVNSw` | |
| Email Research Report | `QAbYfOOd05lyesva` | |
| Manage Story Bible | `9cvuhBS412AQRJxf` | |
| Write Short Story | `LTZ63B2H0w8Sl4FW` | |
| Write Chapter | `tpj55Sf66jrBPNT8` | |
| Manage Research Reports | `MLjncwcdMSjBkS4Z` | |
| Brainstorm Story | `StwejB5GLFE26hmU` | |
| Manage Library | `1JERh5yJ3yDJka8s` | |
| Retrieve Content | `DQS2zIhVjyuxabcb` | |
| Eve Knowledge Callback | `PaFJlsxWq4BKt0iq` | |
| Edit Outline | `KfUTQZ7p1ZcDriDR` | (added after V1 release) |
| Cron Scheduled Publisher | `AtMuc7ZsL28LfU1b` | |
| Reset Eve Greeting | `g59QidpmVzQUjQNj` | |

DO NOT modify any of the above. They underpin the V1 baseline Eve agent.

## How to fetch latest IDs

The n8n key is in Railway (`N8N_API_KEY` on DEV `WritersWorkbench`), not in the repo; `.mcp.json` is no
longer tracked (PR #220). Read-only:

```bash
railway run -s WritersWorkbench -e develop -- sh -c \
  'curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" "${N8N_API_URL%/api/v1}/api/v1/workflows?limit=250"' \
  | jq '.data[] | {id, name, active}'
```

## Maintenance

When a new DEV workflow is created:
1. Run `scripts/clone-prod-to-dev.py` (idempotent — fills in missing entries).
2. Or manually add to `scripts/workflow-id-map.json` if it's a one-off (e.g. backfill workflow).
3. Update this page with the **live** name (copy it from n8n, do not guess it) and
   [[promotion-dev-to-prod]] if the workflow should be promoted at release.
