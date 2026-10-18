---
title: Newsletter — End-to-End Test Plan
subtitle: Covers PR #69, #70, #72, #73, #74 (Multi-User Newsletters → Fan-out + Cadence + Bounce + CSV)
date: 2026-04-29
---

# Newsletter — End-to-End Test Plan

This is the complete operator test plan for the newsletter feature as it
exists on **DEV** (`https://writersworkbench-develop.up.railway.app`)
after the recent sprint set. Run every test in order; some assume state
from previous tests.

**Estimated time to run all tests:** ~60–75 minutes.

## How to read each test

| Field | Meaning |
|---|---|
| **ID** | Reference handle (e.g. T-01.3) |
| **Setup** | What state the system needs to be in before you start |
| **Steps** | Exactly what to click / type, in order |
| **Pass** | What you must observe for the test to pass |
| **Fail** | Specific things that mean the test fails (other than the absence of pass) |

Mark each test ✅ pass / ❌ fail in the right margin as you go. Don't
skip a fail — make a note and continue; you can come back.

---

## Section 0 — Pre-flight

### T-00.1 — Sign in

| | |
|---|---|
| **Setup** | Browser at `https://writersworkbench-develop.up.railway.app` |
| **Steps** | 1. Sign in with your account.<br>2. Confirm the avatar in the top-right shows **Eric Beser**. |
| **Pass** | App shell loads; no console errors; sidebar shows the **Newsletter** section. |
| **Fail** | Login redirect loop, blank screen, 5xx, missing sidebar. |

### T-00.2 — Confirm deploy is current

| | |
|---|---|
| **Steps** | Open `/api/health` in a new tab. Confirm `version` field starts with `273878c` or later, and `environment` is `development`. |
| **Pass** | `version` is the latest deploy sha; `checks.supabase`, `checks.redis`, `checks.postal` all `ok`. |
| **Fail** | Any check is `fail` or stale build sha. |

---

## Section 1 — My newsletters (Editions list)

### T-01.1 — Open My newsletters

| | |
|---|---|
| **Steps** | Sidebar → expand **Newsletter** → click **My newsletters**. URL becomes `/newsletter/editions`. |
| **Pass** | Header reads "My newsletters". Table shows at least one row (`The Workbench`). The **`?`** help icon is in the top-right next to **New newsletter**. |
| **Fail** | 404, blank table, missing help icon. |

### T-01.2 — Help drawer opens

| | |
|---|---|
| **Steps** | Click the **`?`** icon in the page header. |
| **Pass** | A right-side drawer slides in titled "Newsletters (editions)" with body text describing identity, branding, signoff, schedule. Footer link points to `/docs/newsletter-user-guide.md`. |
| **Fail** | Drawer doesn't open, body text is missing or wrong. |

### T-01.3 — Close the help drawer

| | |
|---|---|
| **Steps** | Click **Close** (top-right of drawer) — or click anywhere on the dark backdrop. |
| **Pass** | Drawer disappears; underlying page is interactive again. |

### T-01.4 — Show disabled toggle (off → on)

| | |
|---|---|
| **Setup** | Filters panel shows "Show disabled" checkbox is **unchecked**. |
| **Steps** | Tick the **Show disabled** checkbox. |
| **Pass** | Table refetches. If you have any disabled editions, they appear with a grey **disabled** status pill. If you have none, table content stays the same and a Status column with **active** pills is now visible. |
| **Fail** | Page errors; toggle has no effect; column missing. |

### T-01.5 — Status column rendering

| | |
|---|---|
| **Steps** | Look at the **Status** column for `The Workbench`. |
| **Pass** | Pill reads **active** with green background. |
| **Fail** | Wrong color, wrong text, missing column. |

---

## Section 2 — Create + setup wizard (new newsletter)

### T-02.1 — Create button visible

| | |
|---|---|
| **Steps** | From `/newsletter/editions`, click **New newsletter** (top-right). URL becomes `/newsletter/editions/new`. |
| **Pass** | Form titled "New newsletter" loads. Identity / Branding / Signoff / Schedule sections are visible. Branding section says "Save the newsletter first" (no logo uploader yet). |

### T-02.2 — Slug auto-derives from display name

| | |
|---|---|
| **Steps** | In **Display name** type `Test Loop Letter`. Watch the **Slug** field as you type. |
| **Pass** | Slug auto-populates with `test-loop-letter` (lowercase, hyphenated). |
| **Fail** | Slug stays empty, contains spaces, or contains uppercase/special chars. |

### T-02.3 — Validation rejects empty required fields

| | |
|---|---|
| **Steps** | Clear **Newsletter name**. Click **Create newsletter**. |
| **Pass** | A red banner appears: "Display name, newsletter name, subheader, and genre are required." Form does NOT submit. |

### T-02.4 — Create with valid input + auto-routes to wizard

