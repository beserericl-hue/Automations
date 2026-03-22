# The Author Agent — Smoke Test Suite

> **Purpose:** Quick health check of all critical paths. If **two or more tests fail**, stop and run the [Full Regression Test Suite](regressiontest_prompts.md) (108 tests).
>
> **Estimated time:** 30–45 minutes for chat tests, 30–45 minutes for voice tests.
>
> **How to run:** Chat tests use the n8n chat trigger. Voice tests use Eve (ElevenLabs voice agent). Run in order — some tests depend on earlier results.
>
> **Pass criteria:** Each test lists specific expected outcomes. A test **passes** when ALL expected outcomes are met.

---

## Quick Reference

| Tool | Workflow ID | What It Does |
|------|------------|--------------|
| deep_research_topic | (native Perplexity node) | Live research with citations |
| email_report | QAbYfOOd05lyesva | Send markdown report via email |
| write_blog_post | iMBIWzO2PjsLNH9w | Write SEO blog post + cover art + email |
| write_newsletter | cjIUEjrqvyGZyKwN | Write newsletter + email |
| write_short_story | LTZ63B2H0w8Sl4FW | Full short story + cover art + email |
| write_chapter | tpj55Sf66jrBPNT8 | Book chapter + story bible update + email |
| generate_cover_art | SxeLHxzvITEKyKc0 | DALL-E image + email |
| repurpose_to_social | 95z13RGuzJDHVNSw | Social posts for Twitter/LinkedIn/Facebook/Instagram |
| manage_library | 1JERh5yJ3yDJka8s | Draft/publish lifecycle management |
| brainstorm_story | StwejB5GLFE26hmU | Research + outline + save to writing_projects |
| retrieve_content | DQS2zIhVjyuxabcb | Search & fetch any saved content |
| eve_knowledge_callback | PaFJlsxWq4BKt0iq | Load content into Eve KB + trigger outbound call |
| manage_story_bible | 9cvuhBS412AQRJxf | Read/update story bible entries |

---

# PART 1: CHAT SMOKE TESTS (S01–S17)

## Group A: Core Infrastructure (S01–S03)

These verify Perplexity, email delivery, and centralized email config — foundations everything else depends on.

---

### S01: Deep Research (Perplexity)

**Tests:** Perplexity API credential, sonar model, tool routing

**Ref:** R01

```
Research the current state of post-apocalyptic fiction in 2026. What are the trending themes, notable new releases, and how has the genre evolved since COVID? Include citations.
```

**Expected:**
- [ ] Agent calls `deep_research_topic` (not answering from training data)
- [ ] Response includes citations/sources
- [ ] No email sent (research stays in chat)

**If it fails:** Check Perplexity credential `ggr9QCRobQVA6Lwb`. Stop — most writing workflows depend on research.

---

### S02: Centralized Email Config

**Tests:** Hub reads recipient_email from app_config (Supabase), not hardcoded

**Ref:** R05

```
Send me an email report with this content:

# Centralized Email Test

This test verifies that the hub reads recipient_email from the app_config table in Supabase.

Use subject line "Smoke Test: Centralized Email Config"
```

**Expected:**
- [ ] Email arrives at the address stored in `app_config.recipient_email`
- [ ] If `bcc_email` is set, BCC recipient also receives it
- [ ] No hardcoded email addresses used

**If it fails:** Check `app_config` table in Supabase for `recipient_email` row. Check `hub_settings` Code node.

---

### S03: Email Report (Formatted HTML)

**Tests:** email_report tool, Gmail credential, markdown-to-HTML rendering

**Ref:** R03

```
Send me an email report with this content:

# Smoke Test Report

## Key Findings
- Climate fiction is merging with post-apocalyptic themes
- AI apocalypse stories have surged 300% since 2024

## Recommended Reading
1. "The Last Garden" by Sarah Chen
2. "Ash Protocol" by Marcus Webb

Use subject line "Smoke Test: Email Report"
```

**Expected:**
- [ ] Agent calls `email_report`
- [ ] Email arrives with formatted HTML (headings, bullet points, numbered list)
- [ ] Subject line matches

**If it fails:** Check Gmail credential `CPCSZOInV8Zj1PI1`.

---

## Group B: Writing Tools (S04–S07)

These test the four primary content creation workflows — blog, short story, brainstorm, and chapter.

---

### S04: Write Blog Post (with Prime Directive)

