---
name: Library + Reference regression
description: Content Library, Research, Brainstorm, Outlines, Story Arcs, Genres, Sources, Cost, Credits, Trash, Settings.
type: reference
last_reviewed: 2026-07-02
---

# Library + Reference

Specs: `regression/library.spec.ts`, `regression/reference.spec.ts`, `regression/settings.spec.ts`.
(Render-only routes — Outlines, Sources, Cost, Credits, Trash — are covered by `nav-render.spec.ts`.)

## `/library` — Content Library (`content/ContentLibrary.tsx`)

Rows come from a direct Supabase fetch — specs wait for the table to settle (first row OR empty state)
before row logic.

| Element | Expected | Selector | Test |
|---|---|---|---|
| Type filter | filters + drives `?type=` URL | `getByRole('combobox').nth(0)` | "type filter drives ?type=" |
| Status/Genre/Project filters | client-side filter | `combobox` nth(1/2/3) | "all four filter selects" |
| Clear filters | resets filters+URL (only when a filter set) | `getByRole('button',{name:'Clear filters'})` | — |
| Sort headers (Title/Type/Status/Updated) | toggle asc/desc, show ↑/↓ | `getByRole('columnheader',{name:/Title/})` | "sortable headers" |
| Row cell | navigate `/content/:id` | `tr td` click | "clicking a content row navigates" |
| Bulk bar (on select) | Approve / Publish / Delete / Deselect all | `getByRole('button',{name:'Approve'})` | "bulk-action toolbar" |

FINDING: 5th combobox appears (page-size) once >10 items; filter `<select>`s have no labels (use nth);
rows are `<tr>` without role (click a cell). Pager hidden at ≤10 items.

## `/research` (`research/ResearchList.tsx`, `research/ResearchDetail.tsx`)

Row = `role="button" aria-label="Open research report {topic}"` → `/research/:id`; per-row `Delete`
(soft-delete confirm). Detail: `← Back to Research`, RichTextEditor autosave, `Delete` confirm.
Test opens a report + cancels a delete confirm.

## `/brainstorm` (`brainstorm/BrainstormForm.tsx`)

Step 1: Book Concept textarea + drop zone; **Analyze Content** disabled until ≥10 chars or a file.
Step 2: Title*/chapter-count/Genre*/Story-Arc*/theme chips. Step 3: **Submit Brainstorm** (gated on
title+genre+arc+content). Test asserts Analyze gating. Labels not linked → use placeholders.

## `/story-arcs` (`story-arcs/StoryArcBrowser.tsx` + `StoryArcForm.tsx`)

`+ Create Custom Arc` → StoryArcForm (Name*/Description*/Prompt*/Discovery Q; `Create Arc`/`Cancel`).
Card click expands; custom arcs show `Edit`/`Delete` (**hard delete** confirm). Tests: create form
open/cancel; delete-confirm cancel (**data-gated** — skips when the user owns 0 custom arcs).

## `/genres` (`genres/GenreList.tsx` + `GenreForm.tsx`)

`+ New Genre` → GenreForm (Name*/slug/Description*/keywords/4×ArrayField URLs/Guidelines*/Active).
"Your Genres" (private, editable, always-visible Edit/Delete) vs "Public Genres" (paginated, read-only).
Delete = **hard delete** with cascade-count confirm. Tests: New-Genre form open/cancel; private-genre
delete-confirm cancel (waits for the async list).

## `/settings` (`settings/UserSettings.tsx`)

| Element | Expected | Test |
|---|---|---|
| Theme buttons light/dark/system | flips `<html>` `dark` class | "theme buttons flip the document theme class" |
| Phone / Auth Email | disabled by design | "phone/auth-email … disabled" |
| Save Changes / Update Password | present | "Save Changes and Update Password … present" |
| Delete Account → Permanently Delete | gated behind typing `DELETE` | "Danger Zone … gated by DELETE text" |

## Render-only reference routes

- `/outlines` — cards link to `/projects/:id` (no outline-detail route).
- `/sources` — global `content_index` (NOT user-scoped); type buttons All/RSS/Reddit/Book; `Open` links.
- `/cost` — range buttons 7d/30d/90d/All; read-only analytics.
- `/credits` — buy-credits presets + confirm modal (**Stripe-deferred stub** — grants credits, no charge).
- `/trash` — soft-deleted **projects** only; per-row `Restore` confirm.

## FINDINGS

- `/sources` `SourceFilter` includes a dead `'other'` enum (no button); the query is not user-scoped.
- `/credits` PurchaseSection vanishes entirely if `/api/credits/pricing` fails (no message).
- Story-arc + genre deletes are **permanent** (no trash) — contrast the soft-delete content/research/projects.
- Unlabeled inputs across Brainstorm/Genre/Arc/Settings forms — prefer placeholder/role selectors.
