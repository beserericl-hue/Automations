# CR-006 — Link research reports to projects (research tab must be project-scoped)

| | |
|---|---|
| **Status** | In progress (engine + migration done; UI read-path + backfill pending) |
| **Opened** | 2026-06-06 |
| **Tier** | DEV (build + migrate + backfill); PROD at go-live |
| **Goal** | Fix the standing bug where the UI research tab shows **every** project's research mixed together. Each project's research tab must show only that project's research. |

## Root cause

`research_reports_v2` has **no `project_id`** — the engine recorded the owning project only in a
`"[project <uuid>] …"` topic-prefix convention, which the UI can't filter on cleanly. So all research
appears under every project. `research_reports_v2` is a **base table** (CLAUDE.md immutability), so a
`project_id` column cannot be added to it.

## Fix

- **Migration 026** — new meta table `research_report_projects_v2 (report_id FK, project_id FK,
  user_id FK, UNIQUE(report_id))` with RLS. Governance-compliant (new meta table, additive FKs; no
  base-table ALTER). The mapping the UI filters on.
- **Engine** — `persist_helpers.persist_research` now inserts the link row whenever a `project_id` is
  supplied (best-effort; a pre-migration DB won't fail the report write). The chapter step already
  passes `project_id` (CR-005 write-time research), so new research is linked automatically.
- **Backfill** — `scripts/backfill_research_project_links.py` parses the `[project <uuid>]` topic
  prefix of existing reports and inserts links; validates the project still exists; an optional
  `DEFAULT_PROJECT_ID`/`DEFAULT_TOPIC_MATCH` links a known unprefixed report (e.g. "Piscataway Burial
  Practices" → The Burial Mound). Reports with no resolvable project stay **unlinked** (shown in a
  general/unassigned bucket, never under a wrong project).

## UI read-path (follow-on — front-end)

The research tab query must join `research_report_projects_v2` and filter by the open project's id:

```sql
select r.* from research_reports_v2 r
join research_report_projects_v2 l on l.report_id = r.id
where l.project_id = :project_id
```

Reports with no link row are "unassigned" — surface them in a separate general bucket, not per-project.

## Apply order (DEV)

1. Apply migration 026 (Supabase SQL editor — idempotent).
2. Run the backfill: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… DEFAULT_PROJECT_ID=62cc734f-…
   DEFAULT_TOPIC_MATCH=Piscataway python3 scripts/backfill_research_project_links.py`.
3. Update the UI research tab query (front-end).
4. PROD at go-live.
