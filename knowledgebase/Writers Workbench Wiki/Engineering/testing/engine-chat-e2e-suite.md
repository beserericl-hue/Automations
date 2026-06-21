---
name: Engine chat E2E suite
description: Full 1:1 port of regressiontest_prompts.md (all 161 tests — R01–R121 chat + V01–V40 voice) onto the engine CHAT + VOICE-WEBHOOK interface. Every test asserts the FULL behavior the completed engine must satisfy; "impl: pending" tags map to the sprint set in engine-e2e-parity-sprints. Runs only once that sprint set is fully coded.
type: concept
tags: [testing, e2e, engine, chat, voice, functional, parity, acceptance]
last_reviewed: 2026-06-20
---

# Engine chat E2E suite

The complete acceptance suite for the [[engine-framework|Writer Engine]] driven through its **chat interface**
(`/api/chat/proxy` → hub) and **voice webhook** (`/internal/hub/voice`, simulated input). This is a faithful
**1:1 port of every test** in the repo's `regressiontest_prompts.md` (R01–R121 chat + V01–V40 voice = 161 tests) —
nothing consolidated, nothing dropped.

**This suite is the target state.** The engine WILL implement every function; each test asserts the FULL expected
behavior. Tests whose op isn't built yet carry an `impl: pending CR-010 <ref>` tag — those gaps are scheduled in
[[engine-e2e-parity-sprints]]. **The full suite is meant to be run once that sprint set is fully coded.** Until then,
the `built` tests are runnable today; the `pending` tests are written against the behavior they will have.

- Sibling pages: [[engine-api-system-tests]] (API-level), [[regression-tests]] (n8n-era R-list), [[e2e-tests]] (Playwright UI), [[test-conventions]].
- Routing source of truth: `engine/.../hub/catalog.py`. Gap source of truth: CR-010 (`writers-workbench/docs/change-requests/CR-010-...`).

## How to run

1. **As the end user:** Workbench chat drawer / action buttons (requires `HUB_BACKEND=engine`; DEV: live).
2. **Headless (CI/scripted) — chat:**
   ```
   SEC=$(railway variables --service writer-engine-gateway --json | python3 -c "import json,sys;print(json.load(sys.stdin)['SERVICE_SHARED_SECRET'])")
   curl -X POST https://writer-engine-gateway-develop.up.railway.app/internal/hub \
     -H "x-service-secret: $SEC" -H 'content-type: application/json' \
     -d '{"message":"<chat command>","user_id":"+14105914612"}'
   ```
3. **Headless — voice webhook (simulated input, no live agent):** same as above but `POST /internal/hub/voice`
   with `{"user_message_request":"<spoken text>","system__caller_id":"+14105914612"}` → returns a FLAT
   `{response, kind, job_id?}`.

### Response contract (assert on this)

| `kind` | Meaning | Verify |
|---|---|---|
| `reply` | conversation, no tool | text answer; no `tool`/`job_id` |
| `data` | **info** op, synchronous | `tool.op` + inline `data` (list/retrieve/lifecycle/story-bible) |
| `queued` | **task** op enqueued | `job_id`; poll `GET /api/jobs/engine/{job_id}` to `status==complete`; then assert the V2 DB row + the CR-009 completion email |

- DEV only: Supabase `gvbvwcnmjkdpclcisqrr`; user/caller `+14105914612`. **Never run against PROD** (`faklxfakgzkpkbxfihzh`).
- V2 tables: `writing_projects_v2`, `published_content_v2`, `content_versions_v2`, `outline_versions_v2`, `research_reports_v2`, `story_bible_v2`, `generated_images_v2`, `chapter_qa_v2`, `token_usage_v2`.

### Gaps this suite depends on → see [[engine-e2e-parity-sprints]]

