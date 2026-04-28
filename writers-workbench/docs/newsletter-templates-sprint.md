# Newsletter Templates Sprint

> Side sprint that runs in parallel with — and on top of — the Compose Newsletter
> 2a sprint ([`compose-newsletter-sprint.md`](compose-newsletter-sprint.md)).
> Created 2026-04-28 in response to the Course Worx Media design-system handoff
> ([`Course Worx Media Design System.zip`](../Course%20Worx%20Media%20Design%20System.zip))
> which shipped a sample HTML layout for the rendered newsletter that the AI
> pipeline must populate at send time.

## Why this sprint exists

Today the n8n `Content - Newsletter Agent V2` workflow renders the final
newsletter email by string-concatenating Markdown into a thin HTML wrapper,
hard-coded inside the `combine_markdown_content` Code node. That works, but
two things follow from the 2a design-system handoff:

1. **Editorial control.** The reviewer wants the masthead, sponsor block,
   trending list, pull-quote, and signoff sections to match the Course Worx
   visual identity — Playfair Display + Inter, the `#14288c`/`#fbf8f2` palette,
   dancing-script signature, etc. The current wrapper does none of that.
2. **Per-edition flexibility.** The 2a sprint already established that future
   editions ship as data rows in `newsletter_editions_v2` (S1, migration 012).
   Each edition needs its own template — a "Workbench" template for `ai-news`,
   different mastheads for genre editions later. Hard-coding the wrapper in
   the workflow blocks that.

This sprint introduces user-managed Handlebars templates stored in Supabase,
seeded with the design-system samples from the zip, and a server render
endpoint that the n8n pipeline (or a future client preview) can call.

## Deliverables

| ID | Story | Pts | P |
|---|---|---|---|
| **T1** | Migration 014 — `newsletter_templates_v2` + RLS + indexes + seed | 2 | P0 |
| **T2** | Server: render lib + 6 template endpoints + tests | 3 | P0 |
| **T3** | Client: TemplatesList + TemplateEditor + preview iframe | 5 | P1 |
| **T4** | Wire render endpoint into `Generate` page preview + n8n send-time render | 3 | P1 |

T1 + T2 ship together as the foundation PR. T3 and T4 are follow-ups that
can ship independently.

## Tier rules

DEV-only for the entire sprint. PROD waits for release-day promotion of the
combined 2a + templates work via `scripts/promote-dev-to-prod.py`.

## Story T1 — Migration 014 + seed

**Schema:** new table `newsletter_templates_v2`. Additive only — schema-governance
check passes (no base-table mutations).

```
id                  uuid PK
name                text NOT NULL
description         text
edition_id          text NULL — FK-equivalent to newsletter_editions_v2.id
                                NULL means "available for any edition"
user_id             text NULL — FK to users_v2(user_id) ON DELETE CASCADE
                                NULL = system / public template (admin-curated)
source_type         text CHECK ∈ ('system','user') — provenance label for UI
html                text NOT NULL — Handlebars template source
sample_data         jsonb DEFAULT '{}' — design-time preview data + fallbacks
is_default          boolean DEFAULT false — exactly one per (edition_id) when set
active              boolean DEFAULT true
created_at, updated_at timestamptz
```

Indexes:
- `(edition_id, is_default) WHERE active` — fast "default template for this edition" lookup
- `(user_id, edition_id)` — "my templates for this edition"
- partial UNIQUE `(edition_id) WHERE is_default AND active` — at most one default per edition

