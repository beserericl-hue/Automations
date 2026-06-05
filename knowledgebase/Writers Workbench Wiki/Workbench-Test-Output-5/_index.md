# Workbench Test Output 5 — CR-001: engine writes to the database (top-down Burial Mound)

**DEV tier · 2026-06-05 · project_id `62cc734f-c861-4210-bc12-e9ea002fcf66` · readable in writersworkbench-develop.up.railway.app**

This run proves **CR-001**: the engine now persists everything it generates into DEV Supabase
(`gvbvwcnmjkdpclcisqrr`) — the SAME database the deployed dev UI reads. Top-down, using the
**correct 96-chapter no-visions revised outline** (not a fresh brainstorm).

## What landed in the database (verified by direct query)
| Table | Result |
|---|---|
| writing_projects_v2 | "The Burial Mound", status=outlined, **outline = 96 chapters** |
| published_content_v2 | **3 chapters** (ch0/1/2), status=draft |
| content_versions_v2 | 6 version snapshots |
| story_bible_v2 | **113 entries** (characters, places, objects, concepts, events) |

Arc: *The Descent: Seven Strata, Seven Centuries, One Family — and the Two-Thousand-Year Answer Carried in Spoken Words*

## Contents
- [outputs/01-outline.md](outputs/01-outline.md) — the 96-ch no-visions revised outline (in the DB)
- [outputs/02-chapter-0.md](outputs/02-chapter-0.md) / [03](outputs/03-chapter-1.md) / [04](outputs/04-chapter-2.md) — the persisted chapters
- [outputs/05-db-and-ui-notes.md](outputs/05-db-and-ui-notes.md) — DB verification + UI change requirements