Every `impl: pending` tag below is one of these (the sprint set lists only what's required to run the full suite):
`library.email-content` · `library.versions` · `library.revert` · newsletter-as-hub-op · `notify.eve-callback` ·
`chapter.plan` dual-arc depth. Everything else is `built`.

---

# PART 1 — CHAT TESTS (R01–R105)

## Section A: Core Infrastructure (Tests R01–R05)

### R01: Deep Research (Perplexity)
- **Engine route:** `research.run` (task) · impl: built
- **Command:**
  ```
  Research the current state of post-apocalyptic fiction in 2026. What are the trending themes, notable new releases, and how has the genre evolved since COVID? Include citations.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `research.run`, kind=queued
  - [ ] job reaches status=complete (poll `GET /api/jobs/engine/{job_id}`)
  - [ ] Response includes citations/sources
  - [ ] No email sent (research stays in chat / job result payload)
  - [ ] Row exists in `research_reports_v2` in DEV Supabase for user_id "+14105914612"
  - [ ] CR-009 task-completion email received

### R02: Save Research Report
- **Engine route:** `research.run` (task) · impl: built
- **Command:**
  ```
  Save that research as a report with topic "Post-Apocalyptic Fiction Trends 2026" and genre slug post-apocalyptic.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `research.run`, kind=queued; job reaches status=complete
  - [ ] Returns confirmation with report data (id, topic, status=draft)
  - [ ] Row exists in `research_reports_v2` with topic="Post-Apocalyptic Fiction Trends 2026", genre_slug=post-apocalyptic, user_id="+14105914612"

### R03: Email Report
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Command:**
  ```
  Send me an email report with this content:

  # Post-Apocalyptic Fiction Trends 2026

  ## Key Findings
  - Climate fiction is merging with post-apocalyptic themes
  - Solarpunk counternarratives are gaining traction
  - AI apocalypse stories have surged 300% since 2024

  ## Recommended Reading
  1. "The Last Garden" by Sarah Chen
  2. "Ash Protocol" by Marcus Webb

  Send it to eric@agileadtesting.com with subject line "Regression Test: Email Report"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.email-content`, kind=queued; job reaches status=complete
  - [ ] Email arrives at eric@agileadtesting.com
  - [ ] Email is formatted HTML (headings, bullet points, numbered list)
  - [ ] Subject line matches "Regression Test: Email Report"

### R04: Story Bible — Read (Empty)
- **Engine route:** `story_bible.list` (info) · impl: built
- **Command:**
  ```
  Get the story bible for project "Regression Test Project"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `story_bible.list`, kind=data
  - [ ] Returns empty result or "no entries found" (project doesn't exist yet)
  - [ ] No errors — confirms DEV Supabase connection works
  - [ ] Response correctly scoped to user_id "+14105914612"

### R05: Centralized Email Config (app_config)
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Command:**
  ```
  Send me an email report with this content:

  # Centralized Email Test

  This test verifies that the hub reads recipient_email from the app_config table in Supabase.

  Use subject line "R05: Centralized Email Config Test"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.email-content`, kind=queued; job reaches status=complete
  - [ ] Email arrives at the address stored in `app_config.recipient_email` in DEV Supabase
  - [ ] If `bcc_email` is set, BCC recipient also receives the email
  - [ ] No hardcoded email addresses used — all pulled from DEV Supabase app_config

## Section B: Writing Tools — Original Genres (Tests R06–R13)

### R06: Write Blog Post (post-apocalyptic)
- **Engine route:** `chapter.blog` (task) · impl: built
- **Command:**
  ```
  Write a blog post for the post-apocalyptic genre. Topic: "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026". Genre slug: post-apocalyptic. Keywords: post-apocalyptic books, climate fiction, survival stories, dystopian novels. Target length: 1500 words.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.blog`, kind=queued; job reaches status=complete
  - [ ] Blog post written in post-apocalyptic tone (gritty, visceral)
  - [ ] **Writing Prime Directive:** No cliches (revolutionize, game-changing, unleash, delve). Plain language. Short paragraphs. Shows, doesn't tell.
  - [ ] Cover art generated (ruins, decay, atmospheric) via `media.cover-art`
  - [ ] Email arrives with blog content
  - [ ] Draft row inserted into `published_content_v2` (content_type=blog_post, status=draft, user_id="+14105914612")
  - [ ] CR-009 task-completion email received

### R07: Write Newsletter (political-scifi)
- **Engine route:** `chapter.newsletter` (task) · impl: built (E2E-3)
- **Command:**
  ```
  Write a newsletter for the political-scifi genre. Topic: "Power Structures in Space: How Sci-Fi Predicts Real-World Politics". Genre slug: political-scifi. Date: 2026-03-10.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to newsletter durable saga, kind=queued; job reaches status=complete
  - [ ] Newsletter uses political-scifi tone (cerebral, tense, morally ambiguous)
  - [ ] **Writing Prime Directive:** No filler words, no hype, concrete examples
  - [ ] Has subject_line, pre_header, intro, sections, outro structure
  - [ ] Email arrives with newsletter content
  - [ ] Draft row in `published_content_v2` (content_type=newsletter, user_id="+14105914612")
  - [ ] CR-009 task-completion email received

### R08: Write Short Story (historical-time-travel)
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Command:**
  ```
  Write a short story. Genre slug: historical-time-travel. Premise: A historian discovers that antique photographs can transport her to the moment they were taken. She finds a photo of the Titanic's maiden voyage departure and must decide whether to warn the passengers. Tone: literary, bittersweet. Length: 2500 words. Research topics: ["Titanic maiden voyage Southampton 1912", "history of early photography techniques", "time travel paradoxes in fiction"]
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; job reaches status=complete
  - [ ] Story uses historical-time-travel tone (meticulous, wonder-infused)
  - [ ] **Writing Prime Directive:** Clear everyday language. Short sentences. Genuine emotion. Concrete details.
  - [ ] Perplexity research on all 3 topics performed
  - [ ] Cover art generated (period-appropriate) via `media.cover-art`
  - [ ] Email arrives with complete story
  - [ ] Draft row in `published_content_v2` (content_type=short_story, user_id="+14105914612")
  - [ ] CR-009 task-completion email received

### R09: Generate Cover Art (standalone)
- **Engine route:** `media.cover-art` (task) · impl: built
- **Command:**
  ```
  Generate cover art for a political-scifi short story called "The Senate of Stars". The story is about a diplomat navigating a galactic parliament where every species has a fundamentally different concept of justice. Genre slug: political-scifi. The image should show a vast circular chamber with alien delegates, lit by the light of a dying star through a massive viewport.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `media.cover-art`, kind=queued; job reaches status=complete
  - [ ] Image generated and URL returned in job result
  - [ ] Art style matches political-scifi guidelines (dark, imposing, cerebral)
  - [ ] Email arrives with image attachment
  - [ ] No text/words in the image
  - [ ] Row exists in `generated_images_v2` (user_id="+14105914612")
  - [ ] CR-009 task-completion email received

### R10: Repurpose to Social — Twitter
- **Engine route:** `media.social-posts` (task) · impl: built
- **Command:**
  ```
  Repurpose this into Twitter posts: "The Senate of Stars is a new political sci-fi short story about a diplomat navigating a galactic parliament where every species has a different concept of justice. A meditation on diplomacy, compromise, and whether true fairness is even possible across civilizations." Platform: twitter.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `media.social-posts`, kind=queued; job reaches status=complete
  - [ ] Output is a thread of tweets (each under 280 chars)
  - [ ] **Writing Prime Directive:** No cliches, no hype. Reads like a human wrote it.
  - [ ] Includes relevant hashtags; Email arrives with formatted tweets
  - [ ] CR-009 task-completion email received

### R11: Repurpose to Social — LinkedIn
- **Engine route:** `media.social-posts` (task) · impl: built
- **Command:**
  ```
  Repurpose this into LinkedIn posts: "We just published a deep-dive blog post on why post-apocalyptic fiction matters more than ever in 2026. From climate anxiety to AI fears, the genre has become a mirror for our collective anxieties — and surprisingly, a source of hope." Platform: linkedin.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `media.social-posts`, kind=queued; job reaches status=complete
  - [ ] Output is professional, longer format; **Prime Directive:** no filler/fake excitement
  - [ ] LinkedIn-style hashtags; Email arrives; CR-009 email received

### R12: Repurpose to Social — Facebook
- **Engine route:** `media.social-posts` (task) · impl: built
- **Command:**
  ```
  Repurpose this into Facebook posts: "The Last Signal is a post-apocalyptic short story about a lone radio operator in flooded Manhattan picking up a mysterious broadcast from across the Atlantic. Now free to read on our blog." Platform: facebook. Genre slug: post-apocalyptic.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `media.social-posts`, kind=queued; job reaches status=complete
  - [ ] Conversational, community-engaging tone
  - [ ] Cover image generated via `media.cover-art` sub-task
  - [ ] Email arrives with posts + image; CR-009 email received

### R13: Repurpose to Social — Instagram
- **Engine route:** `media.social-posts` (task) · impl: built
- **Command:**
  ```
  Repurpose this into Instagram posts: "A historian discovers that antique photographs can transport her to the moment they were taken. She finds a photo from the Titanic's maiden voyage and must decide whether to change history." Platform: instagram. Genre slug: historical-time-travel.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `media.social-posts`, kind=queued; job reaches status=complete
  - [ ] Caption style, max 2200 chars; 20-30 hashtags at end; conversational tone
  - [ ] Email arrives with formatted caption; CR-009 email received

## Section C: Writing Tools — New Genres (Tests R14–R19)

### R14: Write Blog Post (ancient-history)
- **Engine route:** `chapter.blog` (task) · impl: built
- **Command:**
  ```
  Write a blog post in the ancient-history genre. Topic: "The Forgotten Engineers of Rome: How Aqueducts Shaped an Empire". Genre slug: ancient-history. Keywords: Roman engineering, aqueducts, ancient infrastructure, Frontinus. Target length: 1500 words.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.blog`, kind=queued; job reaches status=complete
  - [ ] Blog uses ancient-history tone (immersive, sensory-rich, reverent of detail)
  - [ ] **Prime Directive:** Plain language, no hype, concrete examples
  - [ ] Cover art: classical oil painting style, warm golden light, marble/stone
  - [ ] Content Ingestion may return 0 items — job continues gracefully (fallback working)
  - [ ] Email arrives with blog + cover image; Draft row in `published_content_v2`; CR-009 email received

### R15: Write Short Story (ai-marketing)
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Command:**
  ```
  Write a short story in the ai-marketing genre. Genre slug: ai-marketing. Premise: An AI trained to write ad copy for a luxury perfume brand starts composing poetry instead — and the poems sell better than any ad ever did. Tone: satirical, sharp, funny. Length: 2000 words. Research topics: ["AI generated advertising 2026", "perfume marketing psychology", "computational creativity"]
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; job reaches status=complete
  - [ ] Story uses ai-marketing tone (authoritative, forward-looking, practical)
  - [ ] **Prime Directive:** No jargon/buzzwords. Clear, short sentences. Genuine wit.
  - [ ] Cover art: clean tech aesthetic, gradient blues/purples, circuit patterns
  - [ ] Email arrives with story + cover image; Draft row in `published_content_v2`; CR-009 email received

### R16: Write Newsletter (political-history)
- **Engine route:** `chapter.newsletter` (task) · impl: built (E2E-3)
- **Command:**
  ```
  Write a newsletter for the political-history genre. Topic: "This Month in Political History: Revolutions That Changed the Map". Genre slug: political-history. Date: 2026-03-10.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to newsletter durable saga, kind=queued; job reaches status=complete
  - [ ] Newsletter uses political-history tone (analytical, layered, draws parallels)
  - [ ] **Prime Directive:** Facts over hype. Show don't tell. No filler.
  - [ ] Cover art: documentary/oil painting style, amber lighting
  - [ ] Email arrives; Draft row in `published_content_v2`; CR-009 email received

### R17: Write Chapter (ancient-history, new project)
- **Engine route:** `chapter.write` (task) · impl: built
- **Command:**
  ```
  Write chapter 1 of a new book. Genre slug: ancient-history. Project title: "The Last Pharaoh's Scribe". Chapter number: 1. Brief: A young scribe in Cleopatra's court discovers that the Library of Alexandria holds a map to a weapon that could repel the Roman invasion. She must navigate court politics, Roman spies, and her own ambitions to find it before Alexandria falls. Outline: Chapter 1 introduces Nefertari in the library, the discovery of the hidden map fragment, and a tense encounter with a Roman centurion posing as a scholar. Research topics: ["Library of Alexandria daily operations", "Cleopatra's court structure and politics", "Roman military presence in Egypt 30 BC", "ancient Egyptian scribal practices"]
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; job reaches status=complete
  - [ ] Chapter uses ancient-history tone; **Prime Directive** followed
  - [ ] Perplexity researches all 4 topics
  - [ ] Story bible entries created in `story_bible_v2`; Row created in `writing_projects_v2` for "The Last Pharaoh's Scribe"
  - [ ] Email arrives; Draft row in `published_content_v2` (content_type=chapter); CR-009 email received

### R18: Cover Art — New Genre (ai-marketing)
- **Engine route:** `media.cover-art` (task) · impl: built
- **Command:**
  ```
  Generate cover art for an ai-marketing blog post called "The Algorithm That Learned to Dream". The article explores AI systems that generate creative content. Genre slug: ai-marketing. The image should represent the intersection of artificial intelligence and human creativity.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `media.cover-art`, kind=queued; job reaches status=complete
  - [ ] Art uses ai-marketing guidelines (gradient blues/purples, circuit patterns)
  - [ ] NOT post-apocalyptic style; Email arrives with image; Row in `generated_images_v2`; CR-009 email received

### R19: Cover Art — New Genre (ancient-history)
- **Engine route:** `media.cover-art` (task) · impl: built
- **Command:**
  ```
  Generate cover art for an ancient-history novel called "The Last Pharaoh's Scribe". Genre slug: ancient-history. The image should show an ancient Egyptian library with papyrus scrolls, oil lamps, and a view of Alexandria's harbor through a columned window.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `media.cover-art`, kind=queued; job reaches status=complete
  - [ ] Art uses ancient-history guidelines (classical painting, warm golden light, earth tones)
  - [ ] NOT modern/tech aesthetic; Email arrives; Row in `generated_images_v2`; CR-009 email received

## Section D: Content Library (Tests R20–R27)

### R20: List Drafts
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Command:**
  ```
  List my drafts
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.list-outlines`, kind=data
  - [ ] Returns formatted list with title, content_type, genre, date, UUID
  - [ ] Scoped to user_id "+14105914612"; count matches draft rows in `published_content_v2`

### R21: List Drafts — Filter by Type
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Command:**
  ```
  List my draft blog posts
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.list-outlines`, kind=data
  - [ ] Returns only content_type=blog_post; other types excluded

### R22: Approve Draft
- **Engine route:** `library.lifecycle` (info) · impl: built
- **Command:**
  ```
  Approve the draft titled "[exact title from R20]"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle`, kind=data; returns confirmation
  - [ ] `published_content_v2` row status → 'approved'
  - [ ] Email notification confirming approval
  - [ ] Version snapshot auto-saved to `content_versions_v2`

### R23: Publish Content
- **Engine route:** `library.lifecycle` (info) · impl: built
- **Command:**
  ```
  Publish the content titled "[same title from R22]"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle`, kind=data; status → 'published'; `published_at` set
  - [ ] Email notification confirming publication; Version snapshot in `content_versions_v2`

### R24: List Published
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Command:**
  ```
  List my published content
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.list-outlines`, kind=data; returns the R23 item with published_at date

### R25: Reject Draft
- **Engine route:** `library.lifecycle` (info) · impl: built
- **Command:**
  ```
  Reject the draft titled "[different title from R20]"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle`, kind=data; status → 'rejected'
  - [ ] Email notification confirming rejection with content title

### R26: Schedule Publishing
- **Engine route:** `library.lifecycle` (info) · impl: built
- **Command:**
  ```
  Schedule the draft titled "[title]" for 2026-03-20
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle`, kind=data; status → 'scheduled'
  - [ ] Metadata schedule_date = "2026-03-20"; Email confirms scheduling with the date

### R27: List Scheduled Content
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Command:**
  ```
  List my scheduled content
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.list-outlines`, kind=data; returns the R26 item with scheduled date

## Section E: Version History (Tests R28–R29)

### R28: Version History on Approve/Publish
- **Engine route:** `library.versions` (info) · impl: built (E2E-2)
- **Command:**
  ```
  Show version history for [content_id from R23]
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.versions`, kind=data
  - [ ] Returns ≥1 version entry from `content_versions_v2`
  - [ ] Each version shows version_number, changed_by, change_note, timestamp

### R29: Get Specific Version
- **Engine route:** `library.versions` (info) · impl: built (E2E-2)
- **Command:**
  ```
  Get version 1 of [content_id from R23]
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.versions`, kind=data
  - [ ] Returns full content_text from version 1; includes version_number, changed_by, change_note

## Section F: Brainstorm & Outline (Tests R30–R32)

### R30: Brainstorm Story
- **Engine route:** `brainstorm.story` (task) · impl: built
- **Command:**
  ```
  Brainstorm a post-apocalyptic story called "The Seed Vault" about the last botanist on Earth protecting the Svalbard seed vault from raiders who don't understand its value. Themes: preservation, sacrifice, legacy, nature vs. human destruction. 6 chapters. Genre slug: post-apocalyptic.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; job reaches status=complete
  - [ ] Email with HTML outline: title, premise, themes, character profiles, 6 chapter breakdowns
  - [ ] **Prime Directive:** clear, direct outline language
  - [ ] Row created in `writing_projects_v2` with `outline` JSONB populated
  - [ ] CR-009 task-completion email received

### R31: Write Chapter from Stored Outline
- **Engine route:** `chapter.write` (task) · impl: built
- **Prerequisite:** R30
- **Command:**
  ```
  Write chapter 1 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 1.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; job reaches status=complete
  - [ ] No brief/outline passed — engine auto-loads `writing_projects_v2.outline`
  - [ ] Chapter references characters/plot from R30 outline
  - [ ] Story bible entries created; Email arrives; Draft row in `published_content_v2`; CR-009 email received

### R32: Story Bible — Read After Chapter
- **Engine route:** `story_bible.list` (info) · impl: built
- **Prerequisite:** R31
- **Command:**
  ```
  Get the story bible for project "The Seed Vault"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `story_bible.list`, kind=data
  - [ ] Returns character/location/plot entries from Chapter 1 with chapter_introduced=1

## Section G: Research Reports (Tests R33–R35)

### R33: List Research Reports
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Command:**
  ```
  List my research reports
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.list-outlines`, kind=data; returns `research_reports_v2` list (≥ the R02 report) with id/topic/genre_slug/status

### R34: Get Research Report
- **Engine route:** `library.retrieve` (info) · impl: built
- **Command:**
  ```
  Get the research report about "Post-Apocalyptic Fiction Trends 2026"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.retrieve`, kind=data; returns full report content from `research_reports_v2`

### R35: Update Research Report
- **Engine route:** `library.lifecycle` (info) · impl: built
- **Command:**
  ```
  Update the research report "Post-Apocalyptic Fiction Trends 2026" — change its status to published.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle`, kind=data; status → 'published'; updated_at refreshed

## Section H: Content Retrieval (Tests R36–R37)

### R36: Retrieve Content — Search by Title
- **Engine route:** `library.retrieve` (info) · impl: built
- **Command:**
  ```
  Find my draft about the Titanic
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.retrieve`, kind=data; returns the R08 short story; shows title/content_type/char count; no callback

### R37: Retrieve Content — Not Found
- **Engine route:** `library.retrieve` (info) · impl: built
- **Command:**
  ```
  Find my draft about quantum surfing on Jupiter
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.retrieve`, kind=data; found=false; suggests alternatives; no crash

## Section I: Edge Cases & Cross-Genre (Tests R38–R42)

### R38: Unknown Genre Slug
- **Engine route:** `chapter.blog` (task) · impl: built
- **Command:**
  ```
  Write a blog post in the cyberpunk genre. Genre slug: cyberpunk. Topic: "Neon and Chrome". Target length: 1000 words.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.blog`, kind=queued; asks clarification OR picks closest genre (political-scifi)
  - [ ] Does NOT crash / null genre config; if it proceeds, blog generates; job reaches complete; CR-009 email received

### R39: Minimal Input (Agent Fills Gaps)
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Command:**
  ```
  Write me a short story about a robot learning to paint
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; infers genre + premise + tone + length
  - [ ] job reaches complete; Story written and emailed; Draft row in `published_content_v2`; CR-009 email received

### R40: Multi-Step Conversation
- **Engine route:** `research.run` then `chapter.blog` (task, task) · impl: built
- **Command:**
  ```
  Message 1: Research ancient Roman gladiator training methods
  ```
  ```
  Message 2: Now write a blog post about that research. Genre slug: ancient-history. Keywords: gladiators, Roman arena, combat training. Target length: 1200 words.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] Msg 1 → `research.run`, complete; saved to `research_reports_v2`
  - [ ] Msg 2 → `chapter.blog`, complete; blog incorporates Msg 1 findings; both CR-009 emails received

