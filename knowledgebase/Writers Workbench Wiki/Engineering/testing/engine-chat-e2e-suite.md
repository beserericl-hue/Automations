---
name: Engine chat E2E suite
description: End-to-end functional test suite driven through the engine hub CHAT interface (/api/chat/proxy → engine hub). Covers every engine catalog op + lifecycle sub-ops + genres + story arcs + prologue/epilogue + the Workbench action buttons, with pass/fail criteria. Engine-era rewrite of regressiontest_prompts.md.
type: concept
tags: [testing, e2e, engine, chat, hub, functional, parity]
last_reviewed: 2026-06-10
---

# Engine chat E2E suite

End-to-end **functional** tests that drive the [[engine-framework|Writer Engine]] through its **chat interface** — the
same path a real user hits when `HUB_BACKEND=engine`. This is the engine-era rewrite of the repo's n8n-era
`regressiontest_prompts.md` (R01–R121): every test here is a chat command, mapped to the engine hub's catalog op,
with concrete pass/fail criteria.

- **Sibling pages:** [[engine-api-system-tests]] tests the engine **API directly** (per-step contract, orchestrated
  E2E, SSE, load). This page tests the **user-facing chat → hub → router → dispatch → job → DB/email** loop.
  [[regression-tests]] is the n8n-era R-test list; [[e2e-tests]] is Playwright UI. Test conventions: [[test-conventions]].
- **Source of truth for routing:** `engine/packages/writer_engine/src/writer_engine/hub/catalog.py` (20 ops).
- **Source of truth for gaps:** CR-010 (`writers-workbench/docs/change-requests/CR-010-engine-parity-completion-ui-wiring-and-multi-engine-scale.md`).

## How to run

Two equivalent drive points:

1. **As the end user (preferred):** the Workbench **chat drawer** (and the action buttons wired to the hub —
   see [[chat-and-eve]]). Requires `HUB_BACKEND=engine` on the WritersWorkbench service (DEV: set, live).
   Heavy ops return immediately ("Queued…") and the UI background-polls; results refetch on completion.
2. **Headless (CI / scripted):** POST the gateway hub directly:

   ```
   SEC=$(railway variables --service writer-engine-gateway --json | python3 -c "import json,sys;print(json.load(sys.stdin)['SERVICE_SHARED_SECRET'])")
   curl -X POST https://writer-engine-gateway-develop.up.railway.app/internal/hub \
     -H "x-service-secret: $SEC" -H 'content-type: application/json' \
     -d '{"message":"<chat command>","user_id":"+14105914612"}'
   ```

   Or through the server proxy (what the UI uses): `POST /api/chat/proxy` `{user_message_request, user_id}`.

### Response contract (what to assert on)

The hub returns a `kind` that determines verification:

| `kind` | Meaning | How to verify |
|---|---|---|
| `reply` | plain conversation, no tool | assert no `tool`/`job_id`; text answer present |
| `data` | **info** op ran synchronously | assert `tool.op` + `data` payload (list/retrieve/lifecycle result) |
| `queued` | **task** op enqueued | assert `job_id`; poll `GET /api/jobs/engine/{job_id}` (or gateway `/internal/write/jobs/{id}`) until `status==complete`; then verify the DB row + the CR-009 task-completion email |

- **Info ops** (`library.*`, `story_bible.list`, `media.scrape-url`) → `kind:data`, inline.
- **Task ops** (everything else) → `kind:queued` + `job_id`. A completed task emails the result (CR-009;
  recipient from `users_v2.email` / `app_config`). Cancel via `POST /api/jobs/engine/{id}/abort` (commit `dae99d7`).
- **DEV data:** Supabase `gvbvwcnmjkdpclcisqrr`; Burial Mound `62cc734f-c861-4210-bc12-e9ea002fcf66`,
  user `+14105914612`. **Never run against PROD** (`faklxfakgzkpkbxfihzh`).

### Pass criteria

A test passes when **all** its checkboxes are met: correct route (`tool.op` + `kind`), the job reaches
`complete` (for tasks), the expected DB row/state exists in the V2 tables, and — for task ops — the
completion email arrives. A test that routes to a **known-gap** op (Section 9) "passes" when it degrades
exactly as documented (no fake success).