| | |
|---|---|
| **Setup** | T-02.2 state, fields filled in. |
| **Steps** | Fill in:<br>- **Display name**: `Test Loop Letter`<br>- **Slug**: `test-loop-letter` (already auto-filled)<br>- **Newsletter name**: `A Test Weekly`<br>- **Subheader**: `Demo loop for the test plan`<br>- **Genre**: `test`<br>Then click **Create newsletter**. |
| **Pass** | Browser redirects to `/newsletter/editions/test-loop-letter/setup`. The page header reads "Set up Test Loop Letter". A 4-stage stepper shows **1. Feeds → 2. Template → 3. Subscriber → 4. Done**, with step 1 highlighted. |
| **Fail** | 500 error, redirect to list page, missing wizard. |

### T-02.5 — Setup step 1: copy starter feeds

| | |
|---|---|
| **Steps** | On the **Feeds** step, click **Copy 6 starter AI feeds**. |
| **Pass** | Button shows "Copying…" briefly, then the box reads "**6** feeds attached". |
| **Fail** | Error banner; "0 feeds attached" after click; UI hangs. |

### T-02.6 — Setup step 1: idempotent re-click

| | |
|---|---|
| **Steps** | Click **Copy 6 starter AI feeds** **again**. |
| **Pass** | Still says "**6** feeds attached" (no duplicates created — server returned 409 DUPLICATE_URL on each, which the client swallows). |

### T-02.7 — Advance to step 2 (template)

| | |
|---|---|
| **Steps** | Click **Next: Template →**. |
| **Pass** | The view changes to step 2; an iframe renders the default template ("The Workbench"). The masthead "The Workbench" and footer text are visible. **Customize this template →** link is shown. |
| **Fail** | Empty iframe, missing template, error banner. |

### T-02.8 — Advance to step 3 (subscriber)

| | |
|---|---|
| **Steps** | Click **Next: Subscriber →**. |
| **Pass** | Form pre-fills the **Email** field with your account email (`eric@agileadtesting.com`). |
| **Fail** | Email field empty when your account email is set; form missing. |

### T-02.9 — Add subscriber

| | |
|---|---|
| **Steps** | Click **Add**. |
| **Pass** | Button changes to **Added ✓**. |

### T-02.10 — Finish wizard

| | |
|---|---|
| **Steps** | Click **Done →**. |
| **Pass** | Step 4 view shows "All set" with **Generate now →** + **Back to my newsletters** buttons. |

### T-02.11 — Confirm new newsletter on the list

| | |
|---|---|
| **Steps** | Click **Back to my newsletters**. |
| **Pass** | List now contains both `The Workbench` and `Test Loop Letter`. Status pill is **active** for both. |

---

## Section 3 — Edit existing newsletter (Workbench / ai-news)

### T-03.1 — Open the editor

