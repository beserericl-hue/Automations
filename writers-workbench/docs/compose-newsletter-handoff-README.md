# Writers Workbench — Compose Newsletter Handoff

This folder mirrors the repo path `writers-workbench/docs/` at `beserericl-hue/Automations@develop`. Drop the whole `handoff/writers-workbench/docs/` contents into your local checkout at `writers-workbench/docs/` and the paths will resolve correctly.

## Contents

| File | For |
|---|---|
| `compose-newsletter-design.md` | **Fully-integrated workflow spec** covering Phases 2a/2b/2c. SSE event vocabulary, backend contracts, DB changes, n8n workflow deltas (9 emit nodes), preview CSP. Feed to Claude Code first. |
| `compose-newsletter-sprint.md` | **Phase 2a sprint only**, written in the same workflow-ids registry style as `newsletter-migration-workflow-ids.md`. 10 stories / 31 points, verification tables per story, credential registry, dependency graph, merge order. Claude Code works off this. |
| `newsletter-agent-workflow.md` | Existing overview of the `Content - Newsletter Agent V2` n8n workflow. Referenced by the design doc. |
| `newsletter-migration-workflow-ids.md` | Existing registry of workflow + credential IDs from the prior migration sprint. The 2a sprint appends new IDs to this file (S10 in the sprint). |
| `samples/compose-newsletter-sample.html` | Visual target for the **ExecutionStatus** page. Stage strip shows all 9 stages (updated to match spec §4.1). |
| `samples/compose-newsletter-sample-preview.png` | Screenshot of the above for quick visual reference. |
| `samples/the-workbench-newsletter-sample.html` | Visual target for the **rendered newsletter** emitted by the workflow. |
| `index.html` | Local landing page linking all of the above. Open this first. |

## Suggested Claude Code prompt

```
Read writers-workbench/docs/compose-newsletter-design.md end-to-end,
then read writers-workbench/docs/compose-newsletter-sprint.md. The
sprint is scoped to Phase 2a only; do not implement 2b/2c work.

Start with S1 (Supabase migration 012). Work stories in the order
given by the dependency graph in the sprint doc. After each story,
fill in the verification table at the bottom of that story's section.

Match the visual target in
writers-workbench/docs/samples/compose-newsletter-sample.html for
the ExecutionStatus page (story S7). Do not deviate on the 9-stage
strip, the two-column layout, or the inline approval-resolve panel.

Rendered newsletter target:
writers-workbench/docs/samples/the-workbench-newsletter-sample.html —
preserve masthead: wordmark "The Workbench", subheader "Dispatches
from the Machine Room", footer "A CourseworxAI Weekly".

Every DB and n8n write lands on DEV only. Do not touch PROD
credentials. Capture the new n8n credential ID in
writers-workbench/docs/newsletter-migration-workflow-ids.md under a
new "Compose Newsletter 2a — additions" section (S10).
```

## Naming decisions locked in this handoff

- **Product name:** The Workbench
- **First edition slug:** `ai-news`
- **Subheader (AI edition):** *Dispatches from the Machine Room*
- **Footer / banner:** A CourseworxAI Weekly
- Future editions are data rows (see design doc §2.1, table of genres).

## Assets referenced

The sample newsletter references `assets/logos/courseworx-stamp-black.png` relative to the sample file. In the real app, the server-side Handlebars template should render it as a public `/static/logos/...` URL instead of a relative path.

## Env additions introduced by Phase 2a

Set on Railway DEV before starting S2:

- `NEWSLETTER_CALLBACK_SECRET` — 32-byte hex
- `N8N_UI_URL` — `https://n8n.agileadautomation.com`
- `N8N_NEWSLETTER_FORM_URL` — captured from the form-trigger node after S3 adds the `Edition Id` field

Full list in sprint doc → _Environment + credential prerequisites_.
