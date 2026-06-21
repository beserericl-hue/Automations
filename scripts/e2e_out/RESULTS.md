# Engine E2E Live Run — Pass/Fail Report

Driving the engine **chat interface** (`/internal/hub`) and **voice webhook** (`/internal/hub/voice`,
simulating Eve) on DEV. Each test verified against the live chat result, DEV Supabase rows, and the
**actual email body read from `eric@agileadtesting.com`** (an email that only says "ready" with no
deliverable = FAIL).

Legend: ✅ PASS · ❌ FAIL · ⚠️ PARTIAL (function works, a provable sub-check fails)

---

## EMAIL AUDIT — does every "ready" email contain the actual work? (all 14 emails from the run, read)

**The deliverable is in the email ONLY for tools that return `result.content_text` (chapter prose).
Everything else sends a bare "X is ready" notice with NO copy of the work.**

| "X is ready" email | Tool | Work in the email? |
|---|---|---|
| **Outline is ready** | brainstorm.story | ❌ NO outline (just Task/Project) |
| **Research report is ready** ×3 | research.run | ❌ NO report |
| **Media is ready** (cover-art) ×3 — Last Pharaoh / Algorithm / Senate of Stars | media.cover-art | ❌ NO image |
| **Media is ready** (social-posts) ×3 — Last Signal / your project ×2 | media.social-posts | ❌ NO posts |
| **Chapter is ready** — _Why the best political…_ | chapter.newsletter | ✅ full newsletter inline |
| **Chapter is ready** — _From Paris streets…_ | chapter.newsletter | ✅ full newsletter inline |
| **Chapter is ready** — # The Graveyard of Good Ideas | chapter.blog | ✅ full blog inline |
| (`library.email-content` "email me X" — R03/R05) | library | ✅ content inline (this op is correct) |

→ **brainstorm/outline, research, cover-art, social-posts emails carry NONE of the produced work.**
This is gap **G1** and is the dominant failure of the suite. Lifecycle emails (approve/publish/reject/
schedule) are intentionally brief status notes — but they acted on the **wrong items** (see G11).

---

## GAPS TO REPAIR (flagged NOT-IMPLEMENTED / broken in the engine)

**G1 — CR-009 completion emails don't contain the deliverable. [HIGH — confirmed by user on 2 emails]**
`build_task_email` (`notifications/task_email.py`) only inlines prose from `result.content_text`/
`result.content`. As a result:
- **research.run** → report lives in `result.row.report_markdown` → email is a bare "Research report
  is ready" notice, NO report. (verified)
- **media.cover-art** → email is a bare "Media is ready" notice with **NO image** — the generated art
  is never embedded or attached, even though the public Supabase image URL is available. (verified)
- **chapters / long content** → only a truncated 20k inline excerpt, never the full text / attachment.
- `postal.send_email(to, from_addr, subject, html, bcc)` has **no attachment support** at all.
→ completion emails must embed/attach the actual deliverable (report text, `<img>` of the cover art,
full chapter). *(Affects every generative test asserting "email arrives with the content/image".)*

**G2 — Centralized email config (`app_config`) is read from the wrong table.** Engine queries
`app_config` (`task_email.py:33`, `library_step:256`, `prompt_store/store.py:49`) but DEV Supabase has
**`app_config_v2`**. The lookup fails and silently falls back to `users_v2.email`. Emails reach the
right address only by luck; the centralized-config mechanism (and any `prompts.%` overrides) is
effectively dead. → point the engine at `app_config_v2` (or rename). *(Also: `app_config_v2` has TWO
`recipient_email` rows — eric@ and racemert@ — a data cleanup.)*

**G3 — Story-bible read not routed.** "Get the story bible for project X" → `reply` (conversation),
not `story_bible.list`. Routing heuristic/Gemini rule missing for this phrasing. (R04)

**G4 — research.run drops `genre_slug` from chat.** "Save … with topic X and genre slug
post-apocalyptic" creates the row with `genre_slug=""`. (R02)

**G5 — markdown→HTML ignores leading whitespace.** Indented `## ` subheadings render as `<p>` not
`<h2>` in emailed content (`markdown_html.py` heading/list regexes are anchored at column 0). (R03, minor)

