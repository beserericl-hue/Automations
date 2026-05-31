---
name: Editor + content (frontend)
description: ContentDetail, TipTap, auto-save, version history, side panels.
type: concept
tags: [frontend, editor, tiptap, content]
last_reviewed: 2026-05-09
---

# Editor + content

`ContentDetail` is where users edit chapters, blogs, newsletters, short stories. The richest single component in the app.

## Editor stack

[TipTap](https://tiptap.dev) — headless rich-text editor on top of ProseMirror. Selected because:
- Markdown-friendly (we render `marked` HTML and TipTap accepts).
- Headless (full styling control).
- Plugin ecosystem (Link, Placeholder, Mentions if needed later).

Configuration:

```ts
import { Editor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';

const editor = new Editor({
  extensions: [
    StarterKit,
    Link.configure({ openOnClick: false }),
    Placeholder.configure({ placeholder: 'Start writing…' }),
  ],
  content: initialHtml,
  onUpdate: ({editor}) => debouncedSave(editor.getHTML()),
});
```

## Markdown → HTML conversion

Content lands from n8n as **markdown**. TipTap wants **HTML**. `client/src/lib/content-utils.ts` handles:

```ts
function toHtml(content: string): string {
  if (content.includes('<p>') || content.includes('<h1>')) return content;  // already HTML
  // markdown → HTML via marked
  return DOMPurify.sanitize(marked.parse(content));
}
```

DOMPurify added in Sprint 0 (S0-2 security). Strips `<script>`, `onerror`, etc.

After the first save, content is stored as HTML in `published_content_v2.content_text`. Re-loads pass through unchanged.

## Auto-save

Debounced 1500ms after last keystroke. Flow:

```ts
const debouncedSave = debounce(async (html) => {
  const data = {content_text: html};
  if (isImpersonating) {
    await apiFetch(`/api/impersonate/write/content/${id}`, {method:'PATCH', body: JSON.stringify(data)});
  } else {
    await supabase.from('published_content_v2').update(data).eq('id', id);
  }
  toast({type:'success', message:'Saved', autoDismiss: 1000});
}, 1500);
```

`Ctrl+S` / `Cmd+S` keyboard shortcut (Sprint 6) flushes immediately.

## Status workflow

Sprint 0 + 3 + 7. States in `published_content_v2.status`:

```
draft  →  approved  →  published
       ↘            ↘
        rejected      scheduled
```

Per-state UI:

| Status | Visible UI |
|--------|------------|
| `draft` | Approve / Reject / Schedule buttons |
| `approved` | Publish / Unschedule (if scheduled) buttons |
| `published` | Read-only banner; Unpublish (admin) |
| `rejected` | "Restore to draft" button |
| `scheduled` | Schedule date banner; Unschedule button |

Server-mediated for impersonation; direct Supabase update otherwise.

## Schedule

Sprint 3 S3-6. `datetime-local` input → ISO timestamp → `metadata.schedule_date`.

```ts
mutation.mutate({
  status: 'scheduled',
  metadata: { ...currentMetadata, schedule_date: new Date(input).toISOString() }
});
```

`Cron: Scheduled Publisher` workflow (`Z18KOsqW17VQgt8i` PROD, `rI1UIx7Zjqh04dS0` DEV) runs hourly, finds all `status='scheduled'` rows where `metadata.schedule_date <= now()` and flips them to `published`. Sends notification email.

Unschedule: clears `metadata.schedule_date` and reverts `status` to `approved`.

## Cover image (Sprint 4 S4-5)

Banner at top of `ContentDetail` for `content_type='chapter'`:

```tsx
{coverImagePath ? (
  <div className="cover-banner">
    <img src={signedUrl(coverImagePath)} />
    <button onClick={openImagePicker}>Change cover</button>
    <button onClick={() => mutation.mutate({cover_image_path: null})}>Remove</button>
  </div>
) : (
  <button onClick={openImagePicker}>Choose from Gallery</button>
)}
```

`openImagePicker` opens `<ImageGallery onSelect={selected => mutation.mutate({cover_image_path: selected.path})} />` in a modal.

## Side panels

### `ProvenancePanel` (Sprint 5)

Collapsible sources list. Queries `content_usage_v2 JOIN content_index`. Shows:
- Source title + type badge
- Scrape date
- Clickable external link

Used to track which sources Claude consumed for each piece.

### `QAReportPanel` (Sprint 5)

Reads `metadata.qa_report` (set by `qa_chapter` tool). Renders 9 checks:

```
✓ Pacing
⚠ Character consistency  (3 flags — see below)
✓ Plot coherence
✓ Dialogue quality
...
```

Pass count badge + generated timestamp.

### `AnnotationsPanel` (Sprint 12 S12-13)

For chapters only. Two source sections:
- **Drift** (top — usually highest signal)
- **Genre evaluation**

Each annotation row:
- Severity badge (high/medium/low)
- Evidence quote in blockquote
- Suggested replacement in green box
- Apply / Dismiss buttons

`POST /api/content/:id/annotations/apply` performs precise span replacement (no LLM rewrite). Snapshots `content_versions_v2` BEFORE mutating with `change_note: annotation_apply:<source>:<id>`.

`POST /api/content/:id/annotations/dismiss` adds annotation_id to `metadata.dismissed_annotations[]`.

422 stale-anchor: if the target text is no longer in `content_text` (e.g. the user deleted that paragraph), apply returns 422 and surfaces "Re-scan needed" CTA.

## Version history (Sprint 1 S1-5 + Sprint 3)

`outline_versions_v2` and `content_versions_v2` are populated automatically:
- `outline_versions_v2`: Postgres trigger `trg_snapshot_outline` on `writing_projects_v2.outline` change.
- `content_versions_v2`: snapshotted on approve/publish (Sprint 1 manual trigger) AND on `annotation_apply` (Sprint 12 S12-13).

`VersionHistory` component (`outlines/VersionHistory.tsx`) lists/views/compares/restores outline versions. Modes:
- List
- View — full text
- Compare — diff against current
- Restore — replaces current with selected version

## Unsaved changes warning (Sprint 1 S1-7)

`useBlocker` from React Router 6.4+:

```ts
const blocker = useBlocker(({ currentLocation, nextLocation }) =>
  hasUnsavedChanges && currentLocation.pathname !== nextLocation.pathname
);
```

Shows `<ConfirmDialog>` on navigation attempt. Don't combine with `beforeunload` listener — double prompt.

## Common gotchas

- **TipTap state desync** — when external state changes the underlying content (e.g. impersonation switch), TipTap doesn't auto-reload. Use `useEffect` + `editor.commands.setContent(html)` on dependency change.
- **Auto-save during impersonation** — must use `apiFetch` to `/api/impersonate/write/content/:id`. Direct Supabase update bypasses impersonation routing.
- **`marked` is permissive** — without DOMPurify, markdown can contain raw HTML including `<script>`. Always sanitize.
- **`metadata` JSONB** — fields like `schedule_date`, `qa_report`, `dismissed_annotations`, `last_rewrite` all live here. Don't `UPDATE … SET metadata = '{...}'` — that overwrites; merge first.
- **`content_text` not `content`** — common mistake. The column is `content_text`.
- **Annotation apply replaces ALL occurrences** of the target string — `text.split(target).join(replacement)`. Could over-match. Mitigated by content_versions_v2 snapshot before mutation.
