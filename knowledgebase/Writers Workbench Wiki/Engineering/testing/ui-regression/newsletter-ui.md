---
name: Newsletter UI regression
description: All /newsletter/* routes — home, generate, execution, approvals, sends, ingestion, templates, editions, feeds, setup wizard.
type: reference
last_reviewed: 2026-07-02
---

# Newsletter UI — `/newsletter/*`

Spec: `writers-workbench/e2e/regression/newsletter.spec.ts`. Render of every newsletter route is also in
`nav-render.spec.ts`. Shared `HelpButton` (`button[title^="Help:"]`) → slide-over dialog with
`aria-label="Close help"` + a `Close` button.

## Routes + key controls

| Route | Component | Key interactive elements (expected result) |
|---|---|---|
| `/newsletter` | NewsletterHome | "Generate newsletter →" link; Resume/Review/View tiles; recent-runs rows (`tr[role=button]`) |
| `/newsletter/generate` | NewsletterGenerate | `#edition`, `#template`, `#send-date` (required), `#previous-content`; **Preview template** (modal), **Generate newsletter →** (submit) |
| `/newsletter/execution/:id` | ExecutionStatus | StageStrip, LiveLog, ApprovalResolveForm, "Open in n8n →" |
| `/newsletter/approvals` | PendingApprovals | rows `tr[role=button]` → `/approvals/:token`; per-row "Review →" |
| `/newsletter/approvals/:token` | ApprovalDetail | ApprovalPayload{Stories/Image/Subject}; ApprovalResolveForm (Approve/Revise radios, Feedback, submit) |
| `/newsletter/sends` | ScheduledSends | Status + Edition filters; per-row subject link |
| `/newsletter/sends/:id` | NewsletterDetail | HTML iframe; "Markdown source" toggle; Execution link |
| `/newsletter/ingestion` | IngestionBrowser | days sidebar, date input, per-row View → drawer (markdown/html tabs) |
| `/newsletter/templates` | TemplatesList | "New template"; Edition filter; "Show inactive"; per-row Edit/Delete (guarded) |
| `/newsletter/templates/new`+`/:id` | TemplateEditor | Import HTML, Render preview, **Save**; `textarea[aria-label="Template HTML source"]`; Sample-data JSON |
| `/newsletter/editions` | EditionsList | "New newsletter" link; "Show disabled"; per-row Feeds/Edit/Disable/Re-enable |
| `/newsletter/editions/new`+`/:id` | EditionEditor | Display-name*/Slug*/Newsletter-name*/Subheader*/Genre*, colors, signature, Cadence + Send-time; LogoUploader (edit only); SubscribersPanel (import CSV, add, activate/unsub/remove) |
| `/newsletter/editions/:id/feeds` | FeedsList | Add feed / Edit / Pause/Resume / Delete; FeedEditor (Name/Type/URL/interval/active) |
| `/newsletter/editions/:id/setup` | EditionSetupWizard | 3 steps: Copy feeds from genre → Template → Subscriber → Done ("Generate now →") |

## Tests

- Editions list: "New newsletter" link + "Show disabled" toggle.
- Edition editor (new): core fields + Create button + cadence select.
- Generate form: send-date input + submit present.
- Template editor: `Template HTML source` textarea + Save.
- HelpButton open/close.
- Approvals + Sends read views render.

## FINDINGS (real dead controls / bugs)

- **Generate template-override is a dead control** — `#template` value is never sent to
  `/api/newsletter/generate` (only edition_id/send_date/previous_content). Choosing a template has no effect.
- **Setup → Generate `?edition=` is ignored** — NewsletterGenerate defaults to `editions[0]`; the wizard's
  chosen edition isn't preselected. Same class: `EditionSetupWizard` passes `userName={null}` so the
  subscriber name never prefills.
- **HelpButton footer doc link** points at `/docs/newsletter-user-guide.html` (repo file is `.md`) — likely 404.
- **ExecutionStatus `handleResolved(decision)` arity mismatch** — drops the `resumed` flag from
  `ApprovalResolveForm.onResolved(decision, resumed)`; a failed n8n resume isn't surfaced on that page.
- **PendingApprovals edition badge is hardcoded** to the fallback (ai-news/first) for every row; `image`
  stage isn't handled in the excerpt/pill.
- **EditionsList "Show disabled"/"Re-enable"** depend on the server honoring `include_disabled=1`; if it
  doesn't, disabled editions never appear and Re-enable is unreachable. Verify server support.
- TemplateEditor create-mode preview is disabled until first save (expected); "debounced preview" comment
  is stale (no debounce).