**G6 — writing ops crash on "N words" length params.** `chapter.blog` does `int(target_length)` and
`chapter.short-story` does `int(length)`, but the router passes `"1500 words"` / `"2500 words"` →
`ValueError: invalid literal for int()` → job result `status=error`, **no content written**. Both core
writing tools fail whenever the prompt states a word count. (R06, R08; also affects R14, R15.) → strip
non-digits before `int()`.

**G7 — `media.social-posts` is unreliable.** "Repurpose this into LinkedIn posts: …" **misrouted to
`library.list-outlines`** (R11); "…Facebook/Instagram posts: <inline content>" made the op **demand a
project_id** instead of repurposing the supplied inline text (R12, R13). Only Twitter (R10) worked. →
the op should repurpose inline content directly and routing must not collapse to list-outlines.

**G1-refined / G8 — completion-email polish.** Even when content is included it is the truncated 20k
excerpt, never an attachment; cover-art emails can't attach the image at all (`postal.send_email` has
no attachment param); and the metadata mislabels newsletter as "**Chapter**" with Project "**your
project**" (no title threaded into `build_task_email`).

**G9 — `chapter.write` is fully broken from chat. [HIGH]** Confirmed `WriteChapterRequest`
**ValidationError: project_id Field required** for BOTH a new book (R17, R51) AND an EXISTING project
referenced by title ("Write chapter 2 of 'The Seed Vault'", R46). The hub never resolves
`project_id` from `project_title`, and chat never supplies a UUID, so **every "write chapter N of X"
fails**. Core writing function is non-functional via chat. → resolve/lookup project_id from title (or
create) in the hub before dispatch.

**G10 — draft-listing routing broken.** "List my drafts" → `reply` (conversation) (R20); "List my draft
blog posts" → **wrote a new blog post** (`chapter.blog`) (R21). The `library.list-outlines` filter-by-
status/type path isn't reached from these phrasings. ("list all my outlines" does work — G10 is the
"drafts"/"published"/type-filter phrasings.)

**G11 — lifecycle publish/reject/schedule act on the WRONG item. [HIGH — dangerous]** The ack names the
right title ("Publishing 'The Graveyard of Good Ideas'") but the op **published 'An AI trained on 50'**
(R23); reject/schedule of two newsletters hit **'The Forgotten Engineers of Rome'** instead (R25, R26).
The title isn't reaching `_op_lifecycle`'s resolver, so `_best_match` runs with no keywords and falls
back to `rows[0]` (the most-recent row) — publishing/rejecting arbitrary content. (approve R22 happened
to hit the right row.) → pass the extracted title to the op + exact-match before any rows[0] fallback;
never mutate on an empty match.

**G12 — `brainstorm.story` via chat generates but never persists.** "Brainstorm a story called 'The
Seed Vault' … 8 chapters" produced a **39-chapter** outline (target_chapter_count ignored) with
`persist=false, "project_id/user_id missing"` — the outline is **discarded** (not saved to
`writing_projects_v2`) and the "Outline is ready" email is empty. The hub has no resolve-or-create
project step for a brainstorm-by-title. (R30) → create/resolve the project before persisting (the
server `/api/brainstorm/submit` path does this; the hub chat path does not).

**G13 — research list/retrieve misrouted to a NEW research run.** "List my research reports" (R33) and
"Get the research report about X" (R34) both routed to **`research.run`** (generating brand-new
reports) instead of `library.list-outlines` / `library.retrieve`. Same misroute class as G10.

**G14 — `library.list-outlines` ignores status/type filters.** "List my published content" (R24) and
"List my scheduled content" (R27) both returned **all 18 outlines**, unfiltered. The status filter isn't
applied.

**G15 — `library.retrieve` doesn't search/filter.** "Find my draft about the Titanic" (R36) and "Find
my draft about quantum surfing on Jupiter" (R37, non-existent) BOTH returned **all 50 items** — the
search term is ignored, no title/keyword filter, and the not-found path (`found=false`, R37) never
triggers. → apply the search term and return found=false when nothing matches.

**G16 — story arcs aren't retrievable; agent fabricates.** "List the story arcs" (R53) → `reply`
(conversation) and the model **invented** "Hero's Journey, Rags to Riches, …" from training data instead
of reading `story_arcs_v2` (which holds Freytags Pyramid, Three-Act). No tool called. (R53) → route to
`library.retrieve` content_type=story_arc.