### R41: Cross-Genre Cover Art
- **Engine route:** `media.cover-art` (task) · impl: built
- **Command:**
  ```
  Message 1: Generate cover art for a post-apocalyptic story called "Ash". Genre slug: post-apocalyptic. A lone figure walking through a gray, ash-covered landscape.
  ```
  ```
  Message 2: Now generate cover art for an ancient-history novel called "The Golden Temple". Genre slug: ancient-history. A grand temple at sunset with priests on the steps.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] Both → `media.cover-art`, complete; Image 1 post-apoc style; Image 2 ancient-history style; clearly different
  - [ ] Both rows in `generated_images_v2`; both CR-009 emails received

### R42: Cron Auto-Publish (Scheduled Publisher)
- **Engine route:** `library.lifecycle` (info) · impl: built
- **Command:**
  ```
  [Manual setup: SET status='scheduled', metadata schedule_date to a past timestamp in published_content_v2 via Supabase SQL, then wait for engine cron to process]
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] Engine cron detects past-due scheduled item; status 'scheduled' → 'published'; published_at set
  - [ ] Email to centralized recipient (not hardcoded); Version snapshot in `content_versions_v2` before publish

## Section J: Writing Prime Directive Verification (Tests R43–R48)

### R43: Prime Directive — Blog Post
- **Engine route:** `chapter.blog` (task) · impl: built
- **Command:**
  ```
  Write a blog post in the ai-marketing genre. Topic: "How AI Tools Are Changing Content Marketing". Genre slug: ai-marketing. Keywords: AI content tools, marketing automation, generative AI. Target length: 1200 words.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.blog`, kind=queued; complete
  - [ ] No "revolutionize", "game-changing", "unleash", "delve", "cutting-edge", "leverage"
  - [ ] Short paragraphs (2-4 sentences); concrete examples; human voice; no hype; CR-009 email received

### R44: Prime Directive — Newsletter
- **Engine route:** `chapter.newsletter` (task) · impl: built (E2E-3)
- **Command:**
  ```
  Write a newsletter for the ancient-history genre. Topic: "New Archaeological Discoveries Reshaping Our Understanding of Ancient Egypt". Genre slug: ancient-history. Date: 2026-03-10.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to newsletter durable saga, kind=queued; complete
  - [ ] No banned cliche words; gets to the point; specific findings; genuine tone; CR-009 email received

### R45: Prime Directive — Short Story
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Command:**
  ```
  Write a short story in the political-scifi genre. Genre slug: political-scifi. Premise: A junior senator discovers that the AI running the galactic parliament has been quietly editing legislation before votes. Tone: tense, cynical. Length: 1500 words.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; complete
  - [ ] Clean prose, no purple prose; natural dialogue; short sentences for tension; everyday language; CR-009 email received

### R46: Prime Directive — Chapter
- **Engine route:** `chapter.write` (task) · impl: built
- **Command:**
  ```
  Write chapter 2 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 2. Brief: The botanist encounters the first raider scouts approaching the vault. She must decide whether to hide or make contact. Research topics: ["Svalbard seed vault security systems", "post-collapse social dynamics"]
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; complete
  - [ ] No cliches/buzzwords; tight descriptions; concrete action; respects reader; CR-009 email received

### R47: Prime Directive — Social Posts
- **Engine route:** `media.social-posts` (task) · impl: built
- **Command:**
  ```
  Repurpose this into Twitter posts: "New research shows that AI-powered marketing tools are fundamentally changing how brands connect with audiences. From personalized content to predictive analytics, the landscape is shifting fast." Platform: twitter. Genre slug: ai-marketing.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `media.social-posts`, kind=queued; complete
  - [ ] No "game-changing/revolutionize/unleash/cutting-edge"; human voice; no hype; tight; CR-009 email received

### R48: Prime Directive — Brainstorm Outline
- **Engine route:** `brainstorm.story` (task) · impl: built
- **Command:**
  ```
  Brainstorm a political-history story called "The Diplomat's Gambit" about a Cold War spy who discovers that both superpowers are being manipulated by the same shadowy organization. Themes: deception, loyalty, the illusion of choice. 8 chapters. Genre slug: political-history.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; complete
  - [ ] Direct premise (no buzzwords); specific characters; concrete chapter briefs; themes via plot mechanics
  - [ ] Row in `writing_projects_v2` with outline JSONB; CR-009 email received

## Section K: Story Structure Guidelines (Tests R49–R52)

### R49: Brainstorm Uses Structure Model
- **Engine route:** `brainstorm.story` (task) · impl: built
- **Command:**
  ```
  Brainstorm a short story about a soldier who wakes up 100 years after a war she started, only to find the enemy she fought won and built a better world. Genre: post-apocalyptic. Title: The Wrong Side. Sections: 5
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; complete
  - [ ] Each section `arc_notes` names a structural beat; outline notes the model chosen
  - [ ] Characters have roles (Protagonist/Antagonist/Dynamic/Static); no character without a structural purpose
  - [ ] Row in `writing_projects_v2`; CR-009 email received

### R50: Short Story Has 5-Stage Arc
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Command:**
  ```
  Write a short story about a city maintenance worker who discovers the AI managing the city's infrastructure has been writing poetry in the gaps between system logs. Genre: ai-marketing. Length: 2500 words. Tone: quiet and melancholic.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; complete
  - [ ] Ordinary world → catalyst → peak/climax → falling action → resolution with visible change
  - [ ] Protagonist transforms; emotional/thematic stakes throughout; Draft row; CR-009 email received

### R51: Chapter Has Internal Arc + Transformation
- **Engine route:** `chapter.write` (task) · impl: built
- **Command:**
  ```
  Write chapter 1 of a story called "The Cartographer's Lie" in post-apocalyptic genre. Brief: A map-maker is hired to chart the forbidden eastern territories. On the first day, she discovers the map she was given to copy is intentionally wrong.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; complete
  - [ ] Identifiable internal arc; protagonist's state changes; `next_chapter_notes` references arc; ≥1 role identifiable
  - [ ] Draft row; CR-009 email received

### R52: Correct Genre Name Preserved (R43 Guard)
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Command:**
  ```
  Write a short story about a political consultant who realizes the candidate she is managing is being blackmailed by a rival AI. Genre: political-scifi. Length: 2000 words. Tone: tense thriller.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; complete
  - [ ] Reflects political-scifi themes; genre guidelines applied; no `[undefined]` in subject/text/title
  - [ ] Tension arc + transformation; Draft row; CR-009 email received

## Section L: Story Arcs (Tests R53–R61)

### R53: List Story Arcs
- **Engine route:** `library.retrieve` (info) · impl: built
- **Command:**
  ```
  List the story arcs
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.retrieve`, kind=data; lists **Freytags Pyramid** and **Three-Act Structure** with descriptions
  - [ ] does NOT invoke `brainstorm.story` or any task tool; returned inline

### R54: Brainstorm Short Story — Freytags Pyramid (Post-Apocalyptic)
- **Engine route:** `brainstorm.story`/`brainstorm.short-story` (task) · impl: built · arc fidelity: built (E2E-4)
- **Command:**
  ```
  Brainstorm a short story using Freytags Pyramid about a plague doctor in the ruins of Manhattan who discovers that the disease wiping out survivors is man-made, and the cure lies in the hands of the people who created it. Genre: post-apocalyptic. Title: The Inoculator. Sections: 5. Themes: trust, complicity, the cost of survival.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; job_id; complete
  - [ ] `story_arc="Freytags Pyramid"` passed; arc prompt loaded from `story_arcs` table
  - [ ] `writing_projects_v2` row "The Inoculator" with outline; arc_notes name all 5 Freytag beats
  - [ ] Climax = midpoint apex (goal achieved + crack appears), NOT final confrontation
  - [ ] Falling Action shows descent; final section = catastrophe/survival-with-consequence
  - [ ] Characters have roles; arc_notes use Freytag terminology; CR-009 email subject contains "The Inoculator"

### R55: Brainstorm Book — Freytags Pyramid (Political Sci-Fi)
- **Engine route:** `brainstorm.story`/`brainstorm.short-story` (task) · impl: built · arc fidelity: built (E2E-4)
- **Command:**
  ```
  Help me brainstorm a book using Freytags Pyramid about a diplomat who brokers peace between two warring colony planets, only to discover the peace treaty she negotiated will secretly enslave one side. Genre: political-scifi. Title: The Accord. 10 chapters. Themes: complicity, the machinery of power, moral compromise, the price of peace.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; complete; `story_arc="Freytags Pyramid"`
  - [ ] `writing_projects_v2` "The Accord" with 10 chapters mapped to 5-act pyramid
  - [ ] Ch1-2 Introduction; Ch3-5 Rising Action; Ch5/6 Climax (Midpoint); Ch7-8 Falling; Ch9-10 Catastrophe/Denouement
  - [ ] arc_notes name specific Freytag beats; protagonist fatal flaw from Act 1; CR-009 email "The Accord"

### R56: Brainstorm Short Story — Freytags Pyramid (Ancient History)
- **Engine route:** `brainstorm.story`/`brainstorm.short-story` (task) · impl: built · arc fidelity: built (E2E-4)
- **Command:**
  ```
  Brainstorm a short story using Freytags Pyramid about a Roman senator who poisons his rivals to secure the consulship, only for his own family to be destroyed by the same poison network he built. Genre: ancient-history. Title: The Consulship of Gaius Varro. 5 sections. Themes: ambition, legacy, self-destruction.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; complete; `story_arc="Freytags Pyramid"`
  - [ ] `writing_projects_v2` "The Consulship of Gaius Varro" with 5 sections; classic tragedy arc
  - [ ] Climax (midpoint) = consulship achieved AND unraveling begins; Falling = network turns on him; Catastrophe = ruin
  - [ ] Roman details researched; arc_notes use Freytag terminology; CR-009 email subject contains the title

