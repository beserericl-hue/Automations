# Change Requests

Scoped, reviewable change requests for the Writer's Workbench engine + app. One file per CR,
numbered `CR-NNN-<slug>.md`. A CR states the goal, scope (work items), acceptance criteria, and
tier (DEV/PROD). PROD-affecting CRs are gated on the acceptance test + explicit user sign-off.

Statuses checked against `develop` on 2026-11-03. Nothing below is on PROD yet; the release steps are
in [../prod-release-checklist.md](../prod-release-checklist.md).

| CR | Title | Status | Tier |
|----|-------|--------|------|
| [CR-001](CR-001-engine-db-persistence-and-burial-mound-regression.md) | Engine DB persistence parity + top-down Burial Mound regression | Done on DEV (audited 2026-10-26: gaps fixed in #185; top-down script `scripts/cr001_topdown.py`, UI readback spec). Since then: outlines validated on every write (#242), lifecycle actions no longer hit the wrong row on a fuzzy title (#245), chat edit-outline persists (#248) | DEV |
| [CR-002](CR-002-project-canon-anti-drift.md) | Project canon / anti-drift anchoring | Done on DEV: Series Bible entry + chapter-count/synopsis anchor in brainstorm; roster-from-outline, additive-detail rule + non-finding filter in the drift reviewer; name variants resolved at write time (`resolve_character_variant` in `persist_bible`) and 24 old variants merged 2026-10-26 (`scripts/merge_bible_variants.py`, undo file kept); Series Bible panel in the UI (#226). Left: a live run proving the chapter-count anchor holds | DEV |
| [CR-003](CR-003-scaling-rate-limits-load-balancing.md) | Scaling: queue, concurrency, rate-limit coordination, load balancing | In progress | DEV/PROD |
| [CR-004](CR-004-engine-hub-path-b.md) | Engine hub (Path B) — conversational brain in the engine, retire n8n | Sprint A done; demo Eve on the engine (DEV); hub conversation memory (#229). PROD switch pending | DEV |
| [CR-005](CR-005-generation-telemetry-and-qa-persistence.md) | Generation telemetry & QA persistence (chapter_qa_v2) + operational logging | Done on DEV (migration 025; QA badge in the project view). Two deliberate departures from the CR text, listed in its header | DEV |
| [CR-006](CR-006-research-project-link.md) | Link research reports to projects (project-scoped research tab) | Done on DEV: migration 026, engine link insert, project tab filtered by the link, backfill script. Left: the "unassigned" bucket in the Research list | DEV |
| [CR-007](CR-007-token-cost-accounting.md) | Token & cost accounting (token_usage_v2) — billing parity | Done on DEV: every paid provider call writes one labelled, priced row (#237, #253, #258, #259; migrations 044, 046–049), per-operation view on the Cost page. Credit pricing is Eric's decision | DEV |
| [CR-008](CR-008-ui-engine-reconciliation.md) | Reconcile the Workbench UI with the engine (Path B) | In progress (A+B). C4: Revise-outline box and Series Bible panel shipped (#226) | DEV/PROD |
| [CR-009](CR-009-engine-task-emails-and-remaining-parity.md) | Engine task-completion emails + remaining n8n→engine parity | Proposed | DEV/PROD |
| [CR-010](CR-010-engine-parity-completion-ui-wiring-and-multi-engine-scale.md) | Full n8n→engine parity audit (remaining gaps), UI wiring, multi-engine load balancing | Done on DEV: Part A parity incl. story-bible add/update from chat (#229) and ingestion in the engine; B3 buttons (research, images, social posts on content + Promotion); C1 2 gateway + 2 runtime replicas with caller-side spreading, one execution per job across replicas (#236); C2 budgets; C3 queues; C4 HA Redis, health watch, fleet view + autoscaler (2–4). Left: Eve callback live (baseline-protected), PROD cutover with `NEWSLETTER_BACKEND=python` and 4 replicas | DEV/PROD |