**Tests:** write_blog_post, Perplexity research, cover art, content library draft, Writing Prime Directive

**Ref:** R06, R43

```
Write a blog post for the post-apocalyptic genre. Topic: "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026". Genre slug: post-apocalyptic. Keywords: post-apocalyptic books, climate fiction, survival stories, dystopian novels. Target length: 1500 words.
```

**Expected:**
- [ ] Agent calls `write_blog_post`
- [ ] Blog post written in post-apocalyptic tone (gritty, visceral)
- [ ] **Prime Directive check:** No cliches (revolutionize, game-changing, unleash, delve, cutting-edge, leverage). Short paragraphs. Concrete examples. Reads like a human wrote it.
- [ ] Cover art generated (ruins, decay, atmospheric)
- [ ] Email arrives with blog content
- [ ] Draft saved to `published_content` (content_type=blog_post, status=draft)

**If it fails:** Check Anthropic credential, Perplexity credential, OpenAI credential for DALL-E, Gmail credential.

---

### S05: Write Short Story

**Tests:** write_short_story, Perplexity research, style analysis, cover art, full pipeline

**Ref:** R08

```
Write a short story. Genre slug: historical-time-travel. Premise: A historian discovers that antique photographs can transport her to the moment they were taken. She finds a photo of the Titanic's maiden voyage departure and must decide whether to warn the passengers. Tone: literary, bittersweet. Length: 2500 words. Research topics: ["Titanic maiden voyage Southampton 1912", "history of early photography techniques", "time travel paradoxes in fiction"]
```

**Expected:**
- [ ] Agent calls `write_short_story`
- [ ] Story uses historical-time-travel tone (meticulous, wonder-infused)
- [ ] Perplexity researches all 3 topics
- [ ] Cover art generated (period-appropriate imagery)
- [ ] Email arrives with complete story
- [ ] Draft saved to `published_content` (content_type=short_story)
- [ ] **Prime Directive check:** Clear language, genuine emotion, concrete details

**If it fails:** Check sequential flow (research → style_analysis → build_prompt). Check cover art sub-workflow.

---

### S06: Brainstorm Story (with Story Arc)

**Tests:** brainstorm_story, story arc loading from DB, outline saved to writing_projects

**Ref:** R30

```
Brainstorm a post-apocalyptic story called "The Seed Vault" about the last botanist on Earth protecting the Svalbard seed vault from raiders who don't understand its value. Themes: preservation, sacrifice, legacy, nature vs. human destruction. 6 chapters. Genre slug: post-apocalyptic.
```

**Expected:**
- [ ] Agent calls `brainstorm_story`
- [ ] Email arrives with HTML-formatted outline:
  - Title, premise, themes
  - Character profiles (name, role, arc, description)
  - 6 chapter breakdowns (number, title, brief, arc_notes, research_topics)
- [ ] `writing_projects` row created with `outline` JSONB populated
- [ ] Outline language is clear and direct (Prime Directive)

**If it fails:** Check Brainstorm Story workflow (StwejB5GLFE26hmU). Check `writing_projects` table.

---

### S07: Write Chapter from Stored Outline + Story Bible

**Tests:** write_chapter auto-loads outline, story bible creation, chapter written from outline context

**Prerequisite:** S06 must have succeeded.

```
Write chapter 1 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 1.
```

**Expected:**
- [ ] Agent calls `write_chapter` — loads outline automatically from `writing_projects`
- [ ] Chapter references specific characters and plot from brainstormed outline
- [ ] Story bible entries created for Chapter 1 characters/locations
- [ ] Email arrives with chapter and cover art
- [ ] Draft saved to `published_content`

**If it fails:** Check `writing_projects.outline` has data from S06. Check `build_chapter_prompt` node.

---

## Group C: Content Library Lifecycle (S08–S12)

These test the draft → approve → publish pipeline and scheduling.

---

### S08: List Drafts

**Tests:** manage_library list_drafts operation

**Prerequisite:** S04 and S05 must have succeeded (drafts exist).

```
List my drafts
```

**Expected:**
- [ ] Agent calls `manage_library` with operation=list_drafts
- [ ] Returns formatted list with title, content_type, genre, date
- [ ] Blog post from S04 and short story from S05 appear in results

---

### S09: Approve Draft

**Tests:** manage_library approve operation, version snapshot, email notification

```
Approve the draft titled "[exact title from S08 — use the blog post title]"
```

