# CR-008 — Reconcile the Writer's Workbench UI with the engine (Path B)

| | |
|---|---|
| **Status** | Proposed (spec only — implement next) |
| **Opened** | 2026-06-07 |
| **Tier** | DEV first; PROD at go-live |
| **Goal** | Make the UI work correctly against the engine's data model. The UI was built for the n8n era; the engine (CR-001/005/006/007 + Path B hub) added tables, fields, and a new request path the UI doesn't yet handle — producing crashes (e.g. "Failed to load project: Cannot coerce the result to a single JSON object") and stale/inconsistent views. |

## Trigger / observed failure

Opening `writersworkbench-develop…/projects/1cc6a24a-352c-47f1-a018-c97cf379007d` shows
**"Failed to load project: Cannot coerce the result to a single JSON object."**

Root cause: `1cc6a24a` is the **stub "The Burial Mound"** that was **hard-deleted** during the engine
test (the real project is `62cc734f`). `ProjectDetail.tsx:65` loads via
`supabase.from('writing_projects_v2').select('*').eq('id',id).eq('user_id',userId).is('deleted_at',null).single()`.
`.single()` raises that PostgREST error on **0 rows**, and there is no not-found state — so a
missing/stale project id crashes the page instead of degrading. This is one instance of a class of
UI↔engine drift.

## Scope — three workstreams

### A. Resilience & data-integrity (fixes the crash + the class)

1. **Project load must not crash on missing rows.** Replace `.single()` with `.maybeSingle()` in
   `ProjectDetail.tsx` and render a "Project not found or was removed" empty state with a link back to
   All Projects. Audit ALL `.single()` calls in `client/src` for the same pattern.
2. **Stale references to deleted projects.** The nav/bookmark/history can point at a removed project.
   After load-failure, clear the stale selection and don't leave a dead breadcrumb. Verify the
   project-list query (left nav "My Projects") only lists live projects and that selecting one routes
   to a valid id.
3. **Hard-delete vs soft-delete reconciliation.** The UI assumes soft-delete (`deleted_at`); the
   engine test hard-deleted a project via REST. Decide one model and enforce it: either (a) the
   engine/ops use soft-delete (set `deleted_at`) so the UI's filters work, or (b) the UI tolerates
   hard-deleted/missing rows everywhere (preferred: do both — soft-delete by default + graceful
   missing-row handling). Add a cascade/orphan check so deleting a project can't strand UI references.

### B. Data-model reconciliation (surface what the engine now writes)

The engine added tables/fields the UI should read; verify each is wired and project-scoped:

1. **`chapter_qa_v2` (CR-005)** — per-chapter drift report, `aligned`, craft-QA scores, research-used,
   bible-loaded, word_count, cache tokens. Surface in the chapter/project view (a per-chapter QA panel:
   aligned ✓/✗, QA scores, "research used", "bible entries used"). Newest row per `(project_id,
   chapter_number)` wins.
2. **`research_report_projects_v2` (CR-006)** — the research tab must JOIN this and filter by the open
   project so it shows ONLY this project's research (not every project's). Unlinked reports → a
   general/unassigned bucket. This is the read-path half of CR-006.
3. **`token_usage_v2` (CR-007)** — `CostDashboard.tsx` already reads it; verify it filters by
   `metadata->>project_id` for per-project cost and aggregates per user/day. Wire it to the credit
   model (cost → credits).
4. **Chapter `metadata`** — chapters now carry `drift_report` + `craft_qa` in
   `published_content_v2.metadata`; the chapter view should show these (or read `chapter_qa_v2`).
5. **Story bible tab** — the bible is polluted (~1000 entries, dup/variant characters; see CR-005/006
   findings). The UI tab shows junk. Depends on the bible-cleanup follow-up (dedupe to the canonical
   cast); until then, the tab should at least group/dedupe by canonical name for display.

### C. Path B hub cutover (front-end) — the larger piece

Today chat/brainstorm/write still POST to the n8n hub. To run on the engine:

1. Point the server `resolveWebhookUrl()` (chat/brainstorm/content-actions/images) at the **engine hub**
   `/internal/hub` behind a `HUB_BACKEND=n8n|engine` flag (service-secret on the server, never the
   browser).
2. **Job + SSE bridge** — the engine returns its own arq `job_id`; bridge it to the server's BullMQ
   `jobId`/SSE so the drawer streams; add `/api/jobs/:id` → engine `/write/jobs/{id}`.
3. Thread `user_id` (V2 phone-number id) on every engine call so persistence + RLS land under the
   right account.
4. New UI affordances the engine enables: chapter **plan** view, **drift/QA** panel, **Repair** button
   (the `repair` op), **Revise-outline** directive box, **Series Bible** panel, newsletter approval
   gates.

## Acceptance

- No project URL (including deleted/stale ids) crashes the app; missing → clean not-found state.
- Each project's Reference/Research tab shows only that project's research; QA + cost panels show the
  engine's `chapter_qa_v2` / `token_usage_v2` data scoped to the project.
- With `HUB_BACKEND=engine`, a chat "write chapter N" round-trips through the engine hub, streams
  progress, persists, and renders from the DB — with no other UI change.
- DEV validated end-to-end before any PROD flip (CLAUDE.md baseline protection).

## Notes / dependencies

- Bible DB cleanup (dedupe ~1000 → canonical cast) is a prerequisite for a clean story-bible tab —
  tracked as a CR-005/006 follow-up.
- Exact tokens-per-credit (10 credits/chapter) needs one measured chapter **write** under CR-007
  (TOKENS.md) to finalize the cost→credit mapping the UI shows.
