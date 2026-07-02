---
name: ContentDetail regression
description: /content/:id — editor toolbar, lifecycle actions, QA/annotations, version history, rewrite-with-research modal.
type: reference
last_reviewed: 2026-07-02
---

# ContentDetail — `/content/:id`

Spec: `writers-workbench/e2e/regression/content-detail.spec.ts`. Component:
`components/content/ContentDetail.tsx` (+ editor/RichTextEditor, content/VersionHistory,
content/RewriteWithResearchModal, content/QAReportPanel, content/AnnotationsPanel, EngineQaPanel).

## Lifecycle actions (vary by status)

| Status | Buttons | POST `/api/content/:id/lifecycle` action |
|---|---|---|
| draft | Approve, Reject (confirm) | approved / rejected |
| approved | Publish, Back to Draft | published / draft |
| published | Unpublish (confirm) | approved |
| rejected | Back to Draft | draft |
| scheduled | Unschedule (confirm), Publish Now | draft / published |
| any | Delete (danger confirm), Schedule (draft/approved), Rewrite with research (chapter only) | — |

Test "lifecycle actions are present" asserts `Delete` + at least one status action is visible. No commit
is made against shared DEV data — the isolated lifecycle transitions are proven by the engine suite
(R22/R23/R25/R94–R98) with **seeded disposable rows** (see [[engine-chat-e2e-suite]]).

## Editor toolbar (`EditorToolbar.tsx`)

Accessible names are the **glyph** for text buttons and the **title** for icon buttons:
`B`(Bold), `I`(Italic), `S`(Strike), `H1/H2/H3`, `Bullet List`, `Numbered List`, `Blockquote`,
`Horizontal Rule`, `Undo`, `Redo`, `Save`. Auto-saves 2s after edits (snapshots `content_versions_v2`);
Ctrl/Cmd+S also saves. Test asserts the toolbar controls + the contenteditable `textbox` are present.

## Version History (`VersionHistory.tsx`)

`History` button opens the panel (query gated on open). Panel: `Close`, `Compare versions`
(disabled <2 versions), per-version `View` / `Restore`, `← Back to list`, older/newer compare selects.
Test opens + closes the panel.

## Rewrite-with-research modal (`RewriteWithResearchModal.tsx`, chapter only)

Fields: Research focus* (≥10 chars enables submit), Q/A checkbox, Style directives, citation radios
(Auto/Invisible/Inline), `Cancel`, submit `Rewrite with research`. POST
`/api/content/:id/rewrite-with-research`. Test opens → asserts submit disabled → fills focus → asserts
enabled + all 3 radios → cancels. ✅ Now exposes `role="dialog"` + `aria-modal` (fixed 2026-07-02).

## Other panels (chapters)

- **EngineQaPanel** (only if qa/drift present): `Fix drift` (+ `Cancel`) via `useChapterRepair`.
- **QAReportPanel**: `Run Q/A Check` (no report) or `Q/A Consistency Report` toggle + `Re-run`.
- **AnnotationsPanel**: per-annotation `Apply Fix` / `Dismiss`.
- **ProvenancePanel** (all types): `Sources` toggle, per-source external link.
- **Cover image**: `Change Cover` / `Remove` / `Choose from Gallery` → image-picker modal (ImageGallery
  in picker mode).

## FINDINGS

- Two buttons named "Rewrite with research" (header trigger + modal submit) — scope the submit to the
  dialog.
- **Image-picker close "X" has no accessible name** (bare `<button>`+svg) — a11y + selector fragility.
- `statusMutation`'s client-side `updates`/`published_at` block is **dead on the non-impersonation path**
  (the engine computes fields server-side); UI should assert the refetched status, not client-set fields.
- Auto-save + toolbar Save + Ctrl+S all snapshot a version → version count is noisy under rapid saves.
- EngineQaPanel returns null when neither qa nor drift present — plan for conditional presence.
