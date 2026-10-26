# Change Requests

Scoped, reviewable change requests for the Writer's Workbench engine + app. One file per CR,
numbered `CR-NNN-<slug>.md`. A CR states the goal, scope (work items), acceptance criteria, and
tier (DEV/PROD). PROD-affecting CRs are gated on the acceptance test + explicit user sign-off.

| CR | Title | Status | Tier |
|----|-------|--------|------|
| [CR-001](CR-001-engine-db-persistence-and-burial-mound-regression.md) | Engine DB persistence parity + top-down Burial Mound regression | Done (verified 2026-10-26: outline/chapter/research/bible/chapter-outline persistence in code; Burial Mound 84/84 via the hub, June) | DEV |
| [CR-002](CR-002-project-canon-anti-drift.md) | Project canon / anti-drift anchoring | Mostly done: roster-from-outline, additive-detail rule + non-finding filter in the drift reviewer. Open: merging name-variant character entries in old bibles (exact duplicates removed 2026-10-26) | DEV |
| [CR-003](CR-003-scaling-rate-limits-load-balancing.md) | Scaling: queue, concurrency, rate-limit coordination, load balancing | In progress | DEV/PROD |
| [CR-004](CR-004-engine-hub-path-b.md) | Engine hub (Path B) — conversational brain in the engine, retire n8n | Sprint A done; demo Eve on the engine (DEV). PROD switch pending | DEV |
| [CR-005](CR-005-generation-telemetry-and-qa-persistence.md) | Generation telemetry & QA persistence (chapter_qa_v2) + operational logging | Done | DEV |
| [CR-006](CR-006-research-project-link.md) | Link research reports to projects (project-scoped research tab) | Engine done; UI in CR-008 | DEV |
| [CR-007](CR-007-token-cost-accounting.md) | Token & cost accounting (token_usage_v2) — billing parity | Engine done; UI in CR-008 | DEV |
| [CR-008](CR-008-ui-engine-reconciliation.md) | Reconcile the Workbench UI with the engine (Path B) | In progress (A+B) | DEV/PROD |
| [CR-009](CR-009-engine-task-emails-and-remaining-parity.md) | Engine task-completion emails + remaining n8n→engine parity | Proposed | DEV/PROD |
| [CR-010](CR-010-engine-parity-completion-ui-wiring-and-multi-engine-scale.md) | Full n8n→engine parity audit (remaining gaps), UI wiring, multi-engine load balancing | In progress: B3 buttons done; C2 per-provider budgets and C3 heavy/light queues in code; C4 health watch + alerts (DEV). Open: C1 replicas behind the LB, HA Redis, autoscaling + fleet metrics | DEV/PROD |