**Expected:**
- [ ] Status changes from draft to approved
- [ ] Email notification received confirming approval
- [ ] Version snapshot auto-saved to `content_versions` table

---

### S10: Publish Content

**Tests:** manage_library publish operation, published_at timestamp

**Prerequisite:** S09 must have succeeded.

```
Publish the content titled "[same title from S09]"
```

**Expected:**
- [ ] Status changes from approved to published
- [ ] `published_at` timestamp is set
- [ ] Email notification received confirming publication
- [ ] Version snapshot saved

---

### S11: Schedule Publishing

**Tests:** manage_library schedule operation, schedule_date in metadata

```
Schedule the draft titled "[use the short story title from S08]" for 2026-03-25
```

**Expected:**
- [ ] Status changes to scheduled
- [ ] Metadata contains schedule_date = "2026-03-25"
- [ ] Email notification confirms scheduling with the date

---

### S12: List Scheduled Content

**Tests:** manage_library list_scheduled operation

```
List my scheduled content
```

**Expected:**
- [ ] Returns list including the item scheduled in S11
- [ ] Shows the scheduled date

---

## Group D: Content Retrieval & Outline Management (S13–S16)

These test retrieve_content, story arcs, outline listing, and story bible.

---

### S13: List Story Arcs

**Tests:** retrieve_content with content_type=story_arc

**Ref:** R53

```
List the story arcs
```

**Expected:**
- [ ] Returns both arcs: **Freytags Pyramid** and **Three-Act Structure**
- [ ] Each arc has a description
- [ ] Agent does NOT call brainstorm_story or any writing tool

---

### S14: List All Outlines

**Tests:** retrieve_content list_outlines operation

**Prerequisite:** S06 must have succeeded (at least one outline exists).

**Ref:** R82

```
List all outlines
```

**Expected:**
- [ ] Returns list of all projects with saved outlines
- [ ] Each entry shows project title, genre_slug, chapter count
- [ ] "The Seed Vault" appears in the list

---

### S15: Story Bible Read After Chapter

**Tests:** manage_story_bible get operation, entries from chapter writing

**Prerequisite:** S07 must have succeeded.

**Ref:** R32

```
Get the story bible for project "The Seed Vault"
```

**Expected:**
- [ ] Returns character entries, location entries, plot threads from Chapter 1
- [ ] Entries have chapter_introduced=1

---

### S16: Cover Art (Standalone)

**Tests:** generate_cover_art, DALL-E, genre art guidelines

**Ref:** R09

```
Generate cover art for a political-scifi short story called "The Senate of Stars". The story is about a diplomat navigating a galactic parliament where every species has a fundamentally different concept of justice. Genre slug: political-scifi. The image should show a vast circular chamber with alien delegates, lit by the light of a dying star through a massive viewport.
```

**Expected:**
- [ ] Agent calls `generate_cover_art`
- [ ] Image generated via DALL-E
- [ ] Art style matches political-scifi guidelines (dark, imposing, cerebral)
- [ ] Email arrives with image
- [ ] No text/words in the image

---

## Group E: Social Media (S17)

---

### S17: Repurpose to Social — Twitter

**Tests:** repurpose_to_social, platform-specific formatting

**Ref:** R10

```
Repurpose this into Twitter posts: "The Senate of Stars is a new political sci-fi short story about a diplomat navigating a galactic parliament where every species has a different concept of justice. A meditation on diplomacy, compromise, and whether true fairness is even possible across civilizations." Platform: twitter.
```

**Expected:**
- [ ] Agent calls `repurpose_to_social` with platform=twitter
- [ ] Thread of tweets, each under 280 characters
- [ ] Includes relevant hashtags
- [ ] Email arrives with formatted tweets
- [ ] **Prime Directive:** No cliches, no hype

---

# PART 2: VOICE SMOKE TESTS (VS01–VS17)

> **How to run:** Speak these commands to Eve (ElevenLabs voice agent). Eve POSTs to the hub webhook at `/author_request`.
>
> **Important:** Voice transcriptions are imperfect — words get misheard, sentences run together. These tests simulate real voice usage.

---

## Group F: Core Voice — Writing (VS01–VS07)

These mirror the chat writing tests — verifying that Eve correctly routes voice commands to every writing workflow.

---

### VS01: Voice — Deep Research

