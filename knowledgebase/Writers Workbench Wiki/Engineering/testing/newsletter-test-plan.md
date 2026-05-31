---
name: Newsletter test plan
description: 114-test end-to-end manual QA plan covering Multi-User Newsletters + Flow Fixes + Fan-out + Cadence + Bounces + CSV (PRs #69-#75).
type: concept
tags: [testing, newsletter, manual]
last_reviewed: 2026-05-09
---

# Newsletter test plan

> **Successor for the API era:** this 114-test **manual UI** plan is being rewritten as automated **system tests
> against the Python engine API** — see **[[engine-api-system-tests]]** (suite A maps each `T-NN` here to an `S-NN`
> API test). This manual plan stays valid only while the n8n compose path is live; after cutover ([[engine-framework]]
> F3), [[engine-api-system-tests]] is authoritative.

Source: [`writers-workbench/docs/newsletter-test.md`](../../../../writers-workbench/docs/newsletter-test.md). Also `newsletter-test.pdf` (32 pages, weasyprint).

114 tests across 13 sections. **Manual.** Estimated 60-75 minutes.

Run on **DEV** (`https://writersworkbench-develop.up.railway.app`) — that's where the cluster is shipped. PROD has no newsletter UI yet.

## How to read each test

| Field | Meaning |
|-------|---------|
| **ID** | Reference handle (e.g. T-01.3) |
| **Setup** | What state the system needs before you start |
| **Steps** | Exactly what to click / type, in order |
| **Pass** | What you must observe for the test to pass |
| **Fail** | Specific things that mean the test fails |

Mark each test ✅ pass / ❌ fail. Don't skip a fail — make a note and continue.

## Sections

### Section 0 — Pre-flight

- T-00.1 Sign in
- T-00.2 Confirm deploy is current (`/api/health` shows version starting with `273878c` or later)

### Section 1 — My newsletters (Editions list)

- T-01.1 Open My newsletters
- T-01.2 Help drawer opens
- T-01.3 Close help drawer
- T-01.4 **Show disabled toggle** (off → on) — flag of cache issue (hard refresh required after deploy)
- T-01.5 Re-enable button on disabled newsletter
- T-01.6 New newsletter button → EditionEditor

### Section 2 — Edition editor

- T-02.1 Genre dropdown loads (PR #75)
- T-02.2 Logo upload to `newsletter-logos` bucket
- T-02.3 Signoff fields (signature_name, signature_role)
- T-02.4 Cadence dropdown (daily/weekly/monthly)
- T-02.5 Cadence send time field
- T-02.6 Save persists
- T-02.7 Preview shows logo + signoff
- (more)

### Section 3 — Setup wizard (new edition)

- T-03.1 Wizard appears for new edition
- T-03.2 Step 1 "Copy N feeds from <genre>" reads correct count
- T-03.3 Import is idempotent (skip duplicates)

### Section 4 — Feeds list

- T-04.1 Manage feeds button visible from EditionsList
- T-04.2 Add feed
- T-04.3 Remove feed
- T-04.4 Drag-to-reorder

### Section 5 — Subscribers

- T-05.1 Add single subscriber
- T-05.2 CSV import — preview rows
- T-05.3 CSV import — counts (created / updated / skipped)
- T-05.4 Remove subscriber
- T-05.5 Bounce auto-flips status (manual: trigger Postal hard bounce)

### Section 6 — Templates

- T-06.1 Templates list shows 5 defaults
- T-06.2 New template
- T-06.3 Editor preview merges edition data (PR #73)
- T-06.4 Save template

### Section 7 — Generate newsletter

- T-07.1 Pick edition → Generate button
- T-07.2 ExecutionStatus page opens
- T-07.3 Live SSE progress: gathering → drafting → rendering → saving
- T-07.4 Resulting `newsletter_sends_v2` row visible

### Section 8 — Approval flow

- T-08.1 Approval email arrives at recipient_email
- T-08.2 Click approval link → ApprovalDetail loads
- T-08.3 Preview shows rendered HTML
- T-08.4 Approve button → status='approved'
- T-08.5 Cadence cron picks up + fans out

### Section 9 — Send flow (post-PR #74 + post-Publish)

**Critical:** This section requires the operator to have clicked **Publish** in n8n UI on `Content - Newsletter Agent V2` (`bMvMKyK8obwYZmNb`). Without that, the new fan-out nodes don't run and tests in this section fail.

- T-09.1 Approve → fan-out fires
- T-09.2 Subscribers receive email
- T-09.3 From-line shows correct sender_name
- T-09.4 Logo visible in email
- T-09.5 Signoff visible

### Section 10 — Ingestion browser

- T-10.1 Default to most-recent-with-data day (PR #72)
- T-10.2 Days sidebar shows clickable list
- T-10.3 Scanned column shows feed count per day
- T-10.4 Manage feeds shortcut works
- T-10.5 `?date=YYYY-MM-DD` deep-link works

### Section 11 — Cron pipeline

- T-11.1 Multi-user cron runs every 30 min (`JAQ8rmCaDoddqt2k`)
- T-11.2 New articles appear in IngestionBrowser
- T-11.3 `newsletter_ingestion_runs_v2` audit row created
- T-11.4 Cadence cron runs hourly (`7l1z4uMS9kdkYIT4`)
- T-11.5 Cadence cron triggers compose only for due editions

### Section 12 — Bounces

- T-12.1 Postal webhook delivers bounce
- T-12.2 `email_bounces_v2` row inserted
- T-12.3 Subscriber.status flipped to 'bounced'
- T-12.4 AdminPanel "Email Bounces" tab shows row

### Section 13 — Edge cases

- T-13.1 Disabled newsletter doesn't fire
- T-13.2 Re-enabled newsletter resumes cadence
- T-13.3 Empty subscribers list — no email sent
- T-13.4 Empty ingestion items for day — generation skips
- T-13.5 Approval expired — token returns 404
- T-13.6 Idempotent CSV re-upload

## Outstanding operator step (blocking)

After PR #74, operator must:
1. Open https://n8n.agileadautomation.com/workflow/bMvMKyK8obwYZmNb
2. Refresh the workflow tab (Cmd-R)
3. Top-right Published dropdown → click Publish (⌘P)
4. Re-run T-09.* tests.

Until this is done, all of Section 9 fails.

## Browser cache caveat

T-01.4 and similar tests of newly-deployed UI strings can fail due to browser cache. **Hard refresh** (Cmd+Shift+R / Ctrl+Shift+R) before running. Verified via inspecting the deployed `EditionsList-Bopw34eF.js` chunk for the new strings.

## Production user manual

`writers-workbench/docs/PRODUCTION_WEB_UI_USER_MANUAL.pdf` — 56 pages, 6.6 MB, screenshots embedded. Generated 2026-04-29. Does NOT include a Newsletter chapter yet — append `newsletter-user-guide.md` as new chapter and re-run pandoc → weasyprint pipeline.

## Automated counterparts

Selected core flows have automated unit + component tests. See [[unit-tests]]:
- `client/src/test/newsletter-pages.test.tsx`
- `client/src/test/newsletter-approvals-pages.test.tsx`
- `client/src/test/newsletter-templates-pages.test.tsx`
- `client/src/test/newsletter-events.test.tsx`
- `client/src/test/newsletter-execution-status.test.tsx`
- `server/src/test/newsletter*.test.ts` (~5 files)

But the 114-test manual plan exercises the full integrated path including n8n + Postal + SSE — that's what this manual plan is for.

## When to run

- Before merging any newsletter PR with cross-cutting changes.
- Before declaring DEV "ready for promotion to PROD" at release time.
- After any change to `Content - Newsletter Agent V2` workflow (especially after a UI Publish).

## When to update

When PRs add new newsletter features, append new sections + tests. Keep test ID format `T-NN.N`. Don't renumber — `git log -- writers-workbench/docs/newsletter-test.md` to see history.

## Operator log

Maintain a markdown file (or sheet) with date + tester + per-test ✅/❌ + notes. Past runs:
- 2026-04-29 — initial run by user. T-01.4 reported failing — diagnosed as browser cache.
