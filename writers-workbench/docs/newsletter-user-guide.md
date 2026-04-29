# Newsletter user guide

A walkthrough of every screen in the newsletter feature, in the order you'll
hit them when starting from zero. Each screen also has a `?` button in
its top-right corner that opens a contextual help drawer with a shorter
version of the same content.

## Table of contents

1. [Quick start (5 minutes)](#quick-start)
2. [My newsletters (editions)](#my-newsletters)
3. [Logo + branding](#logo--branding)
4. [Feeds](#feeds)
5. [Templates](#templates)
6. [Subscribers](#subscribers)
7. [Generate a newsletter](#generate-a-newsletter)
8. [Approvals](#approvals)
9. [Sends history](#sends-history)
10. [Newsletter detail](#newsletter-detail)
11. [Ingestion browser](#ingestion-browser)
12. [Schedule (cadence)](#schedule-cadence)
13. [Troubleshooting](#troubleshooting)

---

## Quick start

The shortest path from "I just signed up" to "I sent myself a real
newsletter" is six steps:

1. Sidebar → **Newsletter** → **My newsletters** → **New newsletter**.
2. Fill the masthead (display name, slug, subheader, genre). Click **Create**.
   The app drops you straight into the **Setup wizard** for that newsletter.
3. **Step 1: Feeds.** Click **Copy 6 starter AI feeds**. (You can skip this
   if you'd rather add your own URLs from scratch — open the full Feeds
   editor with the link below the button.)
4. **Step 2: Template.** A preview shows what the email will look like.
   Click **Use as-is** to keep the seeded "The Workbench" template, or
   **Customize this template** to edit it.
5. **Step 3: Subscriber.** Your own email is pre-filled. Click **Add**.
6. Click **Generate now →** to trigger a real run. The pipeline drafts
   stories → asks you to approve them → drafts a subject line → asks you
   to approve that → renders the email and saves it to **Sends**.

When you see the rendered email in Sends, you're done.

---

## My newsletters

Route: `/newsletter/editions`

Lists every newsletter you own. Each row shows the masthead name, slug,
genre, last-update date, and three buttons:

- **Feeds** — manage the RSS / Reddit / source URLs that fill this
  newsletter's content pool.
- **Edit** — change identity, branding (including logo), signoff, and
  schedule.
- **Disable** — soft-removes the newsletter from the active list. We
  don't hard-delete because past sends, approvals, and feeds reference
  the slug; disabling preserves history.

Click **New newsletter** (top-right) to create one. You'll be walked
through the **setup wizard** described in [Quick start](#quick-start).

---

## Logo + branding

Where: edit a newsletter (`/newsletter/editions/:id`) → **Branding**
section.

The logo (a.k.a. "stamp") sits above the footer of every send. The
seeded "The Workbench" template ships with a tiny CourseworxAI mark,
but for a newsletter that's yours, you'll want your own.

To upload:

1. Click **Upload logo**. Pick any image file (PNG / SVG with transparent
   background works best). Hard cap: 5 MB.
2. The app uploads it to a public Supabase Storage bucket, gets a public
   URL, and writes that URL onto your edition row's `stamp_url` column.
3. The next render — both the in-editor preview and any new send —
   pulls from `stamp_url` automatically. No template edits required.

To replace, click **Replace logo** and pick a new file. To remove,
click **Remove logo**: the row's `stamp_url` is cleared, and future
sends fall back to the template's built-in default.

Other branding fields:

- **Primary color** — masthead, links, accents. Use a hex like `#14288c`.
- **Paper color** — the card background. Defaults to a warm off-white
  (`#fbf8f2`) that works on both light and dark email clients.

> **Why isn't there a logo on the seeded template right now?** Migration
> 014 referenced a `/static/logos/courseworx-stamp-black.png` fallback
> that was never bundled. Until you upload a logo, that broken-image
> placeholder will show up in the preview. Uploading once fixes it for
> good.

---

## Feeds

Route: `/newsletter/editions/:id/feeds`

A "feed" is a URL the cron worker polls every 30 minutes (or whatever
interval you set per-feed) to scrape new articles into your content
pool. Each newsletter has its own list — feeds are NOT shared between
your newsletters.

Each row shows:

- **Name** — your label.
- **URL** — the feed endpoint.
- **Type**:
  - `rss` — most RSS / Atom feeds, including rss.app proxies.
  - `reddit` — Reddit JSON feeds.
  - `source` — a plain HTML page the worker should attempt to parse.
  - `firecrawl_scrape` — sites that need a full headless-browser scrape.
- **Interval** — minutes between polls (5 to 1440).
- **Last fetch** — when the cron last ran this feed; item count + error
  if any.
- **Status** — `active`, `paused`, or `error`.

### Adding a feed

Click **Add feed** to open the inline editor. Required: name, URL, type,
interval (defaults to 240). The URL must start with `http://` or
`https://`. Duplicate URLs (case-insensitive) for the same newsletter
are blocked with a 409.

### Pausing vs. deleting

**Pause** stops the cron from polling but keeps the feed row + run
history. **Delete** hard-removes both. Pause is what you want for "this
feed is broken; I'll come back to it"; delete is what you want for "I
added the wrong URL."

### When a feed errors

The **Status** column shows `error` and the row's `last_error` field
holds the message. Hover for the full text. The cron retries on the
next interval automatically; if a feed errors three runs in a row,
inspect it manually — usually the publisher's URL changed or rss.app
revoked the proxy.

---

## Templates

Route: `/newsletter/templates` (list) and `/newsletter/templates/:id`
(editor)

Templates are Handlebars HTML used to render the email at send time.
Exactly one is the **active default** per newsletter — that's what the
n8n pipeline uses unless overridden at generate time.

### Creating a new template

You have two starting points:

1. **From scratch.** Click **New template**. The editor pre-fills with
   a minimal HTML scaffold using `{{title}}` and `{{lead.body_html}}`
   placeholders. Build out from there.
2. **Imported HTML.** Click **Import HTML** to paste a complete document
   you got from somewhere else — e.g. Claude.ai/design, an external
   newsletter designer, your own template files. We strip `<script>`,
   `on*` event handlers, and `javascript:` URLs before saving so a
   pasted template can't smuggle in code.

### Generating a template with Claude.ai/design

We ship a paste-in prompt that produces a Handlebars template matching
our placeholder schema. See
[`writers-workbench/docs/newsletter-feeds-baseline.md`](newsletter-feeds-baseline.md)
and the prompt block in our planning notes; copy it into Claude.ai/design,
edit the branding override block at the bottom, and paste the resulting
HTML into **Import HTML**.

### Placeholder linter

Below the editor a panel shows three tone-colored columns:

- **Recognized** — placeholders that map to the canonical schema. Every
  one of these will be filled by the pipeline.
- **Unknown** — placeholders the pipeline doesn't send. They render
  empty unless your AI prompt explicitly produces them.
- **Missing required** — required placeholders the template doesn't
  reference. Soft warning; nothing blocks save, but those slots will be
  silently skipped at send time.

Tip: include `{{{markdown_to_html body_md}}}` somewhere in the body.
Today's pipeline produces a single markdown blob for the article body;
without that helper the rendered email will fall back to a `<pre>`
wrapper around raw markdown.

### Set as default

Toggle **Default for this edition** in the editor. The DB enforces
exactly one active default per edition — if there's already one, you'll
get a 409 with a message; demote the old one first.

---

## Subscribers

Where: edit a newsletter → **Subscribers** section (inline at the
bottom of the editor).

Each subscriber row holds an email, optional display name, status
(`active` / `unsubscribed` / `bounced`), and timestamps.

Add one by typing email + name and clicking **Add**. Duplicate emails
(case-insensitive) within the same newsletter are blocked.

For each row you can:

- **Activate / Unsubscribe** — toggles status. Unsubscribing stamps an
  `unsubscribed_at` timestamp; you can re-activate later.
- **Remove** — hard delete.

> **Setup tip:** add yourself first. The setup wizard does this
> automatically on step 3 (your account email is pre-filled). Doing this
> means your first generation run actually delivers to a real inbox, so
> you can test end-to-end.

---

## Generate a newsletter

Route: `/newsletter/generate`

A four-field form:

1. **Edition** — which newsletter to generate. Defaults to the first
   one in your list.
2. **Template** — leave blank to use the edition's active default; pick
   another to override for this run only.
3. **Send date** — defaults to today. The masthead's `Issue date` and
   the cron's `prefix={date}/` ingestion query both use this.
4. **Previous content** — the last newsletter's markdown. Auto-filled
   from your most recent send so the model can avoid duplicate
   coverage. Editable.

Click **Preview template** to see the chosen template rendered against
its sample data. Click **Generate newsletter →** to fire the pipeline.

You'll be redirected to `/newsletter/execution/:id` where the live
status updates as the workflow advances stage by stage.

---

## Approvals

Route: `/newsletter/approvals` (list) and `/newsletter/approvals/:token`
(detail)

Two checkpoints per generation:

1. **Stories.** The AI produces a list of candidate articles for the
   issue; you review and approve / revise. **Revise** sends your
   feedback back into the AI loop.
2. **Subject line.** Same flow for the email subject.

Each row in the list shows the stage, edition, created/expires
timestamps, and a short excerpt. Click into a row to see the draft,
the source-URL chips (links open the original article), and the
free-form feedback box.

Approvals expire after 48 hours by default. After expiry the row is
hidden from the list; the workflow's resume webhook also returns 410
if you try to act on it.

---

## Sends history

Route: `/newsletter/sends`

Filter by status (`scheduled`, `sent`, `failed`, etc.) and edition.
Each row links to the send detail page.

The list shows the subject, edition badge, issue number, status pill,
send date, and actual sent-at timestamp.

---

## Newsletter detail

Route: `/newsletter/sends/:id`

Three sections:

- **Rendered HTML** — a sandboxed iframe shows the email exactly as
  subscribers received it. The iframe `sandbox=""` attribute disables
  scripts, so even if the template has any `<script>` (it shouldn't —
  we strip on import), it can't run here.
- **Sidebar** — edition badge, issue number, send date, scheduled-at,
  sent-at, recipient count, delivery provider + provider message id,
  execution id (clickable — opens the n8n execution page), and an
  error block if status is `failed`.
- **Markdown source** — collapsed by default. Click to expand and see
  the markdown the AI produced before template rendering.

---

## Ingestion browser

Route: `/newsletter/ingestion`

Inspect the raw articles the cron worker has scraped. Pick a date from
the picker (defaults to today). The table shows every article's title,
type (`article`, `reddit_post`), source, and published timestamp.

Click any row (or the **View** button) to open a side drawer with two
tabs:

- **Markdown** — the markdown blob the AI generator will read.
- **HTML** — a sandboxed iframe of the original HTML the scraper
  captured.

Empty days mean either no feeds were active that day, every feed
errored, or the cron hadn't fired yet. Cross-check the **Feeds** page's
`last_fetched_at` and `last_error` columns.

---

## Schedule (cadence)

Where: edit a newsletter → **Schedule** section.

- **Cadence** — `none`, `daily`, `weekly`, `biweekly`, `monthly`. Drives
  whether a cron will auto-generate a draft on the schedule. `none`
  means generation is on-demand only (the default).
- **Send time** — free-form for now. Examples:
  - `09:00 fri` — Fridays at 9 AM UTC.
  - `08:30` — every cadence-day at 8:30 AM UTC.

This field stores the schedule on the edition row but the actual
auto-generate cron is a follow-up sprint; today, every send is
on-demand via **Generate newsletter →**.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| The masthead shows a broken `Courseworx stamp` placeholder | No logo uploaded yet | Edit the newsletter → Branding → **Upload logo** |
| The Generate page shows "No enabled editions found" | All your editions are disabled | My newsletters → click the disabled one → re-enable (TODO toggle; for now, edit and save) |
| The generated email is just `<pre>raw markdown</pre>` | Your template doesn't include the `{{{markdown_to_html body_md}}}` zone | Edit the template; the linter will warn that this fallback is missing |
| A feed says "error" and last_item_count is null | Publisher changed the URL or the proxy was revoked | Open the URL in a browser; if it 404s, replace it with the new URL |
| Subscribers list is empty when I expected mine | You added it on the wrong edition | Each newsletter has its own subscriber list — check the slug in the URL bar |
| Approval link from the email returns "expired" | Default 48-hour TTL passed | Re-trigger the run from `/newsletter/generate` |
| Ingestion browser is empty for today | Cron hasn't fired yet OR no active feeds OR every feed errored | Wait 30 min, OR check Feeds → status column |

---

## Where to file bugs

`/newsletter/admin` (when shipped) will route in-app bug reports. Until
then, paste the route URL + screenshot + a sentence about expected vs
actual into your usual support channel.