### R57: Brainstorm Short Story — Freytags Pyramid (Historical Time Travel)
- **Engine route:** `brainstorm.story`/`brainstorm.short-story` (task) · impl: built · arc fidelity: built (E2E-4)
- **Command:**
  ```
  Brainstorm a short story using Freytags Pyramid about a historian who travels to 1692 Salem to observe the witch trials, but accidentally provides testimony that condemns an innocent woman. Genre: historical-time-travel. Title: The Witness. 5 sections. Themes: guilt, the observer effect, whether the past can be repaired.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; complete; `story_arc="Freytags Pyramid"`
  - [ ] `writing_projects_v2` "The Witness" with 5 sections; Introduction = ordinary world + time travel
  - [ ] Climax = research goal achieved AND false testimony occurs; Falling = cascade/worse; Catastrophe = irreversibility
  - [ ] Salem details; fatal flaw in Section 1; arc_notes Freytag terminology; CR-009 email "The Witness"

### R58: Brainstorm Short Story — Three-Act Structure (Post-Apocalyptic)
- **Engine route:** `brainstorm.story`/`brainstorm.short-story` (task) · impl: built · arc fidelity: built (E2E-4)
- **Command:**
  ```
  Brainstorm a short story using the Three-Act Structure about a radio operator in a flooded world who picks up a signal from a city that was supposed to be underwater. Genre: post-apocalyptic. Title: Signal from the Deep. 5 sections. Themes: hope vs. delusion, isolation, the pull of the impossible.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; complete; `story_arc="Three-Act Structure"`
  - [ ] `writing_projects_v2` "Signal from the Deep" with 5 sections; arc_notes reference 3-act beats
  - [ ] S1 Setup (~25%, the signal); S2-3 Confrontation (~50%, midpoint setback ≠ climax); S4-5 Resolution (pre-climax false resolution → climax → denouement)
  - [ ] arc_notes Three-Act terminology; CR-009 email "Signal from the Deep"

### R59: Brainstorm Book — Three-Act Structure (AI Marketing)
- **Engine route:** `brainstorm.story`/`brainstorm.short-story` (task) · impl: built · arc fidelity: built (E2E-4)
- **Command:**
  ```
  Help me brainstorm a book using the Three-Act Structure about an AI startup founder who discovers her company's flagship product is manipulating users' purchasing decisions in ways she didn't authorize. Genre: ai-marketing. Title: The Optimization. 8 chapters. Themes: ethics in tech, the line between persuasion and manipulation, corporate accountability.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; complete; `story_arc="Three-Act Structure"`
  - [ ] `writing_projects_v2` "The Optimization" with 8 chapters; Ch1-2 Setup(25%); Ch3-6 Confrontation(50%, midpoint reversal); Ch7-8 Resolution(25%)
  - [ ] Midpoint ≠ climax; climax = single decisive confrontation; denouement = thematic "Philosophy"
  - [ ] arc_notes Three-Act terminology; narrative goal Act1→Act3; CR-009 email "The Optimization"

### R60: Brainstorm Short Story — Three-Act Structure (Political History)
- **Engine route:** `brainstorm.story`/`brainstorm.short-story` (task) · impl: built · arc fidelity: built (E2E-4)
- **Command:**
  ```
  Brainstorm a short story using the Three-Act Structure about a journalist in 1970s Chile who uncovers evidence of CIA involvement in the upcoming coup, but no one will publish her story. Genre: political-history. Title: The Unpublished. 5 sections. Themes: truth vs. power, the cost of speaking out, complicity of silence.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; complete; `story_arc="Three-Act Structure"`
  - [ ] `writing_projects_v2` "The Unpublished" with 5 sections; Act1 setup; Act2 ≥3 obstacles + midpoint; Act3 pre-climax → climax → denouement
  - [ ] 1970s Chile/Pinochet context; denouement addresses truth vs power; goal clear from Act1; CR-009 email "The Unpublished"

### R61: Brainstorm Book — Three-Act Structure (Historical Time Travel)
- **Engine route:** `brainstorm.story`/`brainstorm.short-story` (task) · impl: built · arc fidelity: built (E2E-4)
- **Command:**
  ```
  Help me brainstorm a book using the Three-Act Structure about a grief-stricken physicist who invents a time machine to save her daughter from a car accident, but each trip changes the present in ways that make the world progressively worse. Genre: historical-time-travel. Title: The Correction. 10 chapters. Themes: grief, the tyranny of good intentions, accepting loss, the butterfly effect.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.story`, kind=queued; complete; `story_arc="Three-Act Structure"`
  - [ ] `writing_projects_v2` "The Correction" with 10 chapters; Ch1-2 Setup(~25%); Ch3-7 Confrontation(~50%, midpoint gut-punch); Ch8-10 Resolution(~25%)
  - [ ] Midpoint ≠ climax; pre-climax false resolution; climax single moment; denouement resolves thematic question
  - [ ] arc_notes Three-Act throughout; 10 chapters distributed; CR-009 email "The Correction"

## Section M: Write from Brainstormed Outline (Tests R62–R69)

### R62: Write Short Story from Freytags Pyramid Outline (Post-Apocalyptic)
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Prerequisite:** R54
- **Command:**
  ```
  Write the short story "The Inoculator". Genre slug: post-apocalyptic.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; complete; auto-loads `writing_projects_v2.outline`
  - [ ] 5 sections matching the Freytag outline; Climax = midpoint apex; Falling = consequences; final = catastrophe
  - [ ] characters match R54; `published_content_v2` row (short_story); `content_versions_v2` snapshot; Prime Directive; CR-009 email

### R63: Write Chapter 1 from Freytags Pyramid Outline (Political Sci-Fi)
- **Engine route:** `chapter.write` (task) · impl: built
- **Prerequisite:** R55
- **Command:**
  ```
  Write chapter 1 of "The Accord". Genre slug: political-scifi. Chapter number: 1.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; complete; auto-loads 10-ch outline
  - [ ] Ch1 covers Freytag Introduction; fatal flaw planted; characters match R55
  - [ ] `published_content_v2` chapter row; `story_bible_v2` entries; `content_versions_v2` snapshot; Prime Directive; CR-009 email

### R64: Write Short Story from Freytags Pyramid Outline (Ancient History)
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Prerequisite:** R56
- **Command:**
  ```
  Write the short story "The Consulship of Gaius Varro". Genre slug: ancient-history.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; complete; auto-loads outline
  - [ ] tragedy arc; Climax = consulship + unraveling; Falling = network turns; Catastrophe = ruin; Roman details woven
  - [ ] `published_content_v2` row; `content_versions_v2` snapshot; Prime Directive; CR-009 email

### R65: Write Short Story from Freytags Pyramid Outline (Historical Time Travel)
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Prerequisite:** R57
- **Command:**
  ```
  Write the short story "The Witness". Genre slug: historical-time-travel.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; complete; auto-loads outline
  - [ ] Intro = world + Salem; Climax = goal + false testimony; Falling = worse; Catastrophe = irreversibility; Salem details
  - [ ] `published_content_v2` row; `content_versions_v2` snapshot; Prime Directive; CR-009 email

### R66: Write Short Story from Three-Act Outline (Post-Apocalyptic)
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Prerequisite:** R58
- **Command:**
  ```
  Write the short story "Signal from the Deep". Genre slug: post-apocalyptic.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; complete; auto-loads outline
  - [ ] S1 Setup(~25%); S2-3 Confrontation(~50%); midpoint ≠ climax; S4-5 Resolution; pre-climax false resolution identifiable
  - [ ] `published_content_v2` row; `content_versions_v2` snapshot; Prime Directive; CR-009 email

### R67: Write Chapter 1 from Three-Act Outline (AI Marketing)
- **Engine route:** `chapter.write` (task) · impl: built
- **Prerequisite:** R59
- **Command:**
  ```
  Write chapter 1 of "The Optimization". Genre slug: ai-marketing. Chapter number: 1.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; complete; auto-loads 8-ch outline
  - [ ] Ch1 Act1 Setup; narrative goal established; characters match R59; `published_content_v2` chapter row; `story_bible_v2`; snapshot; Prime Directive; CR-009 email

### R68: Write Short Story from Three-Act Outline (Political History)
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Prerequisite:** R60
- **Command:**
  ```
  Write the short story "The Unpublished". Genre slug: political-history.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.short-story`, kind=queued; complete; auto-loads outline
  - [ ] Act1 setup; Act2 ≥3 obstacles + midpoint; Act3 pre-climax → climax → denouement; Chile context; truth-vs-power denouement
  - [ ] `published_content_v2` row; snapshot; Prime Directive; CR-009 email

### R69: Write Chapter 1 from Three-Act Outline (Historical Time Travel)
- **Engine route:** `chapter.write` (task) · impl: built
- **Prerequisite:** R61
- **Command:**
  ```
  Write chapter 1 of "The Correction". Genre slug: historical-time-travel. Chapter number: 1.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; complete; auto-loads 10-ch outline
  - [ ] Ch1 Act1 Setup (grief, machine works); goal locked in; characters/tone match R61; `published_content_v2` chapter row; `story_bible_v2`; snapshot; Prime Directive; CR-009 email

## Section N: Prologue & Epilogue (Tests R70–R81)

### R70: Retrieve Outline — The Accord
- **Engine route:** `library.retrieve` (info) · impl: built
- **Prerequisite:** R55
- **Command:**
  ```
  Retrieve the outline for "The Accord"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.retrieve`, kind=data; returns full outline (10 chapters, characters, themes, premise); Freytag structure; from `writing_projects_v2`

### R71: Revise Outline — Add Prologue and Epilogue to The Accord
- **Engine route:** `brainstorm.revise-outline` (task) · impl: built
- **Prerequisite:** R70
- **Command:**
  ```
  Revise the outline for "The Accord". Add a prologue that opens with a classified diplomatic transmission intercepted decades before the main story begins — hinting at the alien contact that will drive the political crisis. Add an epilogue set 20 years after the climax showing the long-term consequences of the accord on human civilization. Keep the existing 10 chapters and Freytags Pyramid structure. Genre slug: political-scifi.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.revise-outline`, kind=queued; complete; Freytag preserved
  - [ ] outline gains chapter number=0 (Prologue) + number=11 (Epilogue); `outline_versions_v2` snapshot of pre-revision; original 10 chapters preserved; CR-009 email shows Prologue+10+Epilogue

### R72: Write Prologue — The Accord
- **Engine route:** `chapter.write` (task) · impl: built
- **Prerequisite:** R71
- **Command:**
  ```
  Write the prologue for "The Accord". Genre slug: political-scifi.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; complete; chapter_number=Prologue(0); labeled "Prologue" not "Chapter 0"
  - [ ] prologue-specific prompt; 1500-3000 words; content matches R71 concept; `published_content_v2` row chapter_number=0
  - [ ] email subject "The Accord - Prologue"; `story_bible_v2` entries; snapshot; Prime Directive

