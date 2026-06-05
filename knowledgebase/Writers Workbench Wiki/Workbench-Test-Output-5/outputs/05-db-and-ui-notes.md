# DB verification + UI change requirements

## Verified in DEV Supabase (gvbvwcnmjkdpclcisqrr — the DB the deployed dev UI reads)
- writing_projects_v2: "The Burial Mound" with the 96-chapter outline (JSONB)
- published_content_v2: 3 chapters (content_type=chapter, status=draft), idempotent on (project_id, chapter_number)
- content_versions_v2: 6 snapshots (a version per write)
- story_bible_v2: 113 entries

## Root cause of the earlier confusion (resolved)
- NOT a DB mismatch: engine, n8n DEV workflows, and the deployed dev UI ALL use DEV Supabase
  gvbvwcnmjkdpclcisqrr. The `faklx`/PROD URL was only in the local `.env` (a local override; the
  deployed dev UI's bundle reads gvbv, confirmed).
- The chapter persist had a story_bible_v2 `42P10` ON CONFLICT bug that ran in the same try as the
  chapter write, so the chapter SAVED but the call REPORTED persisted:false. Fixed (#135) +
  library.retrieve now filters by project_id (#136) + extract-bible persists (#137).

## UI change requirements (noted)
1. **Chapter titles** are stored generically as "The Burial Mound — Chapter N". The UI will show
   these; should use the outline chapter title (e.g. "Prologue: What the Ground Keeps", "The
   Permit") instead. (Engine `persist_chapter` title — quick follow-up.)
2. **Project content fetch** must query by `project_id` (engine `library.retrieve` now supports it,
   #136). Confirm the UI's project view calls it with project_id (it should already).
3. **Research linkage**: research_reports_v2 has no `project_id` column, so per-project research isn't
   directly linked (the engine prefixes the topic with `[project <id>]`). If the UI shows research
   per project, consider a project_id column (meta table per schema governance) — a small CR.
4. Everything else (outline, chapters, versions, story bible) renders from existing tables the UI
   already reads — no UI change needed to SEE this run.
