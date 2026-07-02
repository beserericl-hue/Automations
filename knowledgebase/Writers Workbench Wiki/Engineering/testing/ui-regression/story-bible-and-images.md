---
name: Story Bible + Images regression
description: /projects/:id/bible StoryBiblePanel + EntryForm, /images/:id ImageDetail, ImageGallery.
type: reference
last_reviewed: 2026-07-02
---

# Story Bible + Images

Components: `story-bible/StoryBiblePanel.tsx` + `EntryForm.tsx`, `images/ImageDetail.tsx`,
`images/ImageGallery.tsx`, `shared/ConfirmDialog.tsx`. The Art tab of ProjectDetail hosts ImageGallery
(covered by `project-detail.spec.ts`); the standalone routes below are covered by `nav-render` render +
notes here (they need a project/image id — extend `project-detail.spec.ts` when seeding is added).

## `/projects/:id/bible` StoryBiblePanel

List view: `← Back to {project}`, `+ Add Entry` / `+ Add First Entry` → EntryForm (in-place, not modal);
per-entry `Edit` / `Delete` (danger ConfirmDialog, **soft-delete** `deleted_at`). Entries grouped by 6
types (character/location/event/timeline/plot_thread/world_rule).

**EntryForm**: Entry-Type select (**disabled in edit mode**), Name*/Description* (submit disabled until
both filled), Chapter Introduced (number), metadata key/value rows (+ Add metadata / × Remove),
`Add Entry`/`Update Entry`, `Cancel`.

FINDINGS: labels not `htmlFor`-linked (use placeholders); metadata rows keyed by index (removing a middle
row can mis-associate state); delete has no `onError` (silent failure). The ProjectDetail "Story Bible"
tab is a **different, read-only** component (no add/edit).

## `/images/:id` ImageDetail

`← Back to gallery` (`navigate(-1)`), `Download`, Prompt textarea (prefilled), **Regenerate Image**
(disabled until prompt ≥1 char; 3-step flow generate→poll(≤90s)→save then navigates to the new id),
reference dropzone + hidden file input, remove-reference X (**no accessible name**).

FINDINGS: long polling (≤90s) — mock the `/api/images/*` endpoints in fast tests; auto-nav after success
only if `data.image.id` exists (else dead-end); reference upload/save failures are swallowed silently;
generate/upload/save are NOT impersonation-aware.

## ImageGallery (Art tab + cover picker)

Type filter + Genre filter (Genre only if genres exist); thumbnail cards are `<div onClick>` (not
button/link) → picker mode calls `onSelectImage`, gallery mode navigates `/images/:id`.

FINDING: thumbnails aren't buttons/links (no role, not keyboard-activatable, no per-image test id) —
add `data-image-id` for stable targeting; two unlabeled filter selects.
