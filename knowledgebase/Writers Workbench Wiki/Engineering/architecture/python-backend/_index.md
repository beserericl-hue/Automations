---
name: Python backend index
description: Catalog of pages for the Python backend rewrite. Master plan, service decomposition, API contracts, productization, multi-tenancy, observability, deployment.
type: index
last_reviewed: 2026-05-09
---

# Python backend (Author Agent API)

Architectural rewrite of the n8n workflow tree as a Python backend. The hub stays in n8n as the routing/agent layer; everything else moves. Designed both for **internal use** (Writers Workbench) and **external sale** (B2B platform — other writing apps can call the API).

## Pages

- [[engine-framework]] — **CURRENT program-level architecture (2026-05-29)**: the engine is the product; **true
  per-step microservices** on a shared salable library; newsletter + write-workshop combined; **framework-first ahead
  of Stripe**; scalability to bandwidth goals. Revises the master-plan granularity/positioning decisions.
- [[master-plan]] — original architectural decision + overview (modular-monolith parts superseded by [[engine-framework]]).
- [[service-decomposition]] — every n8n workflow mapped to a Python module. **11 modules** (incl. hub), grouped into 3-4 Docker service groups for deployment.
- [[newsletter-microservices]] — **DESIGN (awaiting approval)** — dedicated deep design for the newsletter as its own Docker image of Python microservices, UI-driven (no emails), replacing the n8n compose workflow. Deepens Module 9 / Sprint 20.
- [[hub-architecture]] — the Python hub. Webhook receiver + agent loop + tool dispatcher. Replaces `PROD - The Author Agent`. **Eliminates n8n from the active path.**
- [[api-contracts]] — full HTTP endpoint spec. Public `/v1/*` (B2B customers) + internal `/internal/*` (hub-to-service).
- [[queueing-architecture]] — Redis-backed queue topology, arq workers, Anthropic token budget gatekeeper, slot management, idempotency, retry/DLQ semantics, leader election.
- [[scaling-architecture]] — visual diagrams of the production topology. Service groups + load balancer + multi-replica scaling + capacity math + multi-region future state.
- [[productization]] — B2B platform layer. API keys, rate limiting, billing, SDKs, customer onboarding.
- [[multi-tenancy]] — tenant isolation. RLS-equivalent for customer data.
- [[observability-deployment]] — logging, metrics, tracing, deploy model, blue-green, rollback.

## Reading order

For a new engineer: [[master-plan]] → [[scaling-architecture]] → [[service-decomposition]] → [[hub-architecture]] → [[api-contracts]].
For a product question: [[master-plan]] → [[productization]].
For an ops question: [[scaling-architecture]] → [[queueing-architecture]] → [[observability-deployment]].
For a security review: [[multi-tenancy]] → [[security-model]] → [[api-contracts]] auth section.

## Related

- [[../python-backend/master-plan|Python backend master plan]] supersedes the chapter-writer-only proposal in [[microservice-alternative]].
- [[python-migration-roadmap]] is the multi-sprint plan to deliver this (Sprints 16-26).
- [[design-feasibility]] established the scaling math; this rewrite operationalizes the answer.