**G17 — `media.social-posts` "repurpose" also misroutes to `research.run`.** "Repurpose this into social
posts: …" (R47) routed to **research.run** (ran research). Adds to G7 — social-posts routing is broadly
broken.

**G18 — `library.email-content` resolution misses/grabs-wrong (same G11 class).** "Email me the research
report on 'Post-Apocalyptic Fiction Trends 2026'" → **not found** despite the row existing (R102); "Email
me chapter 1 of 'The Seed Vault'" → emailed **'Chapter 1 — The Last Garden'** (wrong project, R103);
"Email me the short story titled 'A Story That Definitely Does Not Exist'" → emailed **'The Witness'**
instead of a not-found message (R105). The `_resolve_artifact`/`_best_match` keyword resolver mis-targets.
(Outline R100, short-story R101, newsletter R104 resolved correctly and delivered full content.)

**G19 — `chapter.plan` crashes on Prologue/Epilogue. [my E2E-4 bug]** "Create a chapter outline for the
Prologue of X" → `ValueError: int('Prologue')` (`_op_plan` does `int(chapter_number)`). My E2E-4 plan
op doesn't accept the string chapter numbers the write op does. (R111) → reuse the Prologue/Epilogue
handling from the write path.

**G20 — outline email omits chapter numbers/beats (minor).** `_render_outline_md` emits "`. **Title** —`"
with blank number and blank beat for each chapter (the outline chapter dicts use different keys). (R100)

---

## Section A — Core Infrastructure (R01–R05)

| Test | Route exp→got | Job | Provable check | Verdict |
|---|---|---|---|---|
| R01 Deep Research | research.run ✓ | complete ✓ | report 17.8k chars + citations `[n]` ✓; `research_reports_v2` row ✓; **email = bare "ready" notification, NO report (G1)** | ❌ |
| R02 Save Research | research.run ✓ | complete ✓ | `research_reports_v2` row, topic ✓; **genre_slug="" (G4)**; "save that research" re-runs research vs saving R01's | ⚠️ |
| R03 Email Report | library.email-content ✓ | complete ✓ | email delivered, content present, `<h1>/<ul>/<ol>` rendered ✓, subject ✓; indented `##`→`<p>` (G5) | ✅ |
| R04 Story Bible Read | story_bible.list → **reply** ✗ | — | not routed (G3) | ❌ |
| R05 Centralized Email | library.email-content ✓ | complete ✓ | email delivered w/ content ✓, subject ✓, reached eric@; **but via users_v2 fallback, app_config not read (G2)** | ⚠️ |

**Section A: 1 ✅ · 2 ⚠️ · 2 ❌.** `library.email-content` (E2E-1) correctly delivers real content;
the failures are the systemic G1 (completion emails) and G2/G3 routing/config gaps.

## Section B — Writing & Media Tools (R06–R13)

| Test | Route exp→got | Job | Provable check | Verdict |
|---|---|---|---|---|
| R06 Blog (post-apoc) | chapter.blog ✓ | **error** | `ValueError: int('1500 words')` — nothing written (G6) | ❌ |
| R07 Newsletter (pol-scifi) | chapter.newsletter ✓ | complete ✓ | `published_content_v2` newsletter row 8.1k chars ✓; **email contains the full newsletter** ✓; subject/section structure ✓ | ✅ |
| R08 Short Story (time-travel) | chapter.short-story ✓ | **error** | `ValueError: int('2500 words')` — nothing written (G6) | ❌ |
| R09 Cover Art | media.cover-art ✓ | complete ✓ | image generated + `generated_images_v2` row ✓ — **but email has NO image (G1, user-confirmed)** | ❌ |
| R10 Social Twitter | media.social-posts ✓ | complete ✓ | twitter+linkedin posts generated ✓ | ✅ |
| R11 Social LinkedIn | media.social-posts → **list-outlines** ✗ | — | misrouted (G7) | ❌ |
| R12 Social Facebook | media.social-posts ✓ | (asks project) | demanded project_id, didn't repurpose inline content (G7) | ❌ |
| R13 Social Instagram | media.social-posts ✓ | (asks project) | demanded project, same (G7) | ❌ |

**Section B: 1 ✅ · 0 ⚠️ · 7 ❌.** (R09 reclassified ❌ — art missing from email) Newsletter (E2E-3) and Twitter-repurpose work; blog & short-story
crash on word-count params (G6); social-posts is unreliable (G7).