**Speak:**
> "Hey can you research what's going on with post apocalyptic fiction right now like what are the big trends and new books coming out? what are current hot amazon kindle keywords and best sellers?"

**Expected:**
- [ ] Agent calls `deep_research_topic`
- [ ] Returns research summary in chat

**Ref:** V01

---

### VS02: Voice — Write Blog Post

**Speak:**
> "Write a blog post about how AI is changing marketing in twenty twenty six genre slug ai marketing keywords AI tools marketing automation target about fifteen hundred words"

**Expected:**
- [ ] Agent maps to `write_blog_post` with genre_slug=ai-marketing
- [ ] Blog written and emailed
- [ ] No cliches (Writing Prime Directive active)

**Ref:** V04

---

### VS03: Voice — Write Newsletter

**Speak:**
> "Write me a newsletter for the political history genre about revolutions that changed the world date today"

**Expected:**
- [ ] Agent maps to `write_newsletter` with genre_slug=political-history
- [ ] Newsletter emailed with subject line, intro, sections, outro
- [ ] Citation URLs preserved from Perplexity research

**Ref:** V05

---

### VS04: Voice — Write Short Story

**Speak:**
> "Write a short story in the ancient history genre about a Roman soldier who discovers a hidden library beneath the Colosseum make it about three thousand words and research Roman military life and the Colosseum underground tunnels"

**Expected:**
- [ ] Agent maps to `write_short_story` with genre_slug=ancient-history
- [ ] Perplexity researches topics
- [ ] Story written and emailed
- [ ] Cover art generated

**Ref:** V06

---

### VS05: Voice — Brainstorm Story

**Speak:**
> "Brainstorm a new story called The Clockwork Rebellion its about sentient clockwork automatons in Victorian London who organize a labor revolution genre post apocalyptic eight chapters themes are freedom versus control and what makes someone human"

**Expected:**
- [ ] Agent maps to `brainstorm_story`
- [ ] Outline emailed with character profiles and chapter breakdowns
- [ ] Saved to `writing_projects`

**Ref:** V11

---

### VS06: Voice — Write Chapter from Outline

**Prerequisite:** VS05 must have succeeded.

**Speak:**
> "Write chapter one of The Clockwork Rebellion genre post apocalyptic chapter number one"

**Expected:**
- [ ] Agent maps to `write_chapter`
- [ ] Loads stored outline from `writing_projects`
- [ ] Chapter written and emailed
- [ ] Story bible entries created

**Ref:** V12

---

### VS07: Voice — Generate Cover Art

**Speak:**
> "Generate cover art for a post apocalyptic story called The Last Signal show a figure on a rooftop with a radio antenna surrounded by flooded city at sunset"

**Expected:**
- [ ] Agent maps to `generate_cover_art` with genre_slug=post-apocalyptic
- [ ] DALL-E image generated
- [ ] Email arrives with image
- [ ] Art style matches post-apocalyptic guidelines (muted colors, ruins)

**Ref:** V07

---

## Group G: Voice — Content Library & Retrieval (VS08–VS12)

These test the content lifecycle and retrieval operations via voice.

---

### VS08: Voice — List Drafts

**Speak:**
> "Show me my drafts"

**Expected:**
- [ ] Agent maps to `manage_library` operation=list_drafts
- [ ] Returns formatted list of drafts

**Ref:** V13

---

### VS09: Voice — Approve and Publish

**Speak:**
> "Approve the draft called [title from VS08]"

Then:

> "Now publish it"

**Expected:**
- [ ] First command: status changes to approved, email notification
- [ ] Second command: status changes to published, email notification

**Ref:** V14

---

### VS10: Voice — Repurpose to Social — LinkedIn

**Speak:**
> "Repurpose that blog post about AI marketing into LinkedIn posts"

**Expected:**
- [ ] Agent maps to `repurpose_to_social` platform=linkedin
- [ ] LinkedIn-formatted posts generated (professional tone, longer format)
- [ ] Email arrives

**Ref:** V09

---

### VS11: Voice — List Story Arcs

**Speak:**
> "What story arcs are available"

**Expected:**
- [ ] Agent calls `retrieve_content` for story arcs
- [ ] Returns both arcs: Freytags Pyramid and Three-Act Structure
- [ ] Does NOT trigger brainstorm or any writing tool

---

### VS12: Voice — Story Bible

**Prerequisite:** VS06 must have succeeded.

**Speak:**
> "Get the story bible for The Clockwork Rebellion"

