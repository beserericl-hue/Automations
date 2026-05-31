---
name: Architecture index
description: Catalog of architecture pages — system shape, data flow, code relationships, deployment.
type: index
last_reviewed: 2026-05-09
---

# Architecture

## Current system

- [[system-overview]] — full system diagram + components.
- [[tier-separation]] — V1 / DEV / PROD model. The most-referenced rule in this codebase.
- [[data-flow]] — how a request traverses surfaces → server → queue → n8n → DB → callback.
- [[code-relationships]] — module dependency graph (frontend + backend).
- [[frontend-stack]] — React + Vite + TipTap details.
- [[backend-stack]] — Express + BullMQ + Postal details.
- [[deployment-railway]] — Railway services, env vars, build pipeline.
- [[security-model]] — Auth, RLS, JWT, RBAC, impersonation, secrets.

## Future direction — Python backend rewrite

- [[python-backend/_index|Python backend (Author Agent API)]] — architectural rewrite from n8n workflow tree to Python services. Internal use + B2B productization. Multi-sprint program (Sprints 16-26) per [[python-migration-roadmap]].
  - [[python-backend/master-plan]] — the architectural decision + service-group deployment model.
  - [[python-backend/service-decomposition]] — every n8n workflow → Python module mapping.
  - [[python-backend/api-contracts]] — full HTTP endpoint spec.
  - [[python-backend/productization]] — B2B platform layer.
  - [[python-backend/multi-tenancy]] — tenant isolation model.
  - [[python-backend/observability-deployment]] — ops model.
