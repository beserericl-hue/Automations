---
name: Operations index
description: Catalog of operations pages — governance, promotion, hotfix flow, env vars, credentials, runbooks.
type: index
last_reviewed: 2026-05-09
---

# Operations

- [[governance]] — CLAUDE.md tier rules, schema governance, branch protection, what's enforced where.
- [[promotion-dev-to-prod]] — release-day DEV→PROD workflow + DB migration sequence.
- [[newsletter-prod-ship-runbook]] — **CURRENT** concrete steps to ship the newsletter cluster to PROD (the 4 workflows have no PROD copies → must be created, not updated). Includes the unset `N8N_NEWSLETTER_WEBHOOK_URL` fix + PROD Redis prerequisite.
- [[hotfix-flow]] — direct-to-PROD fix + mirror to DEV pattern.
- [[env-vars-by-tier]] — full per-tier env var reference + which ones are tier-sensitive.
- [[credentials-map]] — n8n credentials, secret values (locations, not values), API keys.
- [[runbooks]] — common operational tasks (backfill story bible, add genre, debug Cloudflare 524, etc.).