**Expected:**
- [ ] Agent calls `manage_story_bible` operation=get
- [ ] Returns character and location entries from Chapter 1

**Ref:** V18

---

## Group H: Voice — Retrieve & Callback (VS13–VS17)

These are the critical Eve callback tests — retrieve content, load into knowledge base, outbound call. This is Eve's most important feature path.

---

### VS13: Voice — Retrieve Content (No Callback)

**Tests:** retrieve_content via voice, no outbound call

**Speak:**
> "Find my draft story about the Titanic"

**Expected:**
- [ ] Agent calls `retrieve_content` with search_term matching "Titanic"
- [ ] Returns summary (title, content_type, character count)
- [ ] **No outbound call triggered** (no callback language used)

**Ref:** V23

---

### VS14: Voice — Retrieve Research Report (No Callback)

**Tests:** retrieve_content for research reports via voice

**Prerequisite:** VS01 must have succeeded (research report saved).

**Speak:**
> "Can you pull up my research report about post apocalyptic fiction trends"

**Expected:**
- [ ] Hub calls `retrieve_content` with content_type=research_report
- [ ] Returns summary: found title, character count
- [ ] **No outbound call triggered**

**Ref:** V24

---

### VS15: Voice — Retrieve & Callback — Review Mode

**Tests:** Full retrieve → KB injection → outbound call → review discussion

**Prerequisite:** S04 or VS02 must have succeeded (blog post exists to retrieve).

**Speak:**
> "Pull up my draft blog post about post apocalyptic fiction and call me back so we can revise it"

**Expected:**
- [ ] Eve says "Let me pull that up... I'll call you right back" (or similar)
- [ ] Eve fires `forward_writing_request` with "RETRIEVE AND CALLBACK" language
- [ ] Hub calls `retrieve_content` → finds the blog post
- [ ] Hub calls `eve_knowledge_callback` with content_text, callback_mode=review
- [ ] ElevenLabs KB: old "Eve Session:" docs cleaned up, new doc created
- [ ] **Outbound call triggered** to +14435012219
- [ ] Eve calls you back within ~30 seconds
- [ ] Eve opens with review-mode greeting: mentions the content title
- [ ] Eve can reference specific passages from the blog post

**If it fails:** Check Sub - Eve Knowledge Callback (PaFJlsxWq4BKt0iq) is active. Check ElevenLabs API key. Check phone number.

**Ref:** V26

---

### VS16: Voice — Retrieve & Callback — Brainstorm Mode

**Tests:** Full retrieve → KB injection → outbound call → 4-step brainstorm conversation → tool submission

**Prerequisite:** VS01 must have succeeded (research report exists).

**Estimated time:** 5–8 minutes (includes callback wait + multi-turn conversation)

---

#### Phase 1: Trigger the Callback

**Speak:**
> "Load the research report on post apocalyptic trends and call me back let's brainstorm a new story outline from it"

**Phase 1 Expected:**
- [ ] Eve says "Let me pull that up... I'll call you right back" (or similar)
- [ ] Eve fires `forward_writing_request` with "RETRIEVE AND CALLBACK" language, callback_mode=brainstorm
- [ ] Hub calls `retrieve_content` → finds the post-apocalyptic research report from VS01
- [ ] Hub calls `eve_knowledge_callback` with content_text + callback_mode=brainstorm
- [ ] ElevenLabs KB: old "Eve Session:" docs cleaned up, new doc created with research content
- [ ] **Outbound call triggered** to +14435012219
- [ ] Eve calls you back within ~30 seconds

---

#### Phase 2: Callback Opens — Brainstorm Greeting + Seed Exploration (Step 1)

When Eve calls back, she should open in brainstorm mode and begin exploring the seed idea using insights from the research report.

**Eve should:**
- [ ] Open with brainstorm-mode greeting (e.g., "Hey love, I've got that research loaded up. Want me to hit the highlights, or should we start brainstorming right away?")
- [ ] Reference **specific data points** from the VS01 research report (e.g., trending themes, notable titles, genre shifts)
- [ ] Ask what's sparking your interest — what world, character, or situation is pulling at you

**You say:**
> "I'm interested in the climate fiction angle you found in the research. What if there's a story about a coastal city that's been abandoned after rising seas, and a group goes back to salvage something important?"