### R73: Write Epilogue — The Accord
- **Engine route:** `chapter.write` (task) · impl: built
- **Prerequisite:** R71
- **Command:**
  ```
  Write the epilogue for "The Accord". Genre slug: political-scifi.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; complete; chapter_number=Epilogue; labeled "Epilogue" not "Chapter 11"
  - [ ] epilogue-specific prompt; 1500-3000 words; set 20 years later per R71; `published_content_v2` row
  - [ ] email subject "The Accord - Epilogue"; chapter_count NOT incremented; `story_bible_v2`; snapshot; Prime Directive

### R74: Retrieve Outline — The Correction
- **Engine route:** `library.retrieve` (info) · impl: built
- **Prerequisite:** R61
- **Command:**
  ```
  Retrieve the outline for "The Correction"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.retrieve`, kind=data; full outline (10 chapters); Three-Act structure; from `writing_projects_v2`

### R75: Revise Outline — Add Prologue to The Correction
- **Engine route:** `brainstorm.revise-outline` (task) · impl: built
- **Prerequisite:** R74
- **Command:**
  ```
  Revise the outline for "The Correction". Add a prologue set in 2089 where the protagonist's granddaughter discovers her grandmother's hidden journal describing impossible historical events — this frames the entire story as a mystery being uncovered. Keep the existing 10 chapters and Three-Act Structure. Genre slug: historical-time-travel.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.revise-outline`, kind=queued; complete; Three-Act preserved
  - [ ] outline gains chapter number=0 (Prologue, 2089/journal/mystery); `outline_versions_v2` snapshot; original 10 preserved; NO Epilogue added; CR-009 email shows Prologue+10 (no Epilogue)

### R76: Write Prologue — The Correction
- **Engine route:** `chapter.write` (task) · impl: built
- **Prerequisite:** R75
- **Command:**
  ```
  Write the prologue for "The Correction". Genre slug: historical-time-travel.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; complete; chapter_number=Prologue(0); labeled "Prologue"
  - [ ] content = 2089 granddaughter + journal (matches R75); creates mystery/urgency; 1500-3000 words
  - [ ] `published_content_v2` row chapter_number=0; email subject "The Correction - Prologue"; snapshot; Prime Directive

### R77: Retrieve Outline — The Optimization
- **Engine route:** `library.retrieve` (info) · impl: built
- **Prerequisite:** R59
- **Command:**
  ```
  Retrieve the outline for "The Optimization"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.retrieve`, kind=data; full outline (8 chapters); Three-Act; from `writing_projects_v2`

### R78: Revise Outline — Add Epilogue Only to The Optimization
- **Engine route:** `brainstorm.revise-outline` (task) · impl: built
- **Prerequisite:** R77
- **Command:**
  ```
  Revise the outline for "The Optimization". Add an epilogue set 5 years later where the protagonist discovers that the AI marketing system they dismantled has quietly rebuilt itself inside a competitor's platform — but this time it has learned from its mistakes. Keep the existing 8 chapters and Three-Act Structure. Genre slug: ai-marketing.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.revise-outline`, kind=queued; complete; Three-Act preserved
  - [ ] outline gains chapter number=9 (Epilogue, 5 years later, AI rebuilt); `outline_versions_v2` snapshot; original 8 preserved; NO Prologue added; CR-009 email shows 8+Epilogue (no Prologue)

### R79: Write Epilogue — The Optimization
- **Engine route:** `chapter.write` (task) · impl: built
- **Prerequisite:** R78
- **Command:**
  ```
  Write the epilogue for "The Optimization". Genre slug: ai-marketing.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `chapter.write`, kind=queued; complete; chapter_number=Epilogue; labeled "Epilogue"
  - [ ] content = 5 years later, AI rebuilt (matches R78); closure; 1500-3000 words; `published_content_v2` row
  - [ ] email subject "The Optimization - Epilogue"; chapter_count NOT incremented; snapshot; Prime Directive

### R80: Retrieve Outline — The Consulship of Gaius Varro
- **Engine route:** `library.retrieve` (info) · impl: built
- **Prerequisite:** R56
- **Command:**
  ```
  Retrieve the outline for "The Consulship of Gaius Varro"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.retrieve`, kind=data; full outline; Freytag structure; from `writing_projects_v2`

### R81: Revise Outline — Add Prologue and Epilogue to Gaius Varro, Then Write Prologue
- **Engine route:** `brainstorm.revise-outline` (task) then `chapter.write` (task) · impl: built
- **Prerequisite:** R80
- **Command (Step 1 — revise):**
  ```
  Revise the outline for "The Consulship of Gaius Varro". Add a prologue set during the founding of Rome — Romulus drawing the sacred boundary — as a mythic parallel to Varro's later struggle to hold the Republic's boundaries together. Add an epilogue set centuries later as a medieval monk transcribes Varro's lost writings, realizing the senator's warnings about the Republic's fall echo in his own era. Keep the existing chapters and Freytags Pyramid arc. Genre slug: ancient-history.
  ```
- **Expected — Step 1:**
  - [ ] routes to `brainstorm.revise-outline`, kind=queued; complete; Freytag preserved
  - [ ] outline gains Prologue (number=0, Romulus) + Epilogue (number=count+1, monk); `outline_versions_v2` snapshot; original chapters preserved; CR-009 email
- **Command (Step 2 — write prologue):**
  ```
  Write the prologue for "The Consulship of Gaius Varro". Genre slug: ancient-history.
  ```
- **Expected — Step 2:**
  - [ ] routes to `chapter.write`, kind=queued; complete; chapter_number=Prologue(0); labeled "Prologue"
  - [ ] content = Romulus/sacred boundary (matches Step 1); mythic tone distinct; 1500-3000 words; `published_content_v2` row chapter_number=0
  - [ ] email subject "The Consulship of Gaius Varro - Prologue"; `story_bible_v2` entries; snapshot; Prime Directive

## Section O: Outline Management — List, Version History, Revert (Tests R82–R93)

### R82: List All Outlines
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Command:**
  ```
  List all outlines
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.list-outlines`, kind=data; queries `writing_projects_v2` where outline non-null and != `{}`
  - [ ] each entry: title, genre_slug, chapter count, created date; projects without outlines excluded; does NOT fall through to a content search

### R83: List Outlines — Alternate Phrasing
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Command:**
  ```
  Show me my outlines
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.list-outlines`, kind=data; same result set as R82; stop words don't pollute the query

### R84: Outline Version History — The Accord
- **Engine route:** `library.versions` (info: list) · impl: built (E2E-2)
- **Prerequisite:** R71
- **Command:**
  ```
  Show outline version history for "The Accord"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.versions` (list, outline), kind=data; queries `outline_versions_v2` (case-insensitive title)
  - [ ] ≥1 version entry (R71 pre-revision snapshot); each entry: version_number, created_at, chapter count; chronological order

### R85: Outline Version History — The Correction
- **Engine route:** `library.versions` (info: list) · impl: built (E2E-2)
- **Prerequisite:** R75
- **Command:**
  ```
  Show outline version history for "The Correction"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.versions` (list, outline), kind=data; ilike match; ≥1 entry (pre-revision 10-ch, no prologue); chapter count accurate

### R86: Outline Version History — No Revisions
- **Engine route:** `library.versions` (info: list) · impl: built (E2E-2)
- **Prerequisite:** R58
- **Command:**
  ```
  Show outline version history for "Signal from the Deep"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.versions` (list, outline), kind=data; zero rows in `outline_versions_v2`
  - [ ] empty list or "No version history found"; no unhandled error / 500

### R87: Revert Outline — The Accord to Version 1
- **Engine route:** `library.revert` (task: outline) · impl: built (E2E-2)
- **Prerequisite:** R84
- **Command:**
  ```
  Revert the outline for "The Accord" to version 1
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.revert` (outline, version 1), kind=queued; job_id; complete
  - [ ] current outline snapshotted to `outline_versions_v2` before overwrite; v1 content loaded; `writing_projects_v2.outline` updated
  - [ ] reverted = original 10 chapters, no Prologue(0)/Epilogue(11); Freytag intact; confirmation names title + version

### R88: Verify Revert — Retrieve Reverted Outline
- **Engine route:** `library.retrieve` (info) · impl: built
- **Prerequisite:** R87
- **Command:**
  ```
  Retrieve the outline for "The Accord"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.retrieve`, kind=data; returns v1 content (exactly 10 chapters; no ch0/ch11); Freytag intact; briefs match original (not R71)

### R89: Revert Outline — The Optimization to Pre-Epilogue Version
- **Engine route:** `library.versions` (list) + `library.revert` (outline) · impl: built (E2E-2)
- **Prerequisite:** R78
- **Command (Step 1):**
  ```
  Show outline version history for "The Optimization"
  ```
- **Command (Step 2):**
  ```
  Revert the outline for "The Optimization" to version 1
  ```
- **Expected:**
  - [ ] Step 1 → `library.versions`, kind=data; ≥1 entry (pre-epilogue 8-ch); version_number/created_at/chapter count(8)
  - [ ] Step 2 → `library.revert`, kind=queued; complete; current (with-epilogue) snapshotted; outline updated to v1 (8 chapters, no epilogue); confirmation names title + version

### R90: Revert Outline — Invalid Version Number
- **Engine route:** `library.revert` (outline) · impl: built (E2E-2)
- **Prerequisite:** R84
- **Command:**
  ```
  Revert the outline for "The Accord" to version 99
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.revert`; version 99 not found → clear error (no silent failure)
  - [ ] `writing_projects_v2.outline` NOT modified; no new snapshot; job status=failed (or inline error) with informative error_message

### R91: Revert Outline — Project Not Found
- **Engine route:** `library.revert` (outline) · impl: built (E2E-2)
- **Command:**
  ```
  Revert the outline for "A Story That Does Not Exist" to version 1
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.revert`; project not found → clear error; nothing written/modified; job failed (or inline error) with informative error_message

### R92: Outline Revision Creates Version Snapshot
- **Engine route:** `brainstorm.revise-outline` (task) · impl: built
- **Prerequisite:** R87
- **Command:**
  ```
  Revise the outline for "The Accord". Add a prologue set during humanity's first contact with the alien signal — a radio astronomer alone in an observatory at 3 AM hearing a pattern in the static. Keep the existing 10 chapters and Freytags Pyramid structure. Genre slug: political-scifi.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `brainstorm.revise-outline`, kind=queued; complete
  - [ ] current (v1) outline snapshotted to `outline_versions_v2` before save; new Prologue(0) themed radio astronomer 3AM; 10 chapters preserved; no Epilogue
  - [ ] `writing_projects_v2.outline` updated; PRESERVE EXISTING CHARACTERS enforced; revised-outline email sent

### R93: Verify Version History After Multiple Revisions
- **Engine route:** `library.versions` (info: list) · impl: built (E2E-2)
- **Prerequisite:** R92
- **Command:**
  ```
  Show outline version history for "The Accord"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.versions` (list, outline), kind=data; ≥3 version entries (v1 original 10-ch; v2 prologue+epilogue; v3 pre-re-revision reverted state)
  - [ ] chronological order; each entry version_number/created_at/chapter count

