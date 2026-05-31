---
name: Workflow ID map
description: Authoritative PROD ↔ DEV n8n workflow id table. Source of truth for promotion + cross-tier ref-rewriting.
type: reference
tags: [workflows, n8n, ids, reference]
last_reviewed: 2026-05-09
---

# Workflow ID map

Source of truth: [`scripts/workflow-id-map.json`](../../../../scripts/workflow-id-map.json) (generated 2026-04-20T20:50:08Z by `scripts/clone-prod-to-dev.py`).

## Core 24 (Sprint 10.a clone set)

| PROD id | DEV id | Workflow name (current) |
|---------|--------|------------------------|
| `roMDypuMXHv6ugaZ` | `FLA6xIDEvejihQLP` | `… - The Author Agent` (HUB) |
| `0c4ZDWNScdmcOtr1` | `idUcNunGWJX0h5Xu` | `… - Tool - Brainstorm Chapter` |
| `2T7rElM5RqCKst51` | `lJ7xdTditKe9H9eH` | `… - Sub - Retrieve Content` |
| `6cF3os8cvTT6Ie1d` | `XDZdLA2SxvJJtBnW` | `… - Tool - Repurpose to Social Posts` |
| `CQdwL0Wo1ZmelyXF` | `BH4hSN4KPmY0ZGgX` | `… - Tool - Brainstorm Story` |
| `DTjjVk51Z9aHgAg0` | `5P1kRrw4XoO0ROw5` | `… - Sub - Manage Library` |
| `G31zGaaG2vaTS1rw` | `tb4pvwzdHmnBXuPO` | `… - Tool - Email Research Report` |
| `GzCpOrWwXHYkEAeX` | `PRk9abQLls91rLyQ` | `… - Tool - Edit Outline` |
| `NBNlHQ8kAy7nX8LO` | `SXKJ3jn4oLUWwAn4` | `… - Sub - Manage Story Bible` |
| `Q0K3aQrBMhw48lCB` | `aNRBW0djYtpCwXRW` | `… - Sub - Eve Knowledge Callback` |
| `QJFwA21FgfRmrSap` | `uZ4X1OApVdAVwY2R` | `… - Sub - Manage Research Reports` |
| `RbKpigBMgbRG8EZn` | `G91K85MhwA7Ws9Xh` | `… - Tool - Write Newsletter` |
| `TVNfTVwOrCAnWBo7` | `7n1Fdy7JEqTyziJx` | `… - Tool - QA Chapter` |
| `Ugc2BonNNMCoeXP0` | `WxNETmq1GbjCSTuL` | `… - Tool - Format Kindle Book` |
| `VxO2eG6uvImqaPA2` | `fsKRGkzphWT62rja` | `… - Worker - Write Chapter` |
| `WEzf89RwAbkBxmQZ` | `wiOuQprPM0GNZE5V` | `… - Tool - Write Blog Post` |
| `Z18KOsqW17VQgt8i` | `rI1UIx7Zjqh04dS0` | `… - Cron: Scheduled Publisher` |
| `dk75OYTASeu6NkTr` | `jsrbagwhV7rk3HZv` | `… - Tool - Write Short Story` |
| `iDCqICsm4OpQNV6C` | `coQixw5vB4AsnxVI` | `… - Tool - Write Chapter` (entrypoint that calls Worker) |
| `iWIcj915TYJQkdmC` | `0sQWPO5fsxnXyiWR` | `… - Tool - Generate Cover Art` |
| `t8xslqa3PWOFMAIM` | `Z3M57QWR8FCU3Omb` | `… - Tool - Reset Eve Greeting` |
| `wdRZw4bjqPMOYd64` | `oy8nhCED3njbCep4` | `… - Sub - Approval Token Generator` |
| `x7bJLdHw2Hd8Gyer` | `7DDQM65ZVJ2MqmL2` | `… - Tool - Manage Library` (top-level) |
| `z9E2vmG8sZux4aNH` | `rHnqFwnvr7T72fSE` | `… - Content - Newsletter Agent` |

Names are best-effort match — use the n8n UI for the canonical name.

## Sprint 12 additions (DEV only as of v1.1.1; promoted to PROD via PR #71 etc.)

| Workflow | DEV id | PROD id | Notes |
|----------|--------|---------|-------|
| `… - Sub - Build Chapter Context` | `jJe84zB3U1HA9xVv` | (mirrored to PROD) | LOCKED CHARACTER ROSTER context |
| `… - Tool - Rewrite Chapter with Research` | `O8EWqLrqxcTJiWGN` | `…` (PROD id TBD — promoted) | citations toggle |
| `… - Sub - Research Pipeline` | `ACgIg1WPkIipiy5o` | (mirrored) | Perplexity + Claude derivation |
| `… - Tool - Evaluate Genre Compliance` | `e9LEpCM5L7zVpQxl` | (mirrored) | computed-before validator |
| `… - Tool - Scan Character Drift` | `fJWDHXhle345f6jY` | (mirrored) | deterministic regex v4 |
| `… - Sub - Backfill Story Bible (one-shot)` | `hXkfrkuiWbJtJlEl` | (none — manual backfill on PROD) | DEV one-shot driver |

For the canonical name and current node count of any of these, query n8n REST:
```
curl -H "X-N8N-API-KEY: $N8N_API_KEY" \
  https://n8n.agileadautomation.com/api/v1/workflows/<id>
```

## Newsletter cluster (DEV only)

| Workflow | DEV id | PROD id | Status |
|----------|--------|---------|--------|
| `Node - Scrape Url V2` | `BJaUNEt6PPIqbWLa` | n/a | active; replaces broken `glJfsY6KaO0aoX0A` |
| `[OLD] Node - Scrape Url` | `glJfsY6KaO0aoX0A` | n/a | retired (renamed) |
| `Content - Newsletter Agent V2` | `bMvMKyK8obwYZmNb` | n/a | active (DEV); modified PR #74 to add subscriber fan-out (operator must Publish in UI) |
| `DEV - Newsletter Ingestion (Multi-User Cron)` | `JAQ8rmCaDoddqt2k` | n/a | active; hourly schedule (every 30 min) |
| `DEV - Newsletter Cadence Cron` | `7l1z4uMS9kdkYIT4` | n/a | active; hourly |
| `AI News Data Ingestion Orig` (V1) | `53SlwZMS21gpvz3H` | n/a | still active; legacy single-trigger |
| `AI News Data Ingestion V2` | `2T3TwGHhdGQlTpQ5` | n/a | still active (DEV); legacy 17-trigger predecessor of multi-user cron |

PROD promotion of newsletter cluster: **pending**. Will land at next release after migrations 013/014/016/017 are applied to PROD Supabase.

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

```bash
N8N_API_KEY=$(jq -r '.mcpServers["n8n-mcp"].env.N8N_API_KEY' .mcp.json)
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.agileadautomation.com/api/v1/workflows?limit=250" \
  | jq '.data[] | {id, name, active}' | head -120
```

## Maintenance

When a new DEV workflow is created:
1. Run `scripts/clone-prod-to-dev.py` (idempotent — fills in missing entries).
2. Or manually add to `scripts/workflow-id-map.json` if it's a one-off (e.g. backfill workflow).
3. Update this page and [[promotion-dev-to-prod]] if the workflow should be promoted at release.