**Eve should:**
- [ ] React to your idea with creative enthusiasm (not a robotic checklist)
- [ ] Build on the concept — offer her own observations or twists
- [ ] Connect your idea back to specific trends from the research report
- [ ] Begin shaping genre, premise, and themes naturally (Step 2)

---

#### Phase 3: Shape the Concept (Step 2) + Structure (Step 3)

**Eve should suggest or confirm:**
- [ ] **Genre:** post-apocalyptic (should be obvious from the premise)
- [ ] **Premise:** Sharpens your idea into a 1–2 sentence premise (who is the protagonist, what do they want, what stands in their way)
- [ ] **Themes:** Suggests themes that emerge naturally (e.g., what we leave behind, nature reclaiming civilization, memory vs. survival)

**You say:**
> "Yeah that works. I think the thing they're going back for is a seed bank — like Svalbard but a local one. And the protagonist is a marine biologist. Make it tragic... she should fail."

**Eve should:**
- [ ] Incorporate your details (seed bank, marine biologist, tragic ending)
- [ ] Suggest **Freytags Pyramid** as the story arc (tragic arc fits the "she should fail" request)
- [ ] Propose a chapter count based on scope (e.g., "This feels like an 8-chapter book" or ask your preference)
- [ ] Suggest a working title if you haven't provided one (something evocative, not generic)

**You say:**
> "Let's do eight chapters with Freytags Pyramid. Call it 'The Drowned Garden.'"

---

#### Phase 4: Confirm and Submit (Step 4)

**Eve should:**
- [ ] Summarize the complete concept back to you in 2–3 sentences:
  - Title: "The Drowned Garden"
  - Genre: post-apocalyptic
  - 8 chapters, Freytags Pyramid arc
  - Premise: [the sharpened version]
  - Themes: [the agreed themes]
- [ ] Ask for confirmation: "Ready for me to build this outline?" or "Want to tweak anything?"

**You say:**
> "That's perfect. Go for it."

**Phase 4 Expected:**
- [ ] Eve calls `forward_writing_request` with a complete brainstorm prompt containing ALL gathered details
- [ ] Tool message follows the format: "Brainstorm a book called 'The Drowned Garden'. Genre slug: post-apocalyptic. 8 chapters. Premise: [premise]. Themes: [themes]. Using Freytags Pyramid story arc."
- [ ] Eve confirms submission with a brief, confident response (e.g., "Done... I'll have that outline in your inbox shortly, darling.")

---

#### Full Test Checklist (all phases)

| # | Checkpoint | Pass? |
|---|-----------|-------|
| 1 | Eve acknowledges retrieve + callback request | |
| 2 | Hub finds research report via `retrieve_content` | |
| 3 | Hub calls `eve_knowledge_callback` with callback_mode=brainstorm | |
| 4 | Outbound call triggered, Eve calls back | |
| 5 | Eve opens with brainstorm-mode greeting | |
| 6 | Eve references specific research data points (not generic knowledge) | |
| 7 | Eve explores seed idea conversationally (Step 1) | |
| 8 | Eve shapes genre, premise, themes naturally (Step 2) | |
| 9 | Eve suggests story arc + chapter count (Step 3) | |
| 10 | Eve suggests a working title (Step 3) | |
| 11 | Eve summarizes full concept and asks for confirmation (Step 4) | |
| 12 | Eve submits `forward_writing_request` with all details after confirmation | |
| 13 | Eve does NOT submit tool call before user confirms | |
| 14 | Eve stays in character throughout (no stage directions, no "as an AI") | |
| 15 | Conversation feels natural — creative collaborator, not interviewer | |

**If it fails:** Check Sub - Eve Knowledge Callback (PaFJlsxWq4BKt0iq) is active. Check ElevenLabs API key. If callback works but brainstorm conversation fails, check Eve's system prompt for BRAINSTORM CONVERSATION MODE section.

**Ref:** V27

---

### VS17: Voice — Content Not Found (Edge Case)

**Tests:** Graceful handling when content doesn't exist, no callback triggered

**Speak:**
> "Pull up my draft story about alien wizards on Neptune and call me back"

**Expected:**
- [ ] Hub calls `retrieve_content` → returns found=false
- [ ] Hub does **NOT** call `eve_knowledge_callback`
- [ ] Eve relays error: content not found, suggests listing drafts or different search term
- [ ] **No outbound call triggered**

**Ref:** V30

---

# PART 3: SMOKE TEST CHECKLIST

## Run Order