## Section P: Delete, Undelete, List Deleted & Email Content (Tests R94–R105)

### R94: Delete a Draft
- **Engine route:** `library.lifecycle` (delete) · impl: built
- **Command:**
  ```
  Delete the draft titled "The Forgotten Engineers of Rome"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle` (delete), kind=queued; complete
  - [ ] `content_versions_v2` snapshot before delete (change_note "Auto-snapshot before delete"); status → 'deleted'; deletion email; item gone from drafts; soft delete (row retained)

### R95: Delete Published Item — Error
- **Engine route:** `library.lifecycle` (delete) · impl: built
- **Command:**
  ```
  Delete the published content titled "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle` (delete); detects status='published' → rejects with clear error (unpublish first); status unchanged; no snapshot; no email

### R96: List Deleted Items
- **Engine route:** `library.lifecycle` (list_deleted) · impl: built
- **Prerequisite:** R94
- **Command:**
  ```
  Show my deleted content
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle` (list_deleted), kind=data; queries status='deleted'; includes "The Forgotten Engineers of Rome"; up to 20 items

### R97: List Deleted — Filter by Type
- **Engine route:** `library.lifecycle` (list_deleted) · impl: built
- **Command:**
  ```
  Show my deleted blog posts
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle` (list_deleted, content_type_filter=blog_post), kind=data; only deleted blog posts; other types excluded

### R98: Undelete Content
- **Engine route:** `library.lifecycle` (undelete) · impl: built
- **Prerequisite:** R94
- **Command:**
  ```
  Undelete "The Forgotten Engineers of Rome"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.lifecycle` (undelete), kind=queued; complete; status 'deleted' → 'draft'; restore email; no longer in list-deleted

### R99: Verify Undelete — Item Returns to Drafts
- **Engine route:** `library.list-outlines` / `library.retrieve` (info) · impl: built
- **Prerequisite:** R98
- **Command:**
  ```
  List my drafts
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to library listing (status=draft), kind=data; "The Forgotten Engineers of Rome" present with status=draft

### R100: Email Outline
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Prerequisite:** R30
- **Command:**
  ```
  Email me the outline for "The Seed Vault"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.email-content` (content_type=outline), kind=queued; complete
  - [ ] reads outline JSONB from `writing_projects_v2`; renders structured HTML (characters + chapters, not raw JSON); email sent; subject references title + "outline"

### R101: Email Short Story
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Command:**
  ```
  Email me the short story about the Roman soldier and the Colosseum
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.email-content` (content_type=short_story), kind=queued; complete
  - [ ] searches `published_content_v2` by keywords; markdown→HTML; email sent; source = `published_content_v2`

### R102: Email Research Report
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Prerequisite:** R02
- **Command:**
  ```
  Email me the research report on "Post-Apocalyptic Fiction Trends 2026"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.email-content` (content_type=research), kind=queued; complete
  - [ ] reads from `research_reports_v2` (ilike title); HTML; email sent; subject references report

### R103: Email Chapter
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Prerequisite:** R31
- **Command:**
  ```
  Email me chapter 1 of "The Seed Vault"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.email-content` (content_type=chapter, chapter_number=1), kind=queued; complete
  - [ ] locates correct row in `published_content_v2`; markdown→HTML; email sent; subject "Chapter 1 — The Seed Vault"

### R104: Email Newsletter
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Command:**
  ```
  Email me the newsletter about revolutions that changed the world
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.email-content` (content_type=newsletter), kind=queued; complete
  - [ ] searches `published_content_v2` by keywords; HTML; email sent

### R105: Email Content Not Found
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Command:**
  ```
  Email me the short story titled "A Story That Definitely Does Not Exist"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes to `library.email-content`; no match found → clear "not found" message; no email; job failed (or inline error) with informative error_message

---

# PART 2 — VOICE WEBHOOK TESTS (V01–V40)

Voice tests POST the **simulated** spoken input to `POST /internal/hub/voice` `{user_message_request, system__caller_id:"+14105914612"}` (no live ElevenLabs agent). The webhook returns a FLAT `{response, kind, job_id?}`; routing is identical to chat. Callback tests (V24–V32) assert the `notify.eve-callback` op is invoked with the right payload (impl: built (E2E-5) — gated dry-run; real ElevenLabs calls fire only when an agent is configured, never the baseline-protected PROD agent).

## Section V-A: Core Voice Commands (V01–V18)

### V01: Voice — Deep Research
- **Voice webhook:** `{user_message_request:"Hey can you research what's going on with post apocalyptic fiction right now like what are the big trends and new books coming out? what are current hot amazon kindle keywords and best sellers?", system__caller_id:"+14105914612"}`
- **Engine route:** `research.run` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; routes `research.run`; job_id present; polls to complete; `research_reports_v2` row; CR-009 email; response is a research summary (not a generic ack)

### V02: Voice — Save Research
- **Voice webhook:** `{user_message_request:"Save that research as a report call it post apocalyptic trends twenty twenty six", system__caller_id:"+14105914612"}`
- **Engine route:** `research.run` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; routes `research.run`; job_id; complete; report in `research_reports_v2` with normalized title; CR-009 email; hub resolves "that research" from voice context

### V03: Voice — Email Report
- **Voice webhook:** `{user_message_request:"Send me an email with a summary of that research use the subject line voice test research report", system__caller_id:"+14105914612"}`
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Expected:** flat `{response, kind="queued"}`; routes `library.email-content`; job_id; complete; email to `app_config.recipient_email`; subject "voice test research report"; body = summary of saved report; BCC if configured

### V04: Voice — Write Blog Post
- **Voice webhook:** `{user_message_request:"Write a blog post about how AI is changing marketing in twenty twenty six genre slug ai marketing keywords AI tools marketing automation target about fifteen hundred words", system__caller_id:"+14105914612"}`
- **Engine route:** `chapter.blog` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; routes `chapter.blog`; maps "ai marketing"→`ai-marketing`; ~1500 words; Prime Directive; `published_content_v2` draft; CR-009 email

### V05: Voice — Write Newsletter
- **Voice webhook:** `{user_message_request:"Write me a newsletter for the political history genre about revolutions that changed the world date today", system__caller_id:"+14105914612"}`
- **Engine route:** `chapter.newsletter` (task) · impl: built (E2E-3)
- **Expected:** flat `{response, kind="queued"}`; routes newsletter saga; job_id; complete; `genre_slug=political-history`; date→today; `published_content_v2` draft; CR-009 email

### V06: Voice — Write Short Story
- **Voice webhook:** `{user_message_request:"Write a short story in the ancient history genre about a Roman soldier who discovers a hidden library beneath the Colosseum make it about three thousand words and research Roman military life and the Colosseum underground tunnels", system__caller_id:"+14105914612"}`
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; routes `chapter.short-story`; `ancient-history`; research on the 2 topics woven in; ~3000 words; Prime Directive; `published_content_v2` draft; CR-009 email

### V07: Voice — Generate Cover Art
- **Voice webhook:** `{user_message_request:"Generate cover art for a post apocalyptic story called The Last Signal show a figure on a rooftop with a radio antenna surrounded by flooded city at sunset", system__caller_id:"+14105914612"}`
- **Engine route:** `media.cover-art` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; routes `media.cover-art`; `post-apocalyptic`, title "The Last Signal"; prompt incorporates rooftop/antenna/flooded city/sunset; image artifact returned; CR-009 email

### V08: Voice — Social Media (Twitter)
- **Voice webhook:** `{user_message_request:"Take this and make twitter posts from it The Last Signal is a new story about a radio operator in flooded Manhattan picking up a mysterious broadcast platform twitter", system__caller_id:"+14105914612"}`
- **Engine route:** `media.social-posts` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; routes `media.social-posts`; platform=twitter; tweets ≤280 chars; CR-009 email

### V09: Voice — Social Media (LinkedIn)
- **Voice webhook:** `{user_message_request:"Repurpose that blog post about AI marketing into LinkedIn posts", system__caller_id:"+14105914612"}`
- **Engine route:** `media.social-posts` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; routes `media.social-posts`; platform=linkedin; resolves "that blog post" from context; LinkedIn-format; CR-009 email

### V10: Voice — Social Media (Instagram)
- **Voice webhook:** `{user_message_request:"Turn that time travel story about the Titanic into Instagram posts with lots of hashtags", system__caller_id:"+14105914612"}`
- **Engine route:** `media.social-posts` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; routes `media.social-posts`; platform=instagram; resolves "that time travel story" from context; 20-30 hashtags; CR-009 email

### V11: Voice — Brainstorm Story
- **Voice webhook:** `{user_message_request:"Brainstorm a new story called The Clockwork Rebellion its about sentient clockwork automatons in Victorian London who organize a labor revolution genre post apocalyptic eight chapters themes are freedom versus control and what makes someone human", system__caller_id:"+14105914612"}`
- **Engine route:** `brainstorm.story` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; routes `brainstorm.story`; maps "post apocalyptic"→`post-apocalyptic`; 8 chapters; themes present; `writing_projects_v2` row; CR-009 email

### V12: Voice — Write Chapter from Outline
- **Voice webhook:** `{user_message_request:"Write chapter one of The Clockwork Rebellion genre post apocalyptic chapter number one", system__caller_id:"+14105914612"}`
- **Engine route:** `chapter.write` (task) · impl: built
- **Prerequisite:** V11
- **Expected:** flat `{response, kind="queued"}`; routes `chapter.write`; loads outline; chapter consistent with outline; Prime Directive; `published_content_v2` draft; CR-009 email

### V13: Voice — List Drafts
- **Voice webhook:** `{user_message_request:"Show me my drafts", system__caller_id:"+14105914612"}`
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Expected:** flat `{response, kind="data"}`; routes `library.list-outlines` (status=draft); inline list in `response`; spoken-friendly; user-scoped

### V14: Voice — Approve and Publish
- **Voice webhook (approve):** `{user_message_request:"Approve the draft called [title from V13]", system__caller_id:"+14105914612"}`
- **Voice webhook (publish):** `{user_message_request:"Now publish it", system__caller_id:"+14105914612"}`
- **Engine route:** `library.lifecycle` (task) · impl: built
- **Expected:** approve → flat queued; job complete; status→approved; email. publish → resolves "it" from context; flat queued; complete; status→published; email

### V15: Voice — Reject Draft
- **Voice webhook:** `{user_message_request:"Reject the draft called [different title from V13]", system__caller_id:"+14105914612"}`
- **Engine route:** `library.lifecycle` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; op=reject; complete; status→rejected; email

### V16: Voice — Schedule Content
- **Voice webhook:** `{user_message_request:"Schedule the draft called [title from V13] for March twentieth twenty twenty six", system__caller_id:"+14105914612"}`
- **Engine route:** `library.lifecycle` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; op=schedule; parses date→2026-03-20; complete; status→scheduled; schedule_date stored; email

### V17: Voice — List Scheduled
- **Voice webhook:** `{user_message_request:"Show me my scheduled content", system__caller_id:"+14105914612"}`
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Expected:** flat `{response, kind="data"}`; status=scheduled filter; inline list with schedule_date; user-scoped