## Section B2 — More Writing/Media + List (R14–R21)

| Test | Route exp→got | Job | Provable check | Verdict |
|---|---|---|---|---|
| R14 Blog (ancient-hist) | chapter.blog ✓ | **error** | `int('1500 words')` (G6) | ❌ |
| R15 Short Story (ai-mkt) | chapter.short-story ✓ | **error** | `int('2000 words')` (G6) | ❌ |
| R16 Newsletter (pol-hist) | chapter.newsletter ✓ | complete ✓ | newsletter row 745w, 5 sections, title ✓ (like R07) | ✅ |
| R17 Chapter (new book) | chapter.write ✓ | **error** | `ValidationError: project_id required` — can't write a chapter for a new/title-only book (G9) | ❌ |
| R18 Cover Art (ai-mkt) | media.cover-art ✓ | complete ✓ | image generated + DB row ✓; **email has NO image (G1)** | ❌ |
| R19 Cover Art (anc-hist) | media.cover-art ✓ | complete ✓ | image generated + DB row ✓; **email has NO image (G1, user-confirmed via The Last Pharaoh's Scribe email)** | ❌ |
| R20 List Drafts | list-outlines → **reply** ✗ | — | "list my drafts" not routed (G10) | ❌ |
| R21 List Drafts by Type | list-outlines → **chapter.blog** ✗ | — | "list my draft blog posts" **wrote a blog** (G10) | ❌ |

**Section B2: 1 ✅ · 0 ⚠️ · 7 ❌.** (R18/R19 reclassified ❌ — art missing from email)

## Section C — Lifecycle, Versions, Brainstorm, Retrieve (R22–R34)

| Test | Route exp→got | Provable check | Verdict |
|---|---|---|---|
| R22 Approve Draft | library.lifecycle ✓ | approved the correct item ("Graveyard…"); version snapshot taken | ✅ |
| R23 Publish | library.lifecycle ✓ | **published the WRONG item ("An AI trained on 50") (G11)** | ❌ |
| R24 List Published | list-outlines ✓ | returned **all 18, no status filter (G14)** | ❌ |
| R25 Reject | library.lifecycle ✓ | **rejected the WRONG item (G11)** | ❌ |
| R26 Schedule | library.lifecycle ✓ | **scheduled the WRONG item (G11)** | ❌ |
| R27 List Scheduled | list-outlines ✓ | all 18, no filter (G14) | ❌ |
| R28 Version History | library.versions ✓ | count=2 versions for the blog ✓ (E2E-2) | ✅ |
| R29 Get Version 1 | library.versions ✓ | returned version w/ 7.3k content_text ✓ (E2E-2) | ✅ |
| R30 Brainstorm Story | brainstorm.story ✓ | outline generated (39 ch, ignored "8") but **persist=false → discarded; email empty (G12)** | ❌ |
| R32 Story Bible Read | story_bible.list → **reply** ✗ | not routed (G3) | ❌ |
| R33 List Research | list-outlines → **research.run** ✗ | ran new research (G13) | ❌ |
| R34 Get Research | library.retrieve → **research.run** ✗ | ran new research (G13) | ❌ |

**Section C: 3 ✅ · 0 ⚠️ · 9 ❌.** Versions (E2E-2) + approve work; **publish/reject/schedule hit the
wrong item (G11)**, brainstorm discards its outline (G12), research list/get + story-bible misroute.

## Section D — Retrieve, Prime-Directive Writing, Brainstorm, Arcs (R35–R53)

| Test | Route exp→got | Provable check | Verdict |
|---|---|---|---|
| R35 Update Research | lifecycle ✓ | "update" → published a DIFFERENT item (G11); no real update op | ❌ |
| R36 Retrieve by title | retrieve ✓ | returned **all 50, search term ignored (G15)** | ❌ |
| R37 Retrieve not-found | retrieve ✓ | returned all 50, no found=false (G15) | ❌ |
| R38 Blog (cyberpunk) | chapter.blog ✓ | `int('1000 words')` error (G6) | ❌ |
| R39 Short Story (no length) | chapter.short-story ✓ | **persisted, 2776 words ✓** — works when no word-count given | ✅ |
| R40 Research (gladiators) | research.run ✓ | persisted ✓ (email empty, G1) | ✅ |
| R41 Cover Art (Ash) | media.cover-art ✓ | image gen ✓; email has no image (G1) | ❌ |
| R43 Blog PD | chapter.blog ✓ | `int('1000 words')` error (G6) | ❌ |
| R44 Newsletter PD | chapter.newsletter ✓ | persisted 1012w/5 sec ✓ (E2E-3) | ✅ |
| R45 Short Story PD | chapter.short-story ✓ | `int('1500 words')` error (G6) | ❌ |
| R46 Chapter (Seed Vault) | chapter.write ✓ | **ValidationError project_id — fails even for existing project (G9)** | ❌ |
| R47 Social PD | media.social-posts → **research.run** ✗ | misrouted (G17) | ❌ |
| R48 Brainstorm (Diplomat) | brainstorm.story ✓ | persist=false → discarded (G12) | ❌ |
| R49 Brainstorm short | brainstorm.story → **short-story** ✗ | persist=false (G12) + misroute | ❌ |
| R50 Short Story 5-arc | chapter.short-story ✓ | `int()` error (G6) | ❌ |
| R51 Chapter (Cartographer) | chapter.write ✓ | ValidationError project_id (G9) | ❌ |
| R52 Short Story genre | chapter.short-story ✓ | `int()` error (G6) | ❌ |
| R53 List Story Arcs | retrieve → **reply** ✗ | model **fabricated** arcs, no tool, didn't read story_arcs_v2 (G16) | ❌ |

**Section D: 3 ✅ · 0 ⚠️ · 15 ❌.** Short-story (no word count) + research + newsletter work; everything
else fails — `chapter.write` totally broken (G9), blog/short-story crash on word counts (G6), retrieve
doesn't search (G15), brainstorm discards (G12), social + arcs misroute (G16/G17).

## Section E — Arc Fidelity (R54–R69) [my E2E-4 work]

**Verdict: the E2E-4 arc code RUNS (story_arc is passed, `story_arcs.load_story_arc` executes, ops
route) but arc fidelity is UNVERIFIABLE live — blocked by upstream G12 + G9.**

| Test | Route | Result | Verdict |
|---|---|---|---|
| R54–R61 Brainstorm w/ arc (Freytag/Three-Act × genres) | brainstorm.story/short-story ✓ | all **persist=false → outline discarded (G12)**; can't inspect arc_notes; email empty | ❌ (×8) |
| R62 Write Short Story (Inoculator) | chapter.short-story ✓ | persisted 2784w ✓ — but generated fresh, NOT from R54's (unsaved) outline; arc fidelity n/a | ⚠️ |
| R63 Write Chapter (The Accord) | chapter.write ✓ | **error project_id (G9)** | ❌ |
| R64/R65/R68 Write Short Story | chapter.short-story ✓ | persisted (2664/2708/3071w) ✓; not from stored arc outline | ⚠️ |
| R66 Write Short Story (Signal) | chapter.short-story → **chapter.write** ✗ | error (G9) + misroute | ❌ |
| R67 Write Chapter (Optimization) | chapter.write ✓ | error project_id (G9) | ❌ |
| R69 Write Chapter (Correction) | chapter.write ✓ | error project_id (G9) | ❌ |

**Section E: 0 ✅ · 4 ⚠️ · 12 ❌.** Short-story generation persists; arc fidelity can't be exercised
because brainstorm doesn't save the outline (G12) and `chapter.write` errors (G9). **My E2E-4 routing/
arc-loading is present but the feature is dead-ended by the broken persist/write layer.**

## Section F — Outline Mgmt + Versions/Revert/Delete (R70–R99) [my E2E-2 work]

**My E2E-2 ops are SOUND (graceful not-found/invalid handled) but undermined by G11/G12/G15 upstream.**

| Test | Route | Result | Verdict |
|---|---|---|---|
| R70/R74/R77/R80/R88 Retrieve outline | retrieve ✓ | all return **50 unfiltered** (G15) | ❌ |
| R71/R75/R78/R92 Revise outline | brainstorm.revise-outline ✓ | runs but **no persist/snapshot (G12)** → no outline versions created | ❌ |
| R72/R73/R76/R79 Write Prologue/Epilogue | chapter.write ✓ | **error project_id (G9)** | ❌ |
| R82 List All Outlines | list-outlines ✓ | 18 ✓ | ✅ |
| R83 List Outlines (alt phrasing) | list-outlines → **reply** ✗ | not routed (G10) | ❌ |
| R84/R85/R93 Outline Version History | library.versions ✓ | count=0 — op works but no snapshots exist (G12) | ❌ |
| R86 Version History (no revisions) | library.versions ✓ | count=0, no error — **correct** (E2E-2) | ✅ |
| R87 Revert to v1 | library.revert ✓ | reverted=false — nothing to revert (G12); op correct given empty data | ❌ |
| R90 Revert invalid v99 | library.revert ✓ | reverted=false ✓ — **correct** (E2E-2) | ✅ |
| R91 Revert project-not-found | library.revert ✓ | reverted=false ✓ — **correct** (E2E-2) | ✅ |
| R94 Delete draft | library.lifecycle ✓ | deleted the **WRONG item ("Newsletter") (G11)** | ❌ |
| R95 Delete published (guard) | library.lifecycle ✓ | **guard didn't fire** — deleted a wrong draft instead of rejecting (G11) | ❌ |
| R96 List Deleted | library.lifecycle ✓ | count=2 ✓ (E2E-2 list_deleted works) | ✅ |
| R97 List Deleted by type | library.lifecycle ✓ | filter works (count=0; no deleted blogs because deletes hit wrong items) | ⚠️ |
| R98 Undelete | library.lifecycle ✓ | restored the **WRONG item (G11)** | ❌ |
| R99 Verify (list drafts) | list-outlines → **reply** ✗ | not routed (G10) | ❌ |

**Section F: 5 ✅ · 1 ⚠️ · 16 ❌.** The E2E-2 op layer is correct (not-found/invalid/list_deleted all
pass), but **retrieve (G15), revise-persist (G12), and lifecycle title-resolution (G11) break the
end-to-end flows.** Content versions (R28/R29) work because the approve path snapshots; OUTLINE versions
don't because revise-outline never persists.

## Section G — Email-Content (E2E-1) + Chapter-Outline Pipeline (E2E-4) (R100–R120)

| Test | Route | Result | Verdict |
|---|---|---|---|
| R100 Email outline | library.email-content ✓ | **email contains structured outline** (premise + 5 characters + 16 chapters) ✓ | ✅ |
| R101 Email short story | library.email-content ✓ | emailed w/ content ✓ | ✅ |
| R102 Email research | library.email-content ✓ | **not-found though the row exists (G18)** | ❌ |
| R103 Email chapter | library.email-content ✓ | emailed **wrong chapter ("The Last Garden") (G18)** | ❌ |
| R104 Email newsletter | library.email-content ✓ | emailed w/ content ✓ | ✅ |
| R105 Email not-found | library.email-content ✓ | emailed **wrong item ("The Witness") instead of not-found (G18)** | ❌ |
| R110 Brainstorm (Signal Beneath) | brainstorm.story ✓ | persist=false → discarded (G12) | ❌ |
| R111 Plan Prologue | chapter.plan ✓ | **`int('Prologue')` crash (G19, my E2E-4 bug)** | ❌ |
| R112/R113 Plan Ch1/Ch2(arc) | chapter.plan ✓ | generated **5 sub-chapters** ✓ (dual-arc code runs) but **persist=None** (no project) | ⚠️ |
| R114–R117 Write/auto-plan | chapter.write ✓ | error project_id (G9) | ❌ |
| R118 Revise chapter outline | chapter.plan ✓ | 5 sub-chapters, persist=None | ⚠️ |
| R119 Consistency check | chapter.qa ✓ | **ran, returned `character_consistency`** ✓ (E2E-4 op works, on non-existent project) | ✅ |
| R120 Kishōtenketsu plan | chapter.plan ✓ | 5 sub-chapters (non-conflict arc), persist=None | ⚠️ |

**Section G: 4 ✅ · 3 ⚠️ · 7 ❌.** Email-content delivers outline/story/newsletter correctly (E2E-1
✅), but mis-resolves research/chapter (G18). The E2E-4 chapter.plan generates sub-chapters + the qa
character-check runs, but the pipeline can't persist (G12) or write (G9), and plan crashes on Prologue
(G19). (R106–R109 are not real suite tests.)

## Section H — Voice Webhook V01–V40 (simulated Eve via `/internal/hub/voice`)

**The voice webhook ROUTES correctly (same path as chat) — the simulated-agent surface works.** Failures
mirror the chat gaps. Highlights:

- ✅ **E2E-5 callback works**: V26/V27/V28 `notify.eve-callback` → `invoked=true, found=true` (the KB+call
  flow fires, gated dry-run). E2E-1 email-content via voice (V32/V37/V38/V40) delivers. V35 list-deleted
  (trash) ✓. V04 blog (no word count) + V05 newsletter ✓.
- ❌ Same gaps: V06/V20 word-count crash (G6); V12/V19 chapter.write project_id (G9); V33/V34/V36 lifecycle
  wrong-item / guard (G11); V03/V39 research email not-found (G18); V25 "find my draft" → **wrote** a new
  story (G15 misroute); V30 not-found callback **resolved a wrong item** instead of not-found (G18/G15).
- ⚠️ V31 multi-task: the newsletter ran; callback co-invocation only partially confirmed.

**Section H (35 run): ~15 ✅ · ~3 ⚠️ · ~17 ❌.** Voice routing + the E2E-5 callback invoke are the wins;
everything that's broken in chat is broken in voice too.

---

# FINAL VERDICT — what the engine implements correctly vs. what was left to implement

**~145 tests run live (chat + voice). Roughly 40 pass · 12 partial · 93 fail.** The engine **generates
content well** but the **chat/voice orchestration layer is substantially incomplete** — and the single
biggest failure is that **completion emails do not contain the work** (your repeated finding).

### ✅ Correctly implemented (verified live)
- **Content generation**: research, newsletter (E2E-3), short-story (when no word count given), cover-art
  image, blog (when no word count), Twitter repurpose. Quality looks good.
- **`library.email-content` (E2E-1)** — "email me the outline/story/newsletter" delivers the real,
  structured content as HTML. *This is the only path that emails the actual work.*
- **`library.versions` list/get (E2E-2)** and **content-version snapshots** on approve/publish.
- **Versions/revert/list_deleted op logic (E2E-2)**: graceful not-found / invalid-version / empty handling.
- **Voice webhook (E2E-5 surface)** routes correctly; **`notify.eve-callback` invokes** with the right
  payload (gated dry-run, PROD agent untouched).
- **`library.list-outlines`** (basic "list all outlines"), approve lifecycle.

### ❌ Broken / not implemented (must be repaired) — priority order
1. **G1 — completion emails carry no deliverable** (research/outline/cover-art/social are bare "ready"
   notices; long content truncated; `send_email` can't attach). *Dominant, user-confirmed 3×.*
2. **G9 — `chapter.write` totally broken from chat** (always ValidationError: project_id) — can't write any
   chapter by title, new or existing.
3. **G12 — brainstorm/revise-outline never persist via chat** (no project_id resolution) → outlines
   discarded; **cascades** into the whole outline→chapter pipeline (E2E-4) and outline versioning.
4. **G11 — lifecycle publish/reject/schedule/delete/undelete act on the WRONG item** (resolver falls back
   to most-recent row). *Dangerous — can publish/delete the wrong content.*
5. **G6 — blog & short-story crash** on "N words" (`int('1500 words')`).
6. **G15/G18 — retrieve/email-content don't search** (return everything / mis-resolve / wrong not-found).
7. **Routing misroutes (G3/G7/G10/G13/G16/G17)** — story-bible read, social-posts, "list drafts/published",
   "list/get research", "list story arcs" all route to conversation or the wrong (often generative) op.
8. **G2 — centralized email config dead** (`app_config` vs `app_config_v2`).
9. **G19 — `chapter.plan` crashes on Prologue/Epilogue** (my E2E-4 bug). **G4/G5/G8/G14/G20** — smaller.

### Net
My recent work (E2E-1 email-content, E2E-2 versions/lifecycle ops, E2E-3 newsletter, E2E-4 plan/qa ops,
E2E-5 voice callback) is **present and the ops themselves largely work**, but the **shared orchestration
the suite exercises end-to-end — project-id resolution, persistence, title resolution, search/filter,
routing, and emailing the deliverable — is where the engine is unfinished.** Full gap list + per-test
evidence above; raw per-test results in `scripts/e2e_out/*.json`.
