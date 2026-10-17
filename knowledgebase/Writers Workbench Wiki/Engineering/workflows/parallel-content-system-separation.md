---
name: Parallel content system — separation plan (E4, E8, E9)
description: The 17 AI Dev Roundup / TechAhir / Content Studio workflows that share the n8n instance with the Workbench — measured coupling, why n8n data tables are the hard blocker, and what has to happen before the instance can be wound down. Also resolves E8 (Blotato LinkedIn silent failure) and E9 (the two public RSS endpoints) as defects inside this system rather than Workbench dependencies.
type: concept
tags: [n8n, separation, content, blotato, rss, e4, e8, e9]
last_reviewed: 2026-10-17
---

# Parallel content system — separation plan

The Writers Workbench shares its n8n instance with a **separate business**: the AI Dev Roundup,
the TechAhir site, and the Content Studio that drafts and publishes blog posts and LinkedIn updates.
[[remaining-work-inventory]] tracks it as **E4**, "needs a separation plan before the instance is
wound down — tracked, not blocking".

On **2026-10-17 the 36 DEV Workbench workflows were deactivated** (see [[log]]) and DEV now runs on
the engine alone. The 24 `PROD - …` workflows and the V1 tree ([[v1-frozen]]) are untouched. That
leaves this system as the only reason the n8n instance still has to exist for anything other than
PROD — so its separation is now the thing standing between "PROD cutover" and "turn the instance
off".

## The 17 workflows, and what each is coupled to

Measured by fetching each workflow's JSON and looking for the actual dependency, not by name.

| Workflow | id | n8n dataTable | Blotato | Anthropic |
|---|---|:-:|:-:|:-:|
| Dev Radar - Weekly AI+Dev Slate (ingestion) | `czBKvhON08FzFydK` | ● | | ● |
| Content - AI Dev Roundup (Social Studio) | `y0vIznzMeiGoxouX` | ● | ● | ● |
| Dev Roundup - Weekly Digest Email | `WiG2AmTTf6rUj6gS` | ● | | |
| Sub - Schedule Roundup Batch (LI only) | `hZq4ix2Te4vtPIuo` | ● | | |
| Feed - AI Dev Roundup (RSS) | `uSFq6y6YombFzzfT` | ● | | |
| Feed - AI Dev Roundup DIGEST (RSS) | `K6peMqAydbdr7Ldt` | ● | | |
| Content - AI & MVP Content Studio (Workflow B) | `fTRYiQOaQgdAmu7w` | ● | ● | ● |
| Content - Trend Radar (Workflow A) | `q1yDjiztjdGRDblT` | ● | | ● |
| Cron - Post Scheduled Website Blogs | `Se2X0fmkLUFK6CCq` | ● | | |
| Sub - Schedule Blog (queue) | `kw8qbViDZjaiDPeV` | ● | | |
| Sub - Manage Scheduled Posts | `HgRagIb4C3klIJa0` | ● | | |
| Batch - Generate & Schedule Week | `FaxRBqptjRfk8YuB` | ● | | ● |
| Sub - Publish Blog All Channels v2 | `6eQyuNp2A2bEIx1a` | | ● | |
| Sub - Publish to LinkedIn (Blotato) | `rkwZa88G7EJc7HY8` | | ● | |
| Sub - Post Blog to Website (API) | `427jMgRQEYzDA1IN` | | | |
| Studio - Email Post with Featured Image (tool) | `oYxlkOY7J0eK4yxo` | | | |
| Sub - Start Weekly Batch | `oxYeY4EXPctC7L3o` | | | |

## The hard blocker is the data, not the automation

**Twelve of the seventeen read or write n8n data tables.** That is not a workflow dependency that can
be re-pointed — it is application state living inside the orchestrator:

- the Dev Radar **slate** of candidate stories
- the **scheduled-post queue** that `Cron - Post Scheduled Website Blogs` drains hourly
- the **digest** the weekly email and both RSS feeds are built from

Turning the instance off deletes all of it. Every other coupling in the table is re-pointable in an
afternoon; this one needs a destination schema and a migration, and it is the whole of the work.