RLS (mirrors migration 013's pattern):
- SELECT: `user_id IS NULL OR user_id = caller OR is_admin_v2()`
- INSERT: `user_id = caller AND (user_id IS NOT NULL OR is_admin_v2())`
  (only admin can insert system templates)
- UPDATE/DELETE: `user_id = caller OR is_admin_v2()`

Seed (admin-owned, `user_id IS NULL`):
1. **`The Workbench (default)`** — html sourced from
   `samples/the-workbench-newsletter-sample.html` (the rendered-newsletter
   sample from the zip), parameterised with Handlebars placeholders for
   issue number, date, intro, lead story, sponsor, pull quote, trending
   list, "From the Workbench" section, and signoff.
   `edition_id = 'ai-news'`, `is_default = true`. **This is the template
   readers receive in their email** — once a newsletter is approved and
   generated, the AI-assembled stories are merged into the placeholders
   in this template and the result is what's emailed out.

The other HTML files in the zip (`index.html`, `samples/compose-newsletter-sample.html`)
are the design-system landing page and the in-app ExecutionStatus visual target
respectively — they are not newsletter templates and are not seeded.

## Story T2 — Server render lib + endpoints

**`server/src/lib/newsletter-render.ts`** — pure module.

- `renderTemplate(html: string, data: object): { html: string; warnings: string[] }`
- Compiles the Handlebars source once per call (no need to cache for now —
  sends are infrequent), throws a structured error on compile failure.
- Built-in helpers:
  - `{{#if x}}…{{/if}}`, `{{#each list}}…{{/each}}` — built-in Handlebars
  - `{{{html_safe}}}` — caller responsibility (we explicitly do NOT enable
    Handlebars `noEscape` globally; tripled-stash for trusted blocks only)
  - `{{format_date d "ISO" "MMM D"}}` — small custom helper
  - `{{rank n}}` — pads a number to two digits ("02", "07") to match the
    sample's numbered trending list
- Caller is expected to merge `template.sample_data` into the runtime `data`
  for any unset fields (so a partial AI payload doesn't collapse the layout).

**Endpoints** (all sit on `newsletterRouter` from S2 unless marked):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/newsletter/templates?edition_id=&include_inactive=` | requireAuth | List templates the caller can see (public + own; admin sees all). Filter by edition. |
| `GET` | `/api/newsletter/templates/:id` | requireAuth | Fetch one template incl. full HTML + sample_data. 404 when not visible. |
| `POST` | `/api/newsletter/templates` | requireAuth | Create. `user_id` is forced to caller; admins must explicitly request `source_type:'system'` to omit `user_id`. |
| `PUT` | `/api/newsletter/templates/:id` | requireAuth | Update name/description/edition_id/html/sample_data/is_default/active. Owner OR admin only. |
| `DELETE` | `/api/newsletter/templates/:id` | requireAuth | Owner OR admin only. Refuses when `is_default = true` and `active` — must demote first. |
| `POST` | `/api/newsletter/templates/:id/preview` | requireAuth | Render the template against optional `data` body merged on top of `sample_data`. Returns `{success, html, warnings}`. |

`POST /api/newsletter/templates/:id/preview` is also the contract n8n's
send-time pipeline calls (T4) — passing the assembled-stories payload as
`data`. Response html ends up as `newsletter_sends_v2.html_body`.

## Story T3 — Client UI

- `/newsletter/templates` — list view. Columns: name, edition, default badge,
  source_type pill (`system`/`user`), updated_at, actions (Edit, Preview,
  Delete). New button.
- `/newsletter/templates/:id` — editor. Two columns:
  left = HTML source (Monaco/textarea), middle = sample_data JSON,
  right = live preview iframe rendered via the preview endpoint.
- `/newsletter/templates/new` — create from blank, duplicate existing, or
  paste an HTML import.
- Sidebar: append "Templates" entry under the existing Newsletter section.

T3 is a follow-up PR; the foundation PR (T1 + T2) does not include it.

## Story T4 — Render integration

Two integration points:

1. **Preview** (in-app): `NewsletterGenerate.tsx` (S6) gets a "Preview"
   button that fetches the active default template for the selected edition,
   renders against a small synthesised data payload, and shows the result in
   a sandboxed iframe.
2. **Send-time** (n8n): the existing `combine_markdown_content` Code node in
   the `Content - Newsletter Agent V2` workflow is replaced with an HTTP
   Request node calling `POST /api/newsletter/templates/:id/preview` with the
   final assembled data. The response html is what lands on
   `newsletter_sends_v2.html_body`. Backwards-compatible: if the workflow
   can't reach the endpoint, the existing inline-template fallback runs.

T4 is a follow-up PR.

## Dependency graph

```
T1 ── T2 ── T3
           └── T4
```

T1 must land before T2 (the render lib + endpoints rely on the table). T3
and T4 each depend on T1 + T2 but are independent of one another.

## Verification gates per story

| Gate | T1 | T2 | T3 | T4 |
|---|---|---|---|---|
| Schema governance | ✓ | — | — | — |
| Migration applied to DEV | ✓ | — | — | — |
| Seed visible via psql | ✓ | — | — | — |
| Render lib unit-tests pass | — | ✓ | — | — |
| Endpoint vitests pass | — | ✓ | — | — |
| Live smoke: preview returns valid HTML for the seed | — | ✓ | — | ✓ |
| Client typecheck + suite | — | — | ✓ | ✓ |
| n8n workflow updated + smoke run | — | — | — | ✓ |

## File layout

```
writers-workbench/
├── docs/
│   ├── newsletter-templates-sprint.md          (this file)
│   └── samples/
│       └── the-workbench-newsletter-sample.html (preserved from zip — seed source)
├── migrations/
│   └── 014_newsletter_templates.sql
├── server/src/
│   ├── lib/newsletter-render.ts
│   └── routes/newsletter.ts                   (extended with template endpoints)
└── client/src/
    ├── components/newsletter/
    │   ├── TemplatesList.tsx                   (T3)
    │   └── TemplateEditor.tsx                  (T3)
    └── lib/newsletter/template-helpers.ts
```

## Out of scope

- Visual WYSIWYG editor — T3 ships HTML-source editing only, with a live
  iframe preview. WYSIWYG is a future ask.
- Versioning of templates — out of scope; treat templates as mutable. If a
  user wants version history they duplicate the row before editing.
- Multi-tenant template marketplace — system templates remain admin-curated.