### V18: Voice — Story Bible
- **Voice webhook:** `{user_message_request:"Get the story bible for The Clockwork Rebellion", system__caller_id:"+14105914612"}`
- **Engine route:** `story_bible.list` (info) · impl: built
- **Prerequisite:** V12
- **Expected:** flat `{response, kind="data"}`; routes `story_bible.list`; inline character/location entries; user-scoped

## Section V-B: Voice Genre Inference & Edge Cases (V19–V23)

### V19: Voice — Genre Inference (Ambiguous)
- **Voice webhook:** `{user_message_request:"Write me a story about ancient Egypt like pharaohs and pyramids and stuff", system__caller_id:"+14105914612"}`
- **Engine route:** `chapter.short-story` (task) · impl: built
- **Expected:** flat queued; routes `chapter.short-story`; infers `ancient-history` from content; defaults fill missing params; Prime Directive; `published_content_v2`; CR-009 email

### V20: Voice — Messy/Natural Speech
- **Voice webhook:** `{user_message_request:"Um yeah so I want to uh write a blog post about like how political science fiction predicted the rise of like AI governance and surveillance states you know like nineteen eighty four and all that genre is political sci fi about two thousand words", system__caller_id:"+14105914612"}`
- **Engine route:** `chapter.blog` (task) · impl: built
- **Expected:** flat queued; routes `chapter.blog`; strips fillers; maps "political sci fi"→`political-scifi`; ~2000 words; Prime Directive; `published_content_v2`; CR-009 email

### V21: Voice — List Research Reports
- **Voice webhook:** `{user_message_request:"Show me all my research reports", system__caller_id:"+14105914612"}`
- **Engine route:** `library.list-outlines` (info) · impl: built
- **Expected:** flat `{response, kind="data"}`; content_type=research_report filter; inline list (title + date); user-scoped

### V22: Voice — Multi-Step Voice Workflow
- **Voice webhook (msg 1):** `{user_message_request:"Research the fall of the Roman Empire and why it collapsed", system__caller_id:"+14105914612"}`
- **Voice webhook (msg 2):** `{user_message_request:"Now write a blog post about that for the ancient history genre about fifteen hundred words", system__caller_id:"+14105914612"}`
- **Engine route:** msg1 `research.run`; msg2 `chapter.blog` (task) · impl: built
- **Expected:** msg1 flat queued → `research.run` → complete → `research_reports_v2`; msg2 resolves "that"; flat queued → `chapter.blog` → complete → ~1500 words incorporating research; both CR-009 emails

### V23: Voice — Retrieve Content (No Callback)
- **Voice webhook:** `{user_message_request:"Find my draft story about the Titanic", system__caller_id:"+14105914612"}`
- **Engine route:** `library.retrieve` (info) · impl: built
- **Expected:** flat `{response, kind="data"}`; routes `library.retrieve` (Titanic); inline summary (title/type/char count); NO outbound call; user-scoped

## Section V-C: Eve Knowledge Callback & Review Mode (V24–V32)

### V24: Voice — Retrieve Research Report (No Callback)
- **Voice webhook:** `{user_message_request:"Can you pull up my research report about post apocalyptic fiction trends", system__caller_id:"+14105914612"}`
- **Engine route:** `library.retrieve` (info) · impl: built
- **Expected:** flat `{response, kind="data"}`; content_type=research_report; inline summary; NO outbound call; user-scoped

### V25: Voice — Retrieve Draft Story (No Callback)
- **Voice webhook:** `{user_message_request:"Find my draft short story about the Titanic", system__caller_id:"+14105914612"}`
- **Engine route:** `library.retrieve` (info) · impl: built
- **Expected:** flat `{response, kind="data"}`; match from `published_content_v2`; inline (title/type/char count); NO outbound call

### V26: Voice — Retrieve & Callback — Review Mode
- **Voice webhook:** `{user_message_request:"Pull up my draft blog post about aqueducts and call me back so we can revise it", system__caller_id:"+14105914612"}`
- **Engine route:** `notify.eve-callback` (task) · impl: built (E2E-5)
- **Expected:** flat `{response, kind="queued"}`; routes `notify.eve-callback`; job_id; complete; hub detects "call me back"; sub-steps: retrieve aqueducts post → remove stale "Eve Session:" KB docs → upload content_text as KB doc → set `review` first_message → outbound call to +14105914612 → schedule greeting reset; assert op payload `{content_type:"blog", content_title, content_text, callback_mode:"review", phone:"+14105914612"}`

### V27: Voice — Retrieve & Callback — Brainstorm Mode
- **Voice webhook:** `{user_message_request:"Load the research report on post apocalyptic trends and call me back let's brainstorm a new story outline from it", system__caller_id:"+14105914612"}`
- **Engine route:** `notify.eve-callback` (task) · impl: built (E2E-5)
- **Expected:** flat `{response, kind="queued"}`; routes `notify.eve-callback`; complete; retrieve report → KB cleanup → upload → `brainstorm` first_message → outbound call → reset; assert payload `{content_type:"research_report", callback_mode:"brainstorm", phone:"+14105914612"}`; Eve references report data points (KB upload verified)

### V28: Voice — Callback Review with Editorial Feedback
- **Voice webhook:** `{user_message_request:"Get my short story about the Roman soldier under the Colosseum and help me improve it", system__caller_id:"+14105914612"}`
- **Engine route:** `notify.eve-callback` (task) · impl: built (E2E-5)
- **Prerequisite:** V06
- **Expected:** flat `{response, kind="queued"}`; routes `notify.eve-callback`; complete; "help me improve" = review intent; retrieve → KB cleanup → upload → `review` first_message → outbound call; assert payload `{callback_mode:"review", content_type:"short_story", phone:"+14105914612"}`; Eve can give specific editorial feedback (KB upload verified)

### V29: Voice — KB Cleanup (Back-to-Back Retrievals)
- **Voice webhook (1):** `{user_message_request:"Pull up my research report about post apocalyptic trends and call me back to review it", system__caller_id:"+14105914612"}`
- **Voice webhook (2):** `{user_message_request:"Now pull up my draft blog post about aqueducts and call me back to revise that instead", system__caller_id:"+14105914612"}`
- **Engine route:** `notify.eve-callback` (task) · impl: built (E2E-5)
- **Expected:** both flat queued; both complete; call 1 cleans prior KB then uploads report; call 2 cleans report KB then uploads blog; after call 2 KB has exactly ONE "Eve Session:" doc (the blog); Eve references blog content not the report (cleanup verified); assert 2nd payload content_type="blog"

### V30: Voice — Content Not Found
- **Voice webhook:** `{user_message_request:"Pull up my draft story about alien wizards on Neptune and call me back", system__caller_id:"+14105914612"}`
- **Engine route:** `notify.eve-callback` (task) · impl: built (E2E-5)
- **Expected:** flat `{response, kind="data"}` with error (no job_id, no callback); retrieve returns found=false; `notify.eve-callback` NOT invoked; no outbound call; no KB op; response = not-found message; assert callback op not called when retrieve found=false

### V31: Voice — Parallel Tasks + Callback
- **Voice webhook:** `{user_message_request:"Write a newsletter about ancient Roman festivals for the ancient history genre and also pull up my research report about post apocalyptic trends and call me back to brainstorm", system__caller_id:"+14105914612"}`
- **Engine route:** `chapter.newsletter` + `notify.eve-callback` (multi-task fan-out) · impl: built (E2E-3/E2E-5)
- **Expected:** hub detects 2 tasks; flat queued (one or two job_ids); task1 newsletter → complete → CR-009 email; task2 `notify.eve-callback` → complete → KB load + outbound call (callback_mode=brainstorm); both ops invoked

### V32: Voice — Centralized Email Verification
- **Voice webhook:** `{user_message_request:"Send me an email report with just the text centralized email voice test and subject line V32 Email Config Test", system__caller_id:"+14105914612"}`
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Expected:** flat `{response, kind="queued"}`; routes `library.email-content`; complete; email to `app_config.recipient_email` (not hardcoded); subject "V32 Email Config Test"; body contains "centralized email voice test"; BCC if configured

## Section V-D: Voice — Delete, Undelete, List Deleted & Email Content (V33–V40)

### V33: Voice — Delete Draft
- **Voice webhook:** `{user_message_request:"Delete the draft called The Forgotten Engineers of Rome", system__caller_id:"+14105914612"}`
- **Engine route:** `library.lifecycle` (task) · impl: built
- **Expected:** flat `{response, kind="queued"}`; op=delete; complete; status→deleted; user-scoped; deletion email

### V34: Voice — Delete Published Error
- **Voice webhook:** `{user_message_request:"Delete the published blog post about post apocalyptic fiction", system__caller_id:"+14105914612"}`
- **Engine route:** `library.lifecycle` (task) · impl: built
- **Expected:** flat `{response, kind="data"}` error (or queued job with error result); op=delete; enforces unpublish-first rule; no status change; error message; no deletion email

### V35: Voice — List Deleted (Trash)
- **Voice webhook:** `{user_message_request:"Show me my trash", system__caller_id:"+14105914612"}`
- **Engine route:** `library.lifecycle` (info) · impl: built
- **Expected:** flat `{response, kind="data"}`; maps "trash"→list_deleted; inline list; user-scoped; title + content_type

### V36: Voice — Undelete
- **Voice webhook:** `{user_message_request:"Undelete The Forgotten Engineers of Rome put it back in drafts", system__caller_id:"+14105914612"}`
- **Engine route:** `library.lifecycle` (task) · impl: built
- **Prerequisite:** V33
- **Expected:** flat `{response, kind="queued"}`; op=undelete; complete; status deleted→draft; maps "put it back in drafts"→draft; email

### V37: Voice — Email Outline
- **Voice webhook:** `{user_message_request:"Can you email me the outline for The Seed Vault I want to look at it on my phone", system__caller_id:"+14105914612"}`
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Expected:** flat queued; content_type=outline; complete; reads outline from `writing_projects_v2`; HTML email to `app_config.recipient_email`; subject references title + "outline"; BCC if configured

### V38: Voice — Email Short Story
- **Voice webhook:** `{user_message_request:"Send me the short story about the Roman soldier by email", system__caller_id:"+14105914612"}`
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Prerequisite:** V06
- **Expected:** flat queued; content_type=short_story; complete; reads from `published_content_v2` (user-scoped); HTML email; subject references title; BCC if configured

### V39: Voice — Email Research Report
- **Voice webhook:** `{user_message_request:"Email me that research report on post apocalyptic fiction trends", system__caller_id:"+14105914612"}`
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Prerequisite:** V02
- **Expected:** flat queued; content_type=research; complete; resolves to report in `research_reports_v2`; HTML email; subject references report; BCC if configured

### V40: Voice — Email Chapter
- **Voice webhook:** `{user_message_request:"Send me chapter one of The Seed Vault in an email", system__caller_id:"+14105914612"}`
- **Engine route:** `library.email-content` (task) · impl: built (E2E-1)
- **Expected:** flat queued; content_type=chapter, chapter_number=1; complete; reads from `published_content_v2` (user-scoped); HTML email; subject "The Seed Vault — Chapter 1"; BCC if configured

---

# PART 8 — Chapter Outline & Story Arc Writing Process (R110–R121)

End-to-end test of the 3-step process: brainstorm book outline (with arc) → brainstorm chapter outline (sub-chapters) → write chapter. Tests arc integration, dual-arc support, sub-chapter structure, prev/next context, and consistency. **Prereqs:** story arcs loaded in `story_arcs_v2`; DEV user `+14105914612`.

