---
name: Sprints index
description: Catalog of sprint pages — completed, planned, releases, hotfixes.
type: index
last_reviewed: 2026-05-09
---

# Sprints

Two source-of-truth conventions:
- **`gh pr list --state all`** is reality.
- `writers-workbench/sprint_document.md` and `sprint_document_v2.md` are planning artifacts. They drift; PRs/commits don't.

## Pages

- [[completed-sprints]] — Sprint 0-7, 8, 10.a, 10.b, 11, 12 — all DEV-complete + most PROD-released.
- [[newsletter-cluster]] — PRs #69, #70, #72, #73, #74, #75 — DEV-only.
- [[sprint-8-rbac]] — RBAC + tiers + credits + impersonation deep dive.
- [[sprint-10a-tier-separation]] — V1/DEV/PROD tier separation rollout.
- [[sprint-10b-bullmq]] — Redis + BullMQ + per-user concurrency + SSE pub/sub.
- [[sprint-11-postal]] — Postal email migration (Gmail → /api/email/send).
- [[sprint-12-chapter-tools]] — rewrite-with-research + drift scanner + annotations.
- [[work-ordering-2026-05]] — **CURRENT ORDER** as of 2026-05-25. Five hard gates: newsletter PROD ship → Sprint 15 → Sprints 16-22 → Sprints 23-27 → Sprint 9 last. Overrides the older 9→13→14→15→16→18 sequencing.
- [[planned-sprints]] — Sprint 9 (Stripe), 13/14/15, 16/17/18 (chapter writer architecture). Story-list authoritative; sequencing now in [[work-ordering-2026-05]].
- [[design-feasibility]] — chapter-writer multi-instance feasibility evaluation (2026-05-09). Token budget is the bottleneck; refines Sprint 16-18 stories.
- [[sprint-15-testbed]] — Sprint 15 testbed buildout + benchmarking (60 pts / 4 phases). Replaces abstract "Load test + monitoring". Empirical answers for LLM strategy + collapse points before Sprint 16-18.
- [[microservice-alternative]] — (SUPERSEDED) chapter-writer-only Python microservice proposal. Now subsumed by full-backend rewrite.
- [[python-migration-roadmap]] — full Python backend rewrite + B2B productization. Sprints 16-26. See [[architecture/python-backend/_index]] for design pages.
- [[engine-framework-sprints]] — **CURRENT — task breakdown**: F0 foundation (done) + F1-A/F1-B write-workshop (queue, no new Docker images) + F2 newsletter (in flight) per-step services. Operationalizes [[engine-framework]] + [[newsletter-microservices]].
- [[chapter-optimization-sprint]] — **F2.5** chapter algorithm optimization (~25 pts, ~2-3 weeks). Lands between F2 and F1-B: pass-merging, streaming continuity, tier-down models, two-pass draft/edit, speculative decoding. Gated on Sprint-15 quality rubric + F1-A clean Python baseline. No new Docker images.
- [[releases-and-tags]] — v1.0.0 (2026-04-17), v1.1.0 (2026-04-28), v1.1.1, v1.1.2.
- [[hotfixes]] — story-bible extraction (2026-04-29), auth Site URL, admin-create user, etc.