| | |
|---|---|
| **Steps** | From `/newsletter/editions`, click **Edit** on the `The Workbench` row (or click the row title). URL = `/newsletter/editions/ai-news`. |
| **Pass** | Form titled "Edit The Workbench". Slug field is **disabled** (greyed-out, can't type). |

### T-03.2 — Identity section (read-only inspection)

| | |
|---|---|
| **Pass** | Display name, slug, newsletter name, subheader, genre, description all populated. |

### T-03.3 — Branding: logo uploader visible

| | |
|---|---|
| **Steps** | Scroll to **Branding**. |
| **Pass** | A 96x96 thumbnail shows your previously-uploaded logo (if any) OR a "No logo" placeholder. **Upload logo** / **Replace logo** + **Remove logo** buttons are present. |

### T-03.4 — Replace logo (image upload)

| | |
|---|---|
| **Setup** | Have any PNG/JPG/SVG file ≤5MB on disk. |
| **Steps** | 1. Click **Upload logo** (or **Replace logo** if a logo already exists).<br>2. Pick your image file. |
| **Pass** | Upload status shows briefly. The thumbnail updates to your new image within ~3 seconds. No error banner. |
| **Fail** | "Upload failed", thumbnail doesn't change, broken-image icon appears. |

### T-03.5 — Logo size limit

| | |
|---|---|
| **Setup** | Have an image >5MB on disk. |
| **Steps** | Click **Replace logo** → pick the >5MB file. |
| **Pass** | Red banner: "Image is over 5 MB. Compress it first." Logo doesn't change. |

### T-03.6 — Remove logo

| | |
|---|---|
| **Steps** | Click **Remove logo**. Confirm the prompt. |
| **Pass** | Thumbnail returns to "No logo" placeholder. |

### T-03.7 — Re-upload to leave a working logo

| | |
|---|---|
| **Steps** | Re-upload an image (T-03.4). |
| **Pass** | Thumbnail shows the new logo. |

### T-03.8 — Brand colors

| | |
|---|---|
| **Steps** | In the Primary color row, click the colored square. Use the OS color picker to pick `#dd0033`. The hex text input updates to `#dd0033`. |
| **Pass** | Both inputs (color square + text) reflect the new value. (Save isn't required to verify the picker works.) |
| **Steps (cont.)** | Change it back to `#14288c`. |

### T-03.9 — Signoff

| | |
|---|---|
| **Steps** | In **Signoff**, set:<br>- **Signature name**: `Eric`<br>- **Signature role**: `Editor, The Workbench` |
| **Pass** | Both fields accept the input; max 120 chars enforced. |

### T-03.10 — Schedule cadence

| | |
|---|---|
| **Steps** | In **Schedule**, change **Cadence** to **Weekly**. |
| **Pass** | A new field **Send time** appears below. Type `09:00 fri`. |

### T-03.11 — Save changes

| | |
|---|---|
| **Steps** | Click **Save changes**. |
| **Pass** | Browser routes back to `/newsletter/editions`. No error. |
| **Fail** | "DEFAULT_EXISTS" error or any 4xx/5xx banner. |

### T-03.12 — Verify changes persisted

| | |
|---|---|
| **Steps** | Click **Edit** on `The Workbench` again. |
| **Pass** | Cadence is **Weekly**, send time is `09:00 fri`, signoff is `Eric` / `Editor, The Workbench`. |

---

## Section 4 — Subscribers (manual + CSV)

### T-04.1 — View subscribers

| | |
|---|---|
| **Steps** | On the edit page, scroll to the **Subscribers** section at the bottom. |
| **Pass** | Header reads "Subscribers", with sub-text "1 active · 1 total". `eric@agileadtesting.com` row is shown with status **active**. |

### T-04.2 — Add a subscriber manually

| | |
|---|---|
| **Steps** | In the add form: type **Email** = `loop1@example.test`, **Display name** = `Loop One`. Click **Add**. |
| **Pass** | Row appears in the table with status **active**. Counter updates to "2 active · 2 total". |

### T-04.3 — Duplicate email rejected

| | |
|---|---|
| **Steps** | Try to add `loop1@example.test` again. |
| **Pass** | Red banner: "That email is already subscribed to this newsletter". No duplicate row. |

### T-04.4 — Unsubscribe

| | |
|---|---|
| **Steps** | On the `loop1@example.test` row, click **Unsubscribe**. |
| **Pass** | Status pill changes from **active** (green) to **unsubscribed** (grey). Counter: "1 active · 2 total". |

### T-04.5 — Activate again

| | |
|---|---|
| **Steps** | Click **Activate** on the now-unsubscribed row. |
| **Pass** | Pill back to **active**. Counter: "2 active · 2 total". |

### T-04.6 — Remove subscriber

| | |
|---|---|
| **Steps** | Click **Remove** on the `loop1@example.test` row. Confirm. |
| **Pass** | Row disappears. Counter: "1 active · 1 total". |

### T-04.7 — CSV import: prepare a file

| | |
|---|---|
| **Steps** | On disk, create `subscribers.csv` with this content:<br>```<br>email,display_name<br>csv1@example.test,CSV One<br>csv2@example.test,CSV Two<br>csv3@example.test,<br>broken-row-no-email,<br>csv1@example.test,Duplicate of CSV One<br>``` |

### T-04.8 — Import CSV

| | |
|---|---|
| **Steps** | In the Subscribers panel header, click **Import CSV**. Select your `subscribers.csv`. |
| **Pass** | Within ~2 seconds a green banner appears: "Imported **3** new subscribers. Skipped **1** duplicate, **1** invalid." |
| **Fail** | Wrong counts, red error banner, no banner at all. |

### T-04.9 — Verify imported rows

| | |
|---|---|
| **Pass** | Table now contains `csv1@example.test`, `csv2@example.test`, `csv3@example.test` (with status **active**). Counter: "4 active · 4 total". |

### T-04.10 — Re-import same CSV is idempotent

| | |
|---|---|
| **Steps** | Click **Import CSV**, pick the same file again. |
| **Pass** | Banner: "Imported **0** new subscribers. Skipped **3** duplicate, **1** invalid." (Yes, the 4th line — broken-row — still counts as invalid each time. The dedupe of the 5th line happens in-file before hitting the DB.) |

### T-04.11 — Clean up imported rows

| | |
|---|---|
| **Steps** | Click **Remove** on each `csv*` row in turn. Confirm each. |
| **Pass** | After all three removals, you're back to "1 active · 1 total" with only `eric@agileadtesting.com`. |

---

## Section 5 — Feeds (per-newsletter)

### T-05.1 — Open the feeds page

| | |
|---|---|
| **Steps** | From `/newsletter/editions`, click **Feeds** on `The Workbench` row. URL = `/newsletter/editions/ai-news/feeds`. |
| **Pass** | Header reads "Feeds for The Workbench". 17 feeds are listed. The `?` help icon is in the top-right. |

### T-05.2 — Help drawer (feeds-specific)

| | |
|---|---|
| **Steps** | Click `?`. |
| **Pass** | Drawer titled "Feeds" describes RSS / Reddit / source / firecrawl_scrape types and pause/resume semantics. Close the drawer. |

### T-05.3 — Each row shows last_fetched + status

| | |
|---|---|
| **Pass** | Every active row shows a non-empty **Last fetch** timestamp (post-2026-04-29 15:01) and a green **active** status pill. None should show **error** unless something genuinely went wrong. |

### T-05.4 — Pause a feed

| | |
|---|---|
| **Steps** | On the `The Neuron` row, click **Pause**. |
| **Pass** | Status pill changes to **paused** (grey). The Pause button changes to **Resume**. |

### T-05.5 — Resume the feed

| | |
|---|---|
| **Steps** | Click **Resume**. |
| **Pass** | Status pill back to **active**. Button is **Pause** again. |

### T-05.6 — Edit a feed

| | |
|---|---|
| **Steps** | Click **Edit** on any row. The inline editor opens with the row's values pre-filled. |
| **Pass** | All fields editable (name, URL, type, interval, active checkbox). |

### T-05.7 — Edit interval validation

| | |
|---|---|
| **Steps** | In the inline editor, change interval to `1`. Click **Save**. |
| **Pass** | Red banner: minimum-interval validation error. Save is rejected. |
| **Steps (cont.)** | Change interval back to `240`. Click **Save**. |
| **Pass** | Editor closes; table shows `240m` interval. |

### T-05.8 — Add a new feed

| | |
|---|---|
| **Steps** | Click **Add feed**. Fill in:<br>- **Name**: `Test Feed`<br>- **URL**: `https://hnrss.org/frontpage`<br>- **Type**: `rss`<br>- **Interval**: `120`<br>Click **Add feed**. |
| **Pass** | Editor closes; new row at the bottom with the values you entered. Last-fetch is empty (—). |

### T-05.9 — URL validation

| | |
|---|---|
| **Steps** | Click **Add feed**. URL = `not-a-url`. Click **Add feed**. |
| **Pass** | Red inline banner: "URL must start with http:// or https://". Save rejected. |
| **Steps (cont.)** | Click **Cancel** to close. |

### T-05.10 — Delete the test feed

| | |
|---|---|
| **Steps** | On the `Test Feed` row, click **Delete**. Confirm. |
| **Pass** | Row vanishes. List back to 17. |

### T-05.11 — Manage feeds shortcut from Ingestion

| | |
|---|---|
| **Steps** | Sidebar → **Newsletter** → **Ingestion**. In the page header, click **Manage feeds →**. |
| **Pass** | Routes to `/newsletter/editions/ai-news/feeds` (or whatever your first edition is). |

---

## Section 6 — Templates

### T-06.1 — Open templates list

| | |
|---|---|
| **Steps** | Sidebar → Newsletter → **Templates**. URL = `/newsletter/templates`. |
| **Pass** | At least one row: `The Workbench (default)` with a green **default** badge for the `ai-news` edition. |

### T-06.2 — Open the template editor

| | |
|---|---|
| **Steps** | Click `The Workbench (default)`. |
| **Pass** | Editor loads with HTML source on the left and Preview iframe on the right. **Render preview**, **Import HTML**, **Save** buttons in the header. |

### T-06.3 — Preview iframe shows the logo

| | |
|---|---|
| **Steps** | Click **Render preview**. Wait ~2 seconds. Scroll the preview iframe to the bottom. |
| **Pass** | Your uploaded logo appears in the footer (NOT a broken-image icon). The "— Eric / EDITOR, THE WORKBENCH" signoff is visible. |
| **Fail** | Broken-image placeholder, default Course Worx stamp instead of your uploaded one, missing signoff. |

### T-06.4 — Placeholder linter panel

| | |
|---|---|
| **Steps** | Scroll below the HTML editor to the **Placeholders** panel. |
| **Pass** | Three columns visible:<br>- **Recognized** (~41 tokens)<br>- **Unknown** (~2 — usually `@index`, `@last` for Handlebars built-ins)<br>- **Missing required** (0)<br>Tip line shows "✓ {{{markdown_to_html body_md}}} fallback present." |

### T-06.5 — Import HTML drawer

| | |
|---|---|
| **Steps** | Click **Import HTML** (top-right). |
| **Pass** | A drawer opens below the header with a textarea and **Replace template HTML** + **Cancel** buttons. |

### T-06.6 — Sanitize import

| | |
|---|---|
| **Steps** | Paste this into the textarea:<br>```html<br><html><body><h1>Hello {{title}}</h1><script>alert('hi')</script><a onclick="evil()" href="javascript:alert(1)">x</a></body></html><br>```<br>Click **Replace template HTML**. |
| **Pass** | An amber banner appears: "Imported. Stripped: <script> block, on* handler, javascript: href." The HTML editor now contains the cleaned HTML (no `<script>`, no `onclick`, no `javascript:`). |
| **Fail** | `<script>` left in, `onclick` left in, `javascript:` left in. |

### T-06.7 — Restore the original template

| | |
|---|---|
| **Steps** | Press the browser **Back** button (or refresh and don't save). |
| **Pass** | The default Workbench HTML is back in the editor. |

### T-06.8 — Sample data parse error

| | |
|---|---|
| **Steps** | Scroll to **Sample data (JSON)**. Replace its content with `not json`. |
| **Pass** | A red inline banner appears below the textarea: "JSON parse error" (or similar). The Save button refuses to proceed (try clicking Save: red banner above). |
| **Steps (cont.)** | Press the browser **Back** button to discard. |

### T-06.9 — Default-template uniqueness

| | |
|---|---|
| **Steps** | Open the template editor (T-06.2). Change **Name** to `Workbench Test Copy`. Click **Save**. |
| **Pass** | Saves cleanly (the same row, just renamed). |
| **Steps (cont.)** | Restore the name to `The Workbench (default)` and save. |

---

## Section 7 — Generate

### T-07.1 — Open Generate page

| | |
|---|---|
| **Steps** | Sidebar → Newsletter → **Generate**. URL = `/newsletter/generate`. |
| **Pass** | Form with **Edition** dropdown (selects `The Workbench (ai-news)`), **Template** dropdown ("(default for this edition)" entry first), **Send date** (defaults to today), **Previous newsletter content** textarea (auto-filled if there's a recent send). The `?` help icon is in the page header. |

### T-07.2 — Help drawer (generate-specific)

| | |
|---|---|
| **Steps** | Click `?`. |
| **Pass** | Drawer titled "Generate a newsletter" describes the 4 pipeline stages (read articles → stories approval → subject approval → render+save). Close it. |

### T-07.3 — Edition selector + badge

| | |
|---|---|
| **Steps** | Look at the Edition dropdown. The blue `ai-news` edition badge is shown next to it. |

### T-07.4 — Template picker — defaults blank

| | |
|---|---|
| **Steps** | Look at the **Template** dropdown. |
| **Pass** | First option is `(default for this edition)` and is selected. Beneath it: any non-default template names for `ai-news`. |

### T-07.5 — Edition switch resets template selection

| | |
|---|---|
| **Setup** | You created `Test Loop Letter` in T-02. |
| **Steps** | Switch the edition dropdown to `Test Loop Letter`. |
| **Pass** | Template dropdown resets to `(default for this edition)`. (No carry-over from the prior edition.) |
| **Steps (cont.)** | Switch back to `The Workbench`. |

### T-07.6 — Preview template (no real run)

| | |
|---|---|
| **Steps** | Click **Preview template** (top-right of the form area). |
| **Pass** | A modal opens with an iframe rendering the default template against sample data. The masthead and your uploaded logo at the bottom both display. **Close** dismisses the modal. |

### T-07.7 — DO NOT trigger a real run yet

| | |
|---|---|
| **Pass** | Don't click **Generate newsletter →** in this section — we exercise that end-to-end in Section 11. |

---

## Section 8 — Approvals

### T-08.1 — Open the queue

| | |
|---|---|
| **Steps** | Sidebar → Newsletter → **Pending approvals**. URL = `/newsletter/approvals`. |
| **Pass** | Page loads. If the queue is empty, you see "No pending approvals. You're caught up." (this is the expected state if you haven't triggered a run yet). |

### T-08.2 — Help drawer (approvals)

| | |
|---|---|
| **Steps** | Click `?` in the page header. |
| **Pass** | Drawer titled "Approvals" describes the two-stage flow (stories then subject) and 48-hour TTL. Close it. |

(Real approval flow is exercised end-to-end in Section 11.)

---

## Section 9 — Sends list

### T-09.1 — Open Sends

| | |
|---|---|
| **Steps** | Sidebar → Newsletter → **Sends**. URL = `/newsletter/sends`. |
| **Pass** | Page header reads "Sends". Filters: **Status** (defaults to `scheduled`) and **Edition** (defaults to `All editions`). The `?` help icon in the header. |

### T-09.2 — Status filter

| | |
|---|---|
| **Steps** | Change Status to `all`. |
| **Pass** | Table populates with every newsletter send your account has ever produced. Each row links to a detail page. |

### T-09.3 — Edition filter

| | |
|---|---|
| **Steps** | Change Edition to `The Workbench (ai-news)`. |
| **Pass** | Table filters down to ai-news rows only. |

### T-09.4 — Open a send detail

| | |
|---|---|
| **Steps** | Click any row's subject. |
| **Pass** | URL becomes `/newsletter/sends/<uuid>`. The detail page loads with:<br>- A sandboxed iframe rendering the email's HTML<br>- A sidebar showing edition, issue number, send date, scheduled timestamp, sent timestamp, recipient count, provider info, execution id (clickable), and an error block if status is failed.<br>- A collapsed **Markdown source** section at the bottom. |

### T-09.5 — Iframe is sandboxed

| | |
|---|---|
| **Steps** | Open browser DevTools → Inspect the iframe element. |
| **Pass** | The iframe element has `sandbox=""` (empty value — strictest sandbox). Scripts in the email cannot run. |

### T-09.6 — Markdown source toggle

| | |
|---|---|
| **Steps** | Click **Markdown source** at the bottom. |
| **Pass** | The pre-formatted markdown body of the send is displayed. Click again — it collapses. |

### T-09.7 — Execution deep-link

| | |
|---|---|
| **Setup** | The send must have an execution id in the sidebar. |
| **Steps** | Click the monospace execution id. |
| **Pass** | Browser tab routes to `/newsletter/execution/<id>` with the live execution status page. |

---

## Section 10 — Ingestion library

### T-10.1 — Open the library

| | |
|---|---|
| **Steps** | Sidebar → Newsletter → **Ingestion**. URL = `/newsletter/ingestion`. |
| **Pass** | Page header reads "Ingestion library" with a totals line ("31 total across 10 days" — numbers may have grown). Layout: left sidebar (Days with content), right side (date picker + table). The `?` help icon is in the header. **Manage feeds →** button is in the header. |

### T-10.2 — Default date is the most recent with data

| | |
|---|---|
| **Pass** | The date picker defaults to a recent date with non-zero items (NOT today if today is empty). Sidebar shows that date highlighted. |

### T-10.3 — Sidebar navigation

| | |
|---|---|
| **Steps** | Click an older date in the sidebar (e.g. `2026-04-23`). |
| **Pass** | Right side updates to show that date's articles. The picker also updates. |

### T-10.4 — Each row shows scanned date

| | |
|---|---|
| **Pass** | Every row's **Scanned** column shows a date+time formatted like `Apr 23, 4:32 PM` (when the cron worker actually ingested it). |

### T-10.5 — Source link works

| | |
|---|---|
| **Steps** | On any row, click the source-name hyperlink in the **Source** column. |
| **Pass** | New tab opens to the original article URL. |

### T-10.6 — View drawer: markdown tab

| | |
|---|---|
| **Steps** | Click **View** on any row (or click the title). |
| **Pass** | Right-side drawer opens. Header shows title, key, type, source, scanned timestamp, and an external-link to the original. The **markdown** tab is selected by default and shows the article body as markdown text. |

### T-10.7 — View drawer: html tab

| | |
|---|---|
| **Steps** | In the drawer, click **html**. |
| **Pass** | Sandboxed iframe renders the original article's HTML. |

### T-10.8 — Drawer close

| | |
|---|---|
| **Steps** | Click **Close** in the drawer header (or click the dark backdrop). |
| **Pass** | Drawer disappears. |

### T-10.9 — Manage feeds shortcut

| | |
|---|---|
| **Steps** | Click **Manage feeds →** in the page header. |
| **Pass** | Navigates to `/newsletter/editions/ai-news/feeds`. |

### T-10.10 — Empty day messaging

| | |
|---|---|
| **Steps** | Use the date picker to pick a date with no data (any date 2025-12-XX). |
| **Pass** | Right side shows "No items for 2025-12-XX. Check the Feeds page for last-fetch errors." with **Feeds page** as a link. |

---

## Section 11 — End-to-end newsletter generation

> **WARNING:** This section actually triggers the n8n pipeline. The
> approval emails will go to your address. The final send (after
> approvals) will deliver to your active subscribers — currently only
> `eric@agileadtesting.com`. Confirm that before running.

### T-11.0 — Verify subscriber list

| | |
|---|---|
| **Steps** | Edit the `The Workbench` newsletter → scroll to Subscribers. |
| **Pass** | Exactly one **active** row: `eric@agileadtesting.com`. No other addresses. |

### T-11.1 — Confirm the n8n agent has the new fan-out nodes

| | |
|---|---|
| **Steps** | Open `https://n8n.agileadautomation.com/workflow/bMvMKyK8obwYZmNb`. Cmd-R to refresh. |
| **Pass** | The workflow editor loads with **102 nodes**. Search for `fetch_subscribers` and `send_to_subscribers` — both must be present. |

### T-11.2 — Publish the workflow

| | |
|---|---|
| **Steps** | Click **Publish** (top-right; ⌘P). |
| **Pass** | Status indicator shows the new version is published. |
| **Fail** | Publish button is greyed out (means tab wasn't refreshed first — Cmd-R again, then retry). |

### T-11.3 — Trigger generation

| | |
|---|---|
| **Steps** | App → Sidebar → Newsletter → Generate. Edition = `The Workbench`. Send date = today. Click **Generate newsletter →**. |
| **Pass** | URL routes to `/newsletter/execution/<id>`. The Execution Status page shows the workflow advancing through stages: gathering, … |

### T-11.4 — Stories approval lands

| | |
|---|---|
| **Setup** | Watch the Execution Status page until it shows the Stories approval stage, OR check your email. |
| **Steps** | When the email arrives (subject likely "Approve newsletter stories — …"), come back to the app: Sidebar → Pending approvals. |
| **Pass** | A new row with stage = **stories** appears within ~5 minutes of the run starting. |
| **Fail** | No email after 10 min, no row in approvals. (If this happens, check the Execution Status page for which node errored.) |

### T-11.5 — Stories: review payload

| | |
|---|---|
| **Steps** | Click the approval row. |
| **Pass** | The payload shows a numbered list of selected stories. Each story has a title, summary, and source-URL chips that link out. **Source identifiers** (the date-prefixed keys) are clickable and link into the Ingestion library at the right date. |

### T-11.6 — Story-identifier deep-link (the key cleanup)

| | |
|---|---|
| **Steps** | Click any source identifier (e.g. `2026-04-29/some-slug.foo`). |
| **Pass** | Opens `/newsletter/ingestion?date=2026-04-29` in a new tab/same window. The library loads with that date's articles. |
| **Fail** | The text "Ingestion browser not yet available — Phase 2b" appears anywhere — that's the old stub. |

### T-11.7 — Approve stories

| | |
|---|---|
| **Steps** | Back on the approval detail, in the **Decision** form choose **Approve**. Click **Submit**. |
| **Pass** | Page shows "Approval recorded". The execution advances to the subject-line stage. |

### T-11.8 — Subject line approval lands

| | |
|---|---|
| **Steps** | Wait ~3-5 min for the subject email. Pending approvals → click the new **subject_line** row. |
| **Pass** | A draft subject line is displayed. Resolve form is below. |

### T-11.9 — Approve subject

| | |
|---|---|
| **Steps** | Choose **Approve**. Submit. |
| **Pass** | Workflow advances. Execution Status shows render → save → final notification → fan-out. |

### T-11.10 — Verify the rendered newsletter saved

| | |
|---|---|
| **Steps** | Sidebar → Newsletter → Sends. Status filter = `all`. |
| **Pass** | A new row at the top with today's send date and the subject you just approved. Status = `sent` or `draft`. |

### T-11.11 — Open the rendered email

| | |
|---|---|
| **Steps** | Click the new send row. |
| **Pass** | The detail page renders the full email in the iframe. Confirm:<br>- **Logo** at the bottom is YOUR uploaded logo (not the broken Course Worx fallback).<br>- **Signoff** = `— Eric` / `EDITOR, THE WORKBENCH` (matches the edition's signature_name + role).<br>- Body content matches what you approved. |
| **Fail** | Broken logo, default "Eric / Editor" boilerplate when you set something different, malformed HTML. |

### T-11.12 — Check your email inbox

| | |
|---|---|
| **Steps** | Check `eric@agileadtesting.com` for the actual delivery. |
| **Pass** | Email received within ~2 min of the workflow finishing. The masthead and footer logo render. The "to" address is your subscriber email (NOT a hardcoded address). |
| **Fail** | No email arrives within 10 minutes; or it goes to a hardcoded address that isn't on the subscriber list. |

---

## Section 12 — Cron workflows (operator/observability)

### T-12.1 — Multi-User Newsletter Ingestion cron is active

| | |
|---|---|
| **Steps** | Open `https://n8n.agileadautomation.com/workflow/JAQ8rmCaDoddqt2k`. |
| **Pass** | Workflow opens. Status indicator (top-right) shows it's **active**. Title is `DEV - Newsletter Ingestion (Multi-User Cron)`. |

### T-12.2 — Cron has fired recently

| | |
|---|---|
| **Steps** | Click **Executions** in the workflow menu. |
| **Pass** | Multiple executions in the last few hours, all green (success). Most are sub-second (returning 0 due feeds — expected when feeds aren't due). |

### T-12.3 — Cadence cron is active

| | |
|---|---|
| **Steps** | Open `https://n8n.agileadautomation.com/workflow/7l1z4uMS9kdkYIT4`. |
| **Pass** | Title is `DEV - Newsletter Cadence Cron`. Status = **active**. 5 nodes: cron_trigger → fetch_due_editions → extract_editions → split_per_edition → post_to_webhook. |

### T-12.4 — Cadence cron has fired

| | |
|---|---|
| **Steps** | Open Executions for that workflow. |
| **Pass** | At least one execution in the last hour. All green. (If the only enabled-with-cadence newsletter has a recent send, the post_to_webhook node won't fire — that's correct.) |

---

## Section 13 — Re-enable a disabled newsletter

### T-13.1 — Disable Test Loop Letter

| | |
|---|---|
| **Setup** | The `Test Loop Letter` newsletter from Section 2 still exists. |
| **Steps** | `/newsletter/editions` → click **Disable** on the `Test Loop Letter` row. Confirm. |
| **Pass** | The row vanishes from the default view. |

### T-13.2 — See it in disabled view

| | |
|---|---|
| **Steps** | Tick **Show disabled**. |
| **Pass** | `Test Loop Letter` re-appears with a grey **disabled** status pill. The action button now reads **Re-enable**. |

### T-13.3 — Re-enable

| | |
|---|---|
| **Steps** | Click **Re-enable**. |
| **Pass** | Status pill flips back to green **active**. Button reverts to **Disable**. |

### T-13.4 — Hide disabled view

| | |
|---|---|
| **Steps** | Untick **Show disabled**. |
| **Pass** | Both `The Workbench` and `Test Loop Letter` are visible (both active). |

### T-13.5 — Disable Test Loop Letter again (cleanup)

| | |
|---|---|
| **Steps** | Disable `Test Loop Letter` to clean up. |

---

## Section 14 — Bounce auto-flip

> This test simulates a Postal hard-bounce webhook. The expected behavior
> is that any active subscriber matching the bounced email gets flipped
> to `status='bounced'`. Requires a CLI to send the webhook payload.

### T-14.1 — Add a sacrificial subscriber

| | |
|---|---|
| **Steps** | Edit `The Workbench` → Subscribers → add `bounce-test@example.test` / "Bounce Tester". |
| **Pass** | Row appears as **active**. |

### T-14.2 — Trigger a fake bounce webhook

| | |
|---|---|
| **Setup** | Need terminal + the Postal webhook secret. The DEV Postal webhook secret is in the user's vault; or skip this test if you don't have it. |
| **Steps** | Run:<br>```bash<br>curl -X POST https://writersworkbench-develop.up.railway.app/api/email/webhook/postal \\<br>  -H "X-Postal-Webhook-Secret: <DEV_POSTAL_WEBHOOK_SECRET>" \\<br>  -H "Content-Type: application/json" \\<br>  -d '{"event":"MessageBounced","uuid":"test-evt-1","timestamp":1714451000,"payload":{"message":{"id":1,"to":"bounce-test@example.test","from":"eve@courseworx.media","subject":"Test bounce"}}}'<br>``` |
| **Pass** | Response is `{"success":true}`. |

### T-14.3 — Subscriber row flipped

| | |
|---|---|
| **Steps** | Refresh the Subscribers panel (re-open the edition's edit page). |
| **Pass** | The `bounce-test@example.test` row's status pill is now **bounced** (red), not active. |

### T-14.4 — Cleanup

| | |
|---|---|
| **Steps** | Click **Remove** on the bounced row. Confirm. |

---

## Section 15 — Help drawer per-screen consistency

### T-15.1 — Walk every screen

| | |
|---|---|
| **Steps** | For each of these routes, click the `?` button in the page header and confirm a drawer opens with relevant content:<br>- `/newsletter`<br>- `/newsletter/generate`<br>- `/newsletter/approvals`<br>- `/newsletter/sends`<br>- `/newsletter/ingestion`<br>- `/newsletter/templates`<br>- `/newsletter/editions`<br>- `/newsletter/editions/new` |
| **Pass** | Each drawer has a different title and body that matches its screen. The footer "Full guide" link points at `/docs/newsletter-user-guide.md`. |

---

## Final pass/fail tally

| Section | Tests | Passed | Failed |
|---|---|---|---|
| 0 — Pre-flight | 2 | __ | __ |
| 1 — Editions list | 5 | __ | __ |
| 2 — Create + wizard | 11 | __ | __ |
| 3 — Edit existing | 12 | __ | __ |
| 4 — Subscribers | 11 | __ | __ |
| 5 — Feeds | 11 | __ | __ |
| 6 — Templates | 9 | __ | __ |
| 7 — Generate (form only) | 7 | __ | __ |
| 8 — Approvals (UI surface) | 2 | __ | __ |
| 9 — Sends list + detail | 7 | __ | __ |
| 10 — Ingestion library | 10 | __ | __ |
| 11 — End-to-end run | 13 | __ | __ |
| 12 — Cron observability | 4 | __ | __ |
| 13 — Re-enable | 5 | __ | __ |
| 14 — Bounce flip | 4 | __ | __ |
| 15 — Help drawer | 1 | __ | __ |
| **Total** | **114** | __ | __ |

A run "passes" if **all 114 tests pass**. Any failure that isn't a known
network blip (re-run once, count it on the second result) is a real
defect — file it with the Test ID + screenshot + a sentence about
expected vs actual.

## Artifacts to attach when filing a failure

- The Test ID (e.g. `T-04.8`)
- Screenshot of the failing screen
- The exact URL in the address bar
- The browser console log if there's a 4xx/5xx (open DevTools → Console
  → copy the error)
- For end-to-end run failures (Section 11): the n8n execution id from
  `/newsletter/execution/<id>` so an engineer can pull the full run log