### R110 — Brainstorm Book Outline with Story Arc
- **Engine route:** `brainstorm.story` (task) · impl: built (E2E-4)
- **Prerequisite:** "The Hero's Journey" arc in `story_arcs_v2`
- **Command:**
  ```
  Brainstorm a book using the Hero's Journey called "The Signal Beneath."
  Genre: post-apocalyptic. 8 chapters.
  Premise: A radio operator in a collapsed coastal city intercepts a signal from
  a submerged research station. The signal contains coordinates and a child's voice.
  She must decide whether to investigate alone or alert the warlord who controls
  the only working boat.
  Themes: sacrifice, trust, the cost of knowledge.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes `brainstorm.story`, kind=queued; job_id; status=completed
  - [ ] `writing_projects_v2` "The Signal Beneath" with `outline.story_arc_name`="The Hero's Journey"; 8 chapters
  - [ ] each chapter `arc_notes` references Hero's Journey stages; `outline.characters` populated (name/role/arc/description)
  - [ ] CR-009 email with outline; no 5xx

### R111 — Brainstorm Chapter Outline for Prologue (Same Arc)
- **Engine route:** `chapter.plan` (task) · impl: built (E2E-4)
- **Prerequisite:** R110
- **Command:**
  ```
  Create a chapter outline for the Prologue of "The Signal Beneath"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes `chapter.plan`, kind=queued (NOT chapter.write); completed
  - [ ] `writing_projects_v2.outline.chapters[prologue].chapter_outline.sub_chapters` 3–7 entries; each: number/title/brief/arc_beat/characters/setting/emotional_tone/connects_to_book_arc
  - [ ] character names match book outline exactly; arc_beat = Hero's Journey stages; chapter_story_arc inherited; book_arc_beat present
  - [ ] CR-009 email; no chapter prose written

### R112 — Brainstorm Chapter Outline for Chapter 1 (Same Arc)
- **Engine route:** `chapter.plan` (task) · impl: built (E2E-4)
- **Prerequisite:** R110, R111
- **Command:**
  ```
  Create a chapter outline for Chapter 1 of "The Signal Beneath"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes `chapter.plan`, kind=queued; completed; sub_chapters 3–7
  - [ ] briefs reflect book Ch1 brief (no drift); Prologue context injected (acknowledges prior events); Ch2 context injected (sets up hook); names match book outline; saved to outline; CR-009 email

### R113 — Brainstorm Chapter Outline with Different Story Arc
- **Engine route:** `chapter.plan` (task) · impl: built (E2E-4)
- **Prerequisite:** R110; "Fichtean Curve" in `story_arcs_v2`
- **Command:**
  ```
  Create a chapter outline for Chapter 2 of "The Signal Beneath" using the Fichtean Curve
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes `chapter.plan`, `chapter_story_arc`="Fichtean Curve"; completed
  - [ ] chapter_story_arc distinct from book's Hero's Journey; arc_beat = Fichtean stages; connects_to_book_arc still references Hero's Journey Ch2 stage; both arc prompt_texts loaded; no cross-contamination; CR-009 email

### R114 — Write Prologue (After Chapter Outline Exists)
- **Engine route:** `chapter.write` (task) · impl: built (E2E-4)
- **Prerequisite:** R111
- **Command:**
  ```
  Write the Prologue for "The Signal Beneath"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes `chapter.write`, kind=queued; completed; auto-loads sub_chapters (none passed in body)
  - [ ] prose follows sub-chapter sequence; scene breaks `---` between sub-chapters; names match book outline; Hero's Journey prompt injected
  - [ ] `published_content_v2` row (content_type=chapter, "Prologue — The Signal Beneath"); `content_versions_v2` snapshot; 1500-3000 words; CR-009 email

### R115 — Write Chapter 1 (After Chapter Outline Exists)
- **Engine route:** `chapter.write` (task) · impl: built (E2E-4)
- **Prerequisite:** R110, R111, R112, R114
- **Command:**
  ```
  Write Chapter 1 of "The Signal Beneath"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes `chapter.write`, kind=queued; completed; auto-loads Ch1 sub_chapters
  - [ ] prose follows sub-chapter sequence in order; consistent with Prologue (story bible cross-ref); follows book Ch1 brief; arc notes reflected
  - [ ] `published_content_v2` row; `content_versions_v2` snapshot; 3000-5000 words; ends on hook into Ch2; CR-009 email

### R116 — Write Chapter Without Chapter Outline (Should Trigger Brainstorm First)
- **Engine route:** `chapter.plan` (task) · impl: built (E2E-4)
- **Prerequisite:** R110; no chapter outline for Ch3
- **Command:**
  ```
  Write Chapter 3 of "The Signal Beneath"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] engine detects no chapter_outline for Ch3 → routes `chapter.plan` FIRST (NOT chapter.write); kind=queued; completed
  - [ ] chapter outline generated + saved; CR-009 email says "outline emailed for review"; chapter.write NOT called; no prose written; chat response says review the outline before writing

### R117 — Write Chapter for Book Without Book Outline (Should Fail Gracefully)
- **Engine route:** `library.retrieve` (info) → graceful failure · impl: built
- **Prerequisite:** "A Book That Does Not Exist Yet" not in `writing_projects_v2`
- **Command:**
  ```
  Write Chapter 1 of "A Book That Does Not Exist Yet"
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] project-existence check finds nothing → kind=data (inline error), NOT queued
  - [ ] message: no book outline exists; suggests brainstorm.story first; chapter.write/plan NOT called; no `published_content_v2` row; no crash/5xx

### R118 — Revise Chapter Outline
- **Engine route:** `brainstorm.revise-outline` or `chapter.plan` re-run (task) · impl: built (E2E-4)
- **Prerequisite:** R112
- **Command:**
  ```
  Revise the chapter outline for Chapter 1 of "The Signal Beneath."
  Make sub-chapter 2 focus more on the protagonist's internal conflict about
  whether to trust the warlord. Add a scene where she finds her dead partner's
  journal in the radio station.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes revise (revise-outline or chapter.plan w/ instructions), kind=queued; completed
  - [ ] prior Ch1 chapter outline snapshotted (content_versions_v2 or outline_versions_v2) before overwrite
  - [ ] sub-chapter 2 emphasizes internal conflict; new sub-chapter for the journal scene; other sub-chapters preserved; names match book outline; saved to outline; CR-009 email

### R119 — Consistency Check: Character Names
- **Engine route:** `chapter.qa` (task) · impl: built (E2E-4, deterministic name cross-check)
- **Prerequisite:** R115
- **Command:**
  ```
  Check Chapter 1 of "The Signal Beneath" for character name consistency with the book outline
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes `chapter.qa`, kind=queued; completed; loads Ch1 prose + character roster from `writing_projects_v2.outline.characters`
  - [ ] every name verified against the roster; no invented names; roles consistent; no renamed characters (e.g. "Maya"≠"Maria"); QA report inline or via CR-009 email listing discrepancies/confirming consistency

### R120 — Kishōtenketsu Chapter Arc (No Conflict Structure)
- **Engine route:** `chapter.plan` (task) · impl: built (E2E-4)
- **Prerequisite:** R110; "Kishōtenketsu" in `story_arcs_v2`; no outline for Ch4
- **Command:**
  ```
  Create a chapter outline for Chapter 4 of "The Signal Beneath" using Kishōtenketsu.
  This should be a quieter chapter — the protagonist reaches the coast and
  observes the submerged station from the shore. No combat, no confrontation.
  Focus on contrast and reflection.
  ```
- **Expected (engine fully implemented — all must pass):**
  - [ ] routes `chapter.plan`, `chapter_story_arc`="Kishōtenketsu"; completed
  - [ ] arc_beat values = Ki/Shō/Ten/Ketsu; no forced conflict beats; Ten = contrast/revelation (not combat); connects_to_book_arc still references Hero's Journey Ch4 stage; Kishōtenketsu prompt loaded; CR-009 email

### R121 — Full Pipeline: Outline → Chapter Outline → Write → Verify
- **Engine route:** `library.retrieve` → `chapter.plan` → `chapter.write` · impl: built (E2E-4)
- **Prerequisite:** R110; "Dan Harmon's Story Circle" in `story_arcs_v2`; no outline for Ch5
- **Command (Step 1):**
  ```
  List the outline for "The Signal Beneath"
  ```
- **Expected — Step 1:** routes `library.retrieve`, kind=data; full book outline (story_arc_name="The Hero's Journey", 8 chapters with briefs+arc notes, characters with roles)
- **Command (Step 2):**
  ```
  Create a chapter outline for Chapter 5 of "The Signal Beneath" using Dan Harmon's Story Circle
  ```
- **Expected — Step 2:** routes `chapter.plan`, `chapter_story_arc`="Dan Harmon's Story Circle"; completed; arc_beat = all 8 Story Circle beats; chapter_story_arc set + book_arc_beat references Ch5 Hero's Journey stage; saved to outline
- **Command (Step 3):**
  ```
  Write Chapter 5 of "The Signal Beneath"
  ```
- **Expected — Step 3:** routes `chapter.write`, kind=queued; completed; follows book outline (Ch5 brief + Hero's Journey position) AND chapter outline (Story Circle sub-chapter sequence); names consistent with R114/R115 (story bible cross-check); no drift from premise/themes; `published_content_v2` row; `content_versions_v2` snapshot; CR-009 email

### Chapter Outline Process — quick map (R110–R121)
| Test | Route | Tests |
|---|---|---|
| R110 | `brainstorm.story` | book outline saves story_arc_name + per-chapter arc_notes |
| R111 | `chapter.plan` | prologue outline w/ sub_chapters, inherited arc |
| R112 | `chapter.plan` | Ch1 outline w/ prev/next context |
| R113 | `chapter.plan` | per-chapter arc override (Fichtean) + dual-arc fields |
| R114 | `chapter.write` | write prologue auto-loading sub_chapters, scene breaks |
| R115 | `chapter.write` | write Ch1 from outline, story bible cross-check |
| R116 | `chapter.plan` | auto-plan guard when chapter outline missing |
| R117 | `library.retrieve`→graceful fail | clear error when no book outline |
| R118 | `brainstorm.revise-outline`/`chapter.plan` | revise chapter outline w/ snapshot |
| R119 | `chapter.qa` | character-name consistency |
| R120 | `chapter.plan` | non-conflict arc (Kishōtenketsu) |
| R121 | `library.retrieve`→`chapter.plan`→`chapter.write` | end-to-end pipeline |

**Minimum smoke test:** R110, R111, R114, R112, R115 in sequence.

---

## Appendix — what blocks the full run (→ [[engine-e2e-parity-sprints]])

The `impl: pending` tests above are blocked only by these gaps (the sprint set implements exactly these):
- **`library.email-content`** → R03, R05, R100–R105, V03, V32, V37–V40
- **`library.versions`** → R28, R29, R84–R86, R89, R93
- **`library.revert`** → R87, R89, R90, R91
- **newsletter as a hub op** → R07, R16, R44, V05, V31
- **`notify.eve-callback`** (real ElevenLabs KB + outbound call) → V26–V31
- **`chapter.plan` dual-arc depth** (story_arc param/override, sub_chapters schema, prev/next context, non-conflict arcs, auto-plan guard) → R54–R69 arc fidelity, R110–R121

Everything else is `built` and runnable today against the DEV engine.