---

## Coverage matrix — every engine catalog op

| Engine op | kind | Tests |
|---|---|---|
| `library.list-outlines` | info | E01, E30, E31 |
| `library.retrieve` | info | E02, E32, E33 |
| `library.lifecycle` (approve/publish/reject/schedule) | info | E34–E37 |
| `story_bible.list` | info | E20 |
| `media.scrape-url` | info | E40 |
| `chapter.plan` (chapter outline) | task | E10, E50–E53 |
| `chapter.write` | task | E11, E60–E63 |
| `chapter.rewrite` | task | E12 |
| `chapter.repair` (Fix Drift) | task | E13 |
| `chapter.qa` | task | E14 |
| `chapter.blog` | task | E15 |
| `chapter.short-story` (write) | task | E16 |
| `brainstorm.story` | task | E03, E54–E57 |
| `brainstorm.short-story` | task | E04 |
| `brainstorm.revise-outline` | task | E70, E72 |
| `brainstorm.edit-outline` | task | E71 |
| `brainstorm.create-project` | task | E05 |
| `research.run` | task | E17 |
| `media.cover-art` | task | E18, E80 |
| `media.social-posts` | task | E19 |
| **Known gaps (no working op)** | — | E90–E96 |

---

## Section 1 — Routing & info ops (E01–E05)

