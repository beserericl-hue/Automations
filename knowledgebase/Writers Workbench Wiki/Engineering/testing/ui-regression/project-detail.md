---
name: ProjectDetail regression
description: /projects/:id — all 9 tabs, per-tab buttons, Edit form, Export dialog, delete-confirm.
type: reference
last_reviewed: 2026-07-02
---

# ProjectDetail — `/projects/:id`

Spec: `writers-workbench/e2e/regression/project-detail.spec.ts`. Component:
`components/projects/ProjectDetail.tsx`. Active tab is URL-driven (`?tab=`). **Tab content renders
outside `<main>`** — assert against the whole page, not `main`.

## Header

| Element | Expected result | Selector | Test |
|---|---|---|---|
| ← Back to Projects | `navigate('/projects')` | `getByRole('button',{name:/Back to Projects/})` | tabs test |
| Edit / Cancel Edit | toggles inline `ProjectEditForm` | `getByRole('button',{name:'Edit'})` | "Edit form opens and cancels" |
| Delete Project | opens danger ConfirmDialog (cascade counts) | `getByRole('button',{name:'Delete Project'})` | "Delete Project … cancels" |

## Tabs (9)

| Tab | Marker asserted | Notable buttons |
|---|---|---|
| Overview | Premise / stat cards / Genre / Themes | Genre expander; **Generate Cover Art** (Outline tab actually); Edit (header) |
| Outline | No outline yet / Book Overview / Expand all | **Generate Cover Art**, Expand/Collapse all, per-chapter **Outline/Re-outline**, **Write/Rewrite** (→ CommandDialog) |
| Chapters | No chapters written yet / QA / Rewrite | title/prev/next links, **Fix Drift** + **Cancel** (when QA aligned=false), **Rewrite**, **Rewrite with research** |
| Story Bible | No story bible entries yet / Characters | read-only (no add/edit here — see [[story-bible-and-images]]) |
| Art | Cover Art / No images yet / All Types | ImageGallery: type + genre filters, thumbnail → `/images/:id` |
| Social | Social Media / No social posts yet | platform filter buttons, Copy-to-clipboard per post |
| Research | No research reports yet / Expand all | Expand/Collapse all, per-report toggle |
| Cost | Cost / Total Cost | CostDashboard (range buttons 7d/30d/90d/All) |
| Export | Choose Page Size / No chapters are approved | **Choose Page Size & Export** → ExportDialog |

Test "every tab renders its content" clicks all 9 and asserts each tab's marker.

## Modals

- **CommandDialog** (Outline/Write): textarea + `Cancel` / send / `Send without notes`; Ctrl+Enter sends.
- **ExportDialog**: Page Size select (17 KDP sizes, default 6x9), `Download .docx`, `Cancel`. Test opens
  it (or asserts the button is correctly disabled with "No chapters are approved/published yet" copy).
- **ProjectEditForm** (inline): Title*/Premise/Themes inputs, Genre/Status/Project-Type selects,
  `Save Changes` (disabled when title blank), `Cancel`. Labels not `htmlFor`-linked → use placeholders.
- **RewriteWithResearchModal** (Chapters tab, `hasQaReport=false` here) — see [[content-detail]].

## FINDINGS

- Queue actions (Cover Art / Outline / Write / Rewrite / Fix Drift) are fire-and-forget — only feedback
  is the label flipping to `Queued…`. Assert the label change, not immediate content change.
- **Generate Cover Art has no cancel** — if the job hangs it reads `Queued — generating…` forever
  (unlike Fix Drift, which has a Cancel).
- Fix Drift + its Cancel render only when `qaByChapter[chNum].aligned === false`, and the QA query is
  enabled only on the Chapters tab — element may be absent until QA resolves. Chapters with
  `chapter_number == null` never show Fix Drift.
- `BibleTab` gets an unused `projectId` prop; the tab is read-only (distinct from `/projects/:id/bible`).
- Tab count suffixes (`Chapters (N)`) appear only after async queries — anchor selectors on the leading
  word (`/^Chapters/`), not an exact name.