**Recommended destination: Supabase, in its own tables, in a separate project or at minimum a
separate schema.** Not the Workbench's `published_content_v2` — this is a different business with a
different content model, and the Workbench's base tables are immutable under
[[schema-governance]]. Sharing a database to save a Railway service would re-create the coupling
this plan exists to remove.

### What is NOT coupled

The two RSS feeds reference `writersworkbench-*.up.railway.app`, which looks like an API dependency
and is not: it is the base URL used to build `<link>` elements in the feed XML. No workflow in this
system calls a Workbench API. The inventory's note that E4 "calls WW `/api/newsletter/render-html`"
was true of an earlier shape and is no longer in the live JSON.

The **Anthropic credential** is shared with the Workbench tier, so rotating it (**G2**, unrotated
since May) breaks six of these workflows. Worth knowing before the rotation, not before the
separation.

## E8 — the Blotato LinkedIn silent failure

**Status: a real defect, and it is inside this system, not the Workbench.**

LinkedIn posts fail with HTTP 422 and a body carrying `code: 5002` ("Account connection has
expired"), and the workflow reports success because it checks the HTTP status of the *batch* call
rather than the per-channel result. A website+LinkedIn post therefore surfaces as "Posted" with the
LinkedIn half silently dropped. See [[project_blotato_linkedin_expiry]] in memory.

Searched and confirmed the user-visible "Posted" is **not** in the Workbench: there is no
`scheduled_blogs` table and no "Posted" string anywhere in `server/src` or `client/src`, and Blotato
appears nowhere in the engine or the Express server. The engine's `media.social-posts` op *drafts*
posts into `social_posts_v2` and never publishes. So no Workbench user sees this, and the engine
cannot fix it.

Two fixes, neither of which is the Workbench's to make:

1. **Root cause** — reconnect LinkedIn in the Blotato dashboard. This is the actual fix and it
   expires again; it is an operational task, not a code one.
2. **Make it loud** — `Sub - Publish to LinkedIn (Blotato)` and `Sub - Publish Blog All Channels v2`
   should inspect the response body for a per-channel `code` and fail the branch, so an expired
   connection is an error rather than a silent drop.

(2) is an edit to a **live workflow publishing to the user's own LinkedIn**, which
[[tier-separation]] baseline protection says is not changed without explicit permission. Flagged
rather than done.

## E9 — the two public RSS endpoints

**Status: not a Workbench dependency, but a real consequence of winding the instance down.**

`/webhook/ai-dev-roundup.xml` and `/webhook/ai-dev-roundup-digest.xml` are served by n8n webhook
workflows that read the digest out of an n8n data table and build the XML in a code node. They are
**public URLs that feed readers may be subscribed to**. The moment the instance stops, they 404 —
not degrade, 404 — and a subscriber's reader simply goes quiet.

This is therefore gated on the data-table migration above, and it needs a destination that serves
XML. The cheapest is a route on whatever service owns the migrated tables; it is ~40 lines, and the
existing `Build RSS` / `Build Digest RSS` code nodes are the spec.

## Sequence

1. **Decide the destination** for the n8n data tables (own Supabase project recommended).
2. **Migrate the three datasets** — slate, scheduled-post queue, digest — and keep n8n writing to
   both for one cycle so a rollback costs nothing.
3. **Re-point the 12 dataTable workflows** at the new store, or re-implement them wherever the data
   now lives.
4. **Serve the two RSS endpoints** from the new owner, then redirect the n8n webhook paths so no
   subscriber sees a 404 on cutover day.
5. **Give the system its own Anthropic credential**, so the Workbench's rotation (G2) stops being a
   shared risk.
6. **Fix E8 loudly** while the publishers are being touched anyway.
7. Only then is the instance down to the 24 `PROD - …` Workbench workflows plus the frozen V1 tree
   and the unrelated tenants in **E5** (CSHSE ×4, Upwork ×4, Mermaid, a KIE.AI demo) — which are out
   of scope for "turn off n8n" and have their own owners.

## What this is not

This is not a plan to *port* the Roundup into the Workbench engine. The two systems share an n8n
instance and an API credential, and nothing else: different content model, different publishing
targets, different audience. The right end state is two systems that do not know about each other,
not one bigger one.

Related: [[remaining-work-inventory]] · [[workflow-tiers]] · [[workflow-id-map]] · [[v1-frozen]]