### E01 — Conversation degrades cleanly (no tool)
Command: `Hi Eve, what can you help me with?`
- [ ] `kind:reply`, no `tool`/`job_id`
- [ ] Plain helpful answer (router didn't force a tool)

### E02 — Retrieve a project by title
Command: `Pull up the outline for The Burial Mound`
- [ ] `kind:data`, `tool=library.retrieve`
- [ ] payload has the project's outline (premise/chapters)

### E03 — Brainstorm a new book outline
Command: `Brainstorm a post-apocalyptic story called "The Seed Vault" about the last botanist protecting the Svalbard seed vault from raiders. Themes: preservation, sacrifice, legacy. 6 chapters. Genre slug: post-apocalyptic.`
- [ ] `kind:queued`, `tool=brainstorm.story`, `job_id` returned
- [ ] job → `complete`
- [ ] `writing_projects_v2` row created with `outline` JSONB (title, premise, themes, characters, 6 chapters)
- [ ] completion email arrives with the outline

### E04 — Brainstorm a short-story (3-beat)
Command: `Brainstorm a short story about a robot that learns to paint. Genre slug: ai-marketing.`
- [ ] `kind:queued`, `tool=brainstorm.short-story`
- [ ] job → `complete`; outline saved; email arrives

### E05 — Create an empty project
Command: `Create a new empty book project called "Test Harness Project" in the post-apocalyptic genre.`
- [ ] `kind:queued`, `tool=brainstorm.create-project`
- [ ] `writing_projects_v2` row exists (empty/placeholder outline)

---

## Section 2 — Chapter pipeline (E10–E16)

### E10 — Chapter outline (plan)
Command: `Chapter outline for chapter 1 of The Seed Vault`
- [ ] `kind:queued`, `tool=chapter.plan`
- [ ] job → `complete`; `writing_projects_v2.outline.chapters[0].chapter_outline.sub_chapters` populated
- [ ] **Uses genre + writer's guidelines + writing-craft guideline** in the prompt (per user requirement)

### E11 — Write a chapter
Command: `Write chapter 1 of The Seed Vault. Genre slug: post-apocalyptic.`
- [ ] `kind:queued`, `tool=chapter.write`
- [ ] job → `complete`; `published_content_v2` row (content_type=chapter, chapter_number=1)
- [ ] `content_versions_v2` snapshot written; drift/QA stamped (`chapter_qa_v2`, CR-005)
- [ ] completion email with word count + aligned + tokens/cost (CR-007/CR-009)

### E12 — Rewrite a chapter
Command: `Rewrite chapter 1 of The Seed Vault following the outline exactly.`
- [ ] `kind:queued`, `tool=chapter.write` or `chapter.rewrite` (both produce a new draft)
- [ ] job → `complete`; chapter `updated_at` bumped; new `content_versions_v2` snapshot

### E13 — Fix Drift (repair)
Precondition: a chapter with `chapter_qa_v2.aligned=false`.
Command: `Fix the drift in chapter 2 of The Burial Mound`
- [ ] `kind:queued`, `tool=chapter.repair`
- [ ] job → `complete`; re-scan flips `aligned=true`; `published_content.metadata.drift_report` updated
- [ ] **Cancel works:** issuing `POST /api/jobs/engine/{id}/abort` mid-run aborts (queued→dropped, running→cancelled), DB left consistent (commit `dae99d7`)

### E14 — Chapter QA
Command: `Run a Q/A check on chapter 1 of The Seed Vault`
- [ ] `kind:queued`, `tool=chapter.qa` (it is a **task** — queued, not blocking)
- [ ] job → `complete`; `metadata.qa_report` / `chapter_qa_v2` updated

### E15 — Blog post
Command: `Write a blog post for the post-apocalyptic genre. Topic: "Why Post-Apocalyptic Fiction Matters in 2026". Keywords: climate fiction, survival. Target length: 1200 words.`
- [ ] `kind:queued`, `tool=chapter.blog`
- [ ] job → `complete`; `published_content_v2` (content_type=blog_post); email arrives
- [ ] Writing Prime Directive honored (no "revolutionize/game-changing/unleash/delve")

### E16 — Short story (write)
Command: `Write a short story. Genre slug: historical-time-travel. Premise: a historian discovers antique photographs transport her to the moment they were taken. Tone: literary. Length: 2000 words.`
- [ ] `kind:queued`, `tool=chapter.short-story`
- [ ] job → `complete`; `published_content_v2` (content_type=short_story); email arrives

---

## Section 3 — Research, image, social (E17–E19)

### E17 — Research a topic → report
Command: `Research the current state of post-apocalyptic fiction in 2026 with citations.`
- [ ] `kind:queued`, `tool=research.run` (engine research is a queued task that saves a report)
- [ ] job → `complete`; `research_reports_v2` row; email with cited report
- [ ] NOTE: engine has no in-chat inline Perplexity answer (n8n `deep_research_topic`); it produces a saved report instead

### E18 — Generate cover art
Command: `Generate cover art for The Burial Mound based on its premise.`
- [ ] `kind:queued`, `tool=media.cover-art`
- [ ] job → `complete`; `generated_images_v2` row (image_type=cover_art) + file in `cover-images` bucket
- [ ] image appears in the project **Art** gallery (query `['generated-images']`)

### E19 — Repurpose to social
Command: `Repurpose The Seed Vault into Twitter posts.`
- [ ] `kind:queued`, `tool=media.social-posts`
- [ ] job → `complete`; posts returned/emailed; platform respected

---

## Section 4 — Story bible + scrape (E20, E40)

### E20 — Story bible (read)
Command: `Show the story bible for The Burial Mound`
- [ ] `kind:data`, `tool=story_bible.list`
- [ ] character/location/event entries returned
- [ ] NOTE: **adding/updating** a bible entry from chat is NOT routable yet (see E94)

### E40 — Scrape a URL
Command: `Scrape the text of https://example.com`
- [ ] `kind:data`, `tool=media.scrape-url`
- [ ] returns extracted text

---

## Section 5 — Library: list, retrieve, lifecycle (E30–E37)

### E30 — List outlines / projects
Command: `List all my outlines`
- [ ] `kind:data`, `tool=library.list-outlines`; projects with outlines listed

### E31 — List drafts
Command: `List my drafts`
- [ ] `kind:data`, `tool=library.list-outlines` (or `library.retrieve` listing); draft items returned

### E32 — Retrieve by title (found)
Command: `Find my draft about the botanist`
- [ ] `kind:data`, `tool=library.retrieve`; match returned with content_type + id

### E33 — Retrieve (not found)
Command: `Find my draft about quantum surfing on Jupiter`
- [ ] `kind:data`, `tool=library.retrieve`; `found:false`, graceful (no crash)

### E34 — Approve
Command: `Approve the draft titled "<title from E31>"`
- [ ] `kind:data`, `tool=library.lifecycle` (action=approve)
- [ ] `published_content_v2.status=approved`; `content_versions_v2` snapshot
- [ ] GAP CHECK: confirm whether an approval **email** is sent (n8n sent one; engine lifecycle email is a CR-010 B2 item — record actual)

### E35 — Publish
Command: `Publish the content titled "<same title>"`
- [ ] `tool=library.lifecycle` (action=publish); `status=published`, `published_at` set; snapshot

### E36 — Reject
Command: `Reject the draft titled "<other title>"`
- [ ] `tool=library.lifecycle` (action=reject); `status=rejected`

### E37 — Schedule
Command: `Schedule the draft titled "<title>" for 2026-07-01`
- [ ] `tool=library.lifecycle` (action=schedule); `status=scheduled`, `metadata.schedule_date` set
- [ ] Cron scheduled-publisher later flips it to published (verify separately)

---

## Section 6 — Genre + story-arc matrix (E50–E57)

Run the **brainstorm → chapter-plan → write** loop across genres and arcs. Each row: brainstorm with the arc,
confirm `arc_notes` use the arc's beats, then write and confirm the prose follows them.

| ID | Command (brainstorm) | Genre | Arc | Pass: arc beats named in `arc_notes` |
|---|---|---|---|---|
| E54 | `Brainstorm a short story using Freytags Pyramid about a plague doctor in ruined Manhattan… Title: The Inoculator. 5 sections.` | post-apocalyptic | Freytag | Introduction→Rising→Climax(midpoint apex)→Falling→Catastrophe |
| E55 | `Brainstorm a book using Freytags Pyramid… Title: The Accord. 10 chapters. Genre: political-scifi.` | political-scifi | Freytag | 10 chapters mapped to 5-act pyramid; fatal flaw in Act 1 |
| E56 | `Brainstorm using the Three-Act Structure… Title: Signal from the Deep. 5 sections. Genre: post-apocalyptic.` | post-apocalyptic | Three-Act | Setup(25%)/Confrontation(50%, midpoint setback)/Resolution(pre-climax→climax→denouement) |
| E57 | `Brainstorm a book using the Three-Act Structure… Title: The Correction. 10 chapters. Genre: historical-time-travel.` | historical-time-travel | Three-Act | midpoint ≠ climax; pre-climax false resolution present |

Per row:
- [ ] `tool=brainstorm.story` with the arc name extracted into params (Gemini router)
- [ ] outline saved to `writing_projects_v2`; `arc_notes` use the **named** arc terminology (not generic)
- [ ] write loop (E60-style) produces sections/chapters that follow the same beats

Genre breadth (run E15/E16/E18 across these slugs at least once each): `post-apocalyptic`, `political-scifi`,
`historical-time-travel`, `ai-marketing`, `political-history`, `ancient-history`, `metaphysical-romance`,
`scifi-romance`. Pass: tone + cover-art style match the genre; no `[undefined]` in title/subject.

### E50–E53 — chapter.plan across arcs
For each brainstormed project above, `Chapter outline for chapter 1 of <title>` →
- [ ] `tool=chapter.plan`; sub-chapters generated; dual-arc (book beat + chapter beat) present

### E60–E63 — write from stored outline
`Write chapter 1 of <title>. Genre slug: <slug>.` (no brief/outline passed) →
- [ ] `tool=chapter.write`; engine auto-loads `writing_projects_v2.outline`
- [ ] chapter follows the arc's beat for ch1; characters match the outline; bible entries created

---

## Section 7 — Prologue & Epilogue (E70–E72)

### E70 — Revise outline to add prologue + epilogue
Command: `Revise the outline of The Accord to add a Prologue and an Epilogue.`
- [ ] `kind:queued`, `tool=brainstorm.revise-outline`
- [ ] job → `complete`; outline gains Prologue (number 0) + Epilogue; previous outline snapshotted to `outline_versions_v2`

### E71 — Small targeted edit
Command: `In The Accord, change the diplomat's age to 47.`
- [ ] `kind:queued`, `tool=brainstorm.edit-outline` (NOT revise/brainstorm)
- [ ] only the named field changes; other fields preserved; snapshot written

### E72 — Write the prologue
Command: `Write the prologue of The Accord. Genre slug: political-scifi.`
- [ ] `tool=chapter.write` with chapter_number=Prologue (0)
- [ ] `published_content_v2` row labeled Prologue; email arrives

---

## Section 8 — Cover art → Art gallery, end to end (E80)

### E80 — Generate Cover Art button (Book Overview)
Driven from the UI button (commit `e7561d7`) **and** chat (E18).
- [ ] click queues (`media.cover-art`) and **returns immediately** ("Queued — generating…"); UI not blocked
- [ ] on completion the Art gallery refetches (`['generated-images']`) and shows the new cover
- [ ] can generate **multiple** covers (button re-enables); each adds a row; one is selectable at publish

---

## Section 9 — Known gaps: must degrade, not fake success (E90–E96)

These exercise functions that exist in n8n but are **stub / removed / not routable** in the engine (CR-010).
A test passes when it degrades **exactly** as documented — never a silent fake success.

### E90 — Format for Kindle (REMOVED from engine)
Command: `Format The Burial Mound for Kindle`
- [ ] `kind:reply` (degrades to conversation) — `chapter.format-kindle` was removed (commit `6c74d08`)
- [ ] correct canonical path: the **Export tab** → `POST /api/export/docx` (server-side `docx`), not the engine
- [ ] PASS = no fake `docx_storage_path`, no error route

### E91 — Newsletter via chat (NOT a hub op)
Command: `Write a newsletter for the ai-marketing genre.`
- [ ] no `newsletter` catalog op → degrades to conversation OR misroutes; **record actual**
- [ ] canonical path: the Newsletter UI / durable saga (`/newsletter/generate`), not the chat hub (CR-010 note)

### E92 — Eve knowledge callback (PLACEHOLDER)
Command (or Eve voice "read me X"): triggers `notify.eve-callback`
- [ ] engine op is a placeholder — returns `{routed_via}` only; **no** ElevenLabs KB upload / outbound call (CR-010 A1)
- [ ] PASS = documented placeholder behavior; pointing the PROD Eve agent at the webhook is baseline-protected

### E93 — Library versions / revert from chat (NOT routable)
Command: `Show version history for The Accord` / `Revert the outline of The Accord to version 1`
- [ ] no engine op routes version-list / revert-outline / revert-chapter (CR-010 A2) → degrades
- [ ] (UI does versions via direct Supabase; chat/Eve cannot yet)

### E94 — Story bible update from chat (NOT routable)
Command: `Add a character named Kessik to The Burial Mound story bible.`
- [ ] only `story_bible.list` is routable; add/update degrades (CR-010 A2)

### E95 — "Email me X" on demand (MISSING op)
Command: `Email me the outline for The Burial Mound`
- [ ] no `library.email-content` op → degrades (CR-010 A2). (CR-009 emails fire on *generation*, not on demand.)

### E96 — Embeddings / semantic retrieval grounding (OFF)
- [ ] `ENABLE_PYTHON_EMBEDDINGS=false`; nothing triggers `re_embed_project`; `chapter.write` does **not**
  retrieve from `writing_embeddings_v2` (CR-010 A2). Quality-parity gap — record chapter canon-grounding behavior.

---

## Non-blocking & queue behavior (cross-cutting)

For every task op driven from a **button** (Outline/Re-outline, Write/Rewrite, Q/A, Fix Drift, Cover Art):
- [ ] click **queues and returns immediately** (UI free to fan out across many chapters) — `useEngineJobQueue` (commit `e7561d7`)
- [ ] background poll flips the row to ✓ / refetches the relevant React Query keys on completion
- [ ] Fix Drift row shows a **Cancel** once "Queued — fixing…" (commit `dae99d7`)

## Maintenance

- Keep the coverage matrix in lockstep with `hub/catalog.py`. When an op is added/removed, add/remove its E-test.
- When a CR-010 gap is closed, move its E9x test from Section 9 into the functional sections with real pass criteria.
- Genre list tracks MEMORY.md "Genres (8 active)".