| # | Test | Type | What It Covers | Pass? |
|---|------|------|---------------|-------|
| 1 | S01 | Chat | Perplexity research | |
| 2 | S02 | Chat | Centralized email config | |
| 3 | S03 | Chat | Email report (HTML) | |
| 4 | S04 | Chat | Blog post + Prime Directive | |
| 5 | S05 | Chat | Short story (full pipeline) | |
| 6 | S06 | Chat | Brainstorm story | |
| 7 | S07 | Chat | Chapter from stored outline | |
| 8 | S08 | Chat | List drafts | |
| 9 | S09 | Chat | Approve draft | |
| 10 | S10 | Chat | Publish content | |
| 11 | S11 | Chat | Schedule publishing | |
| 12 | S12 | Chat | List scheduled content | |
| 13 | S13 | Chat | List story arcs | |
| 14 | S14 | Chat | List all outlines | |
| 15 | S15 | Chat | Story bible read | |
| 16 | S16 | Chat | Cover art (standalone) | |
| 17 | S17 | Chat | Social media — Twitter | |
| 18 | VS01 | Voice | Research via Eve | |
| 19 | VS02 | Voice | Blog post via Eve | |
| 20 | VS03 | Voice | Newsletter via Eve | |
| 21 | VS04 | Voice | Short story via Eve | |
| 22 | VS05 | Voice | Brainstorm via Eve | |
| 23 | VS06 | Voice | Chapter from outline via Eve | |
| 24 | VS07 | Voice | Cover art via Eve | |
| 25 | VS08 | Voice | List drafts via Eve | |
| 26 | VS09 | Voice | Approve + publish via Eve | |
| 27 | VS10 | Voice | Social media — LinkedIn via Eve | |
| 28 | VS11 | Voice | List story arcs via Eve | |
| 29 | VS12 | Voice | Story bible via Eve | |
| 30 | VS13 | Voice | Retrieve content (no callback) | |
| 31 | VS14 | Voice | Retrieve research (no callback) | |
| 32 | VS15 | Voice | **Retrieve & Callback — Review** | |
| 33 | VS16 | Voice | **Retrieve & Callback — Brainstorm** | |
| 34 | VS17 | Voice | Content not found (edge case) | |

**Total: 34 tests** (17 chat + 17 voice)

---

## Decision Rules

| Failures | Action |
|----------|--------|
| **0** | All clear. System is healthy. |
| **1** | Investigate and fix the specific failure. Re-run that test to confirm. |
| **2+** | **Stop.** Run the [Full Regression Test Suite](regressiontest_prompts.md) (108 tests) to identify all affected areas. |

---

## Coverage Map

This smoke test covers the following critical paths:

| Critical Path | Chat Test | Voice Test |
|---------------|-----------|------------|
| Perplexity research | S01 | VS01 |
| Email delivery (centralized config) | S02, S03 | — |
| Blog post pipeline | S04 | VS02 |
| Newsletter pipeline | — | VS03 |
| Short story pipeline | S05 | VS04 |
| Brainstorm + outline | S06 | VS05 |
| Chapter from outline | S07 | VS06 |
| Cover art generation | S16 | VS07 |
| Content library (list/approve/publish) | S08–S10 | VS08–VS09 |
| Content library (schedule) | S11–S12 | — |
| Social media (Twitter) | S17 | — |
| Social media (LinkedIn) | — | VS10 |
| Story arcs | S13 | VS11 |
| Outline management | S14 | — |
| Story bible | S15 | VS12 |
| Writing Prime Directive | S04, S05, S06, S17 | VS02, VS04 |
| Voice → hub routing | — | VS01–VS12 |
| Retrieve content (no callback) | — | VS13, VS14 |
| Retrieve + callback (review) | — | VS15 |
| Retrieve + callback (brainstorm) | — | VS16 |
| Error handling (not found) | — | VS17 |

### What's NOT Covered (requires full regression)

- All 7 genres individually (smoke tests 3 genres)
- Outline revision, version history, and revert
- Prologue and epilogue writing
- Reject, unpublish, unschedule operations
- Content version history retrieval
- Research report save/list/get/update
- Genre inference from topic
- Messy/natural speech edge cases
- KB cleanup on back-to-back retrievals
- Parallel voice tasks + callback
- Facebook and Instagram social media platforms
- Story structure guidelines verification
- Write from brainstormed outline (short story)
- Cron scheduled auto-publish
