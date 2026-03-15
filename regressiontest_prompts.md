# The Author Agent — Full Regression Test Suite

> **Purpose:** Complete regression testing after the 2026-03-08/09/10/13/14 feature releases. Tests every tool, every genre, content library, brainstorm, story arcs, outline management (list, version history, revert), voice commands, centralized email, writing prime directive, and edge cases.
>
> **How to run:** Use the hub's chat trigger (n8n UI) for chat tests. Use the ElevenLabs voice agent (Eve) for voice tests. Wait for each test to complete before running the next.
>
> **Pass criteria:** Each test lists specific expected outcomes. A test passes when ALL expected outcomes are met.

---

## Quick Reference

| Tool | Workflow ID | What It Does |
|------|------------|--------------|
| deep_research_topic | (native Perplexity node) | Live research with citations |
| email_report | QAbYfOOd05lyesva | Send markdown report via email |
| manage_story_bible | 9cvuhBS412AQRJxf | Read/update story bible entries |
| write_blog_post | iMBIWzO2PjsLNH9w | Write SEO blog post + cover art + email |
| write_newsletter | cjIUEjrqvyGZyKwN | Write newsletter + email |
| generate_cover_art | SxeLHxzvITEKyKc0 | DALL-E image + email |
| repurpose_to_social | 95z13RGuzJDHVNSw | Social posts for Twitter/LinkedIn/Facebook/Instagram |
| write_short_story | LTZ63B2H0w8Sl4FW | Full short story + cover art + email |
| write_chapter | tpj55Sf66jrBPNT8 | Book chapter + story bible update + email |
| manage_research_reports | MLjncwcdMSjBkS4Z | Save/get/list/update research reports |
| manage_library | 1JERh5yJ3yDJka8s | Draft/publish lifecycle management |
| brainstorm_story | StwejB5GLFE26hmU | Research + outline + save to writing_projects |
| retrieve_content | DQS2zIhVjyuxabcb | Search & fetch any saved content |
| eve_knowledge_callback | PaFJlsxWq4BKt0iq | Load content into Eve KB + trigger outbound call |

| Genre | Slug | Type |
|-------|------|------|
| Post-Apocalyptic Science Fiction | post-apocalyptic | Original |
| Political Science Fiction | political-scifi | Original |
| Historical Time Travel | historical-time-travel | Original |
| AI & Marketing Technology | ai-marketing | New |
| Political & Historical Events | political-history | New |
| Ancient History & Historical Novels | ancient-history | New |
| Metaphysical Romance | metaphysical-romance | New |

| Config | Location | Purpose |
|--------|----------|---------|
| app_config table (Supabase) | `recipient_email`, `bcc_email` rows | Centralized email config for all workflows |
| hub_settings (Code node) | Hub workflow | Reads app_config, merges with trigger data |
| settings (Code node) | Cron publisher | Reads app_config for standalone email delivery |

---

# PART 1: CHAT REGRESSION TESTS

## Section A: Core Infrastructure (Tests R01–R05)

These tests verify the foundational tools that all other workflows depend on.

---

### R01: Deep Research (Perplexity)

**Tests:** Perplexity API credential, sonar model, tool routing

```
Research the current state of post-apocalyptic fiction in 2026. What are the trending themes, notable new releases, and how has the genre evolved since COVID? Include citations.
```

**Expected:**
- [ ] Agent calls `deep_research_topic` (not answering from training data)
- [ ] Response includes citations/sources
- [ ] No email sent (research stays in chat)

**If it fails:** Check Perplexity credential `ggr9QCRobQVA6Lwb` is linked to the node.

---

### R02: Save Research Report

**Tests:** manage_research_reports save operation, Supabase `research_reports` table, Code node routing fix

**Prerequisite:** R01 must have returned research content.

```
Save that research as a report with topic "Post-Apocalyptic Fiction Trends 2026" and genre slug post-apocalyptic.
```

**Expected:**
- [ ] Agent calls `manage_research_reports` with operation=save
- [ ] Returns confirmation with report data (id, topic, status=draft)
- [ ] Row exists in `research_reports` table in Supabase

**If it fails:** Check `check_operation` node has `numberOfOutputs: 4` or was rewritten to single-output pattern. Check `research_reports` table exists in Supabase.

---

### R03: Email Report

**Tests:** email_report sub-workflow, Gmail credential, markdown-to-HTML

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

**Expected:**
- [ ] Agent calls `email_report`
- [ ] Email arrives at eric@agileadtesting.com
- [ ] Email is formatted HTML (headings, bullet points, numbered list)
- [ ] Subject line matches

**If it fails:** Check Gmail credential `CPCSZOInV8Zj1PI1`. Check workflow `QAbYfOOd05lyesva` is active.

---

### R04: Story Bible — Read (Empty)

**Tests:** manage_story_bible sub-workflow, Supabase connectivity

```
Get the story bible for project "Regression Test Project"
```

**Expected:**
- [ ] Agent calls `manage_story_bible` with operation=get
- [ ] Returns empty result or "no entries found" (project doesn't exist yet)
- [ ] No errors — confirms Supabase connection works

**If it fails:** Check `writing_projects` and `story_bible` tables exist.

---

### R05: Centralized Email Config (app_config)

**Tests:** hub_settings Code node reads from Supabase app_config table, passes email values to tool workflows

**Setup:** Verify `app_config` table in Supabase has rows:
- `key=recipient_email`, `value=eric@agileadtesting.com`
- `key=bcc_email`, `value=` (empty or a valid BCC address)

```
Send me an email report with this content:

# Centralized Email Test

This test verifies that the hub reads recipient_email from the app_config table in Supabase.

Use subject line "R05: Centralized Email Config Test"
```

**Expected:**
- [ ] Email arrives at the address stored in `app_config.recipient_email`
- [ ] If `bcc_email` is set in app_config, BCC recipient also receives the email
- [ ] Hub execution log shows `hub_settings` Code node ran successfully (not a Set node)
- [ ] No hardcoded email addresses used — all pulled from Supabase

**If it fails:** Check `app_config` table exists and has `recipient_email` row. Check `hub_settings` node is type `n8n-nodes-base.code` (not Set). Check Supabase API key is valid.

---

## Section B: Writing Tools — Original Genres (Tests R06–R13)

These tests verify all writing workflows work with the 3 original genres.

---

### R06: Write Blog Post (post-apocalyptic)

**Tests:** write_blog_post, genre_config fetch, Content Ingestion (with fallback), Perplexity research, Claude writing, cover art, draft insert, email, Writing Prime Directive

```
Write a blog post for the post-apocalyptic genre. Topic: "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026". Genre slug: post-apocalyptic. Keywords: post-apocalyptic books, climate fiction, survival stories, dystopian novels. Target length: 1500 words.
```

**Expected:**
- [ ] Agent calls `write_blog_post`
- [ ] Blog post written in post-apocalyptic tone (gritty, visceral)
- [ ] **Writing Prime Directive:** No cliches (revolutionize, game-changing, unleash, delve). Plain language. Short paragraphs. Shows, doesn't tell.
- [ ] Cover art generated (ruins, decay, atmospheric)
- [ ] Email arrives with blog content
- [ ] Draft row inserted into `published_content` (content_type=blog_post, status=draft)
- [ ] Draft saved to Supabase Storage (`drafts/blog_*.md`)
- [ ] Email sent to centralized `recipient_email` from app_config (not hardcoded)

**If it fails:** Check genre_config has post-apocalyptic row. Check Content Ingestion fallback (`alwaysOutputData=true` on `get_recent_content`).

---

### R07: Write Newsletter (political-scifi)

**Tests:** write_newsletter, different genre, newsletter-specific formatting, Writing Prime Directive

```
Write a newsletter for the political-scifi genre. Topic: "Power Structures in Space: How Sci-Fi Predicts Real-World Politics". Genre slug: political-scifi. Date: 2026-03-10.
```

**Expected:**
- [ ] Agent calls `write_newsletter`
- [ ] Newsletter uses political-scifi tone (cerebral, tense, morally ambiguous)
- [ ] **Writing Prime Directive:** No filler words, no hype, concrete examples over vague claims
- [ ] Has subject_line, pre_header, intro, sections, outro structure
- [ ] Email arrives with newsletter content
- [ ] Draft row in `published_content` (content_type=newsletter)

---

### R08: Write Short Story (historical-time-travel)

**Tests:** write_short_story, Perplexity research, multi-scene writing, cover art, draft insert, Writing Prime Directive

```
Write a short story. Genre slug: historical-time-travel. Premise: A historian discovers that antique photographs can transport her to the moment they were taken. She finds a photo of the Titanic's maiden voyage departure and must decide whether to warn the passengers. Tone: literary, bittersweet. Length: 2500 words. Research topics: ["Titanic maiden voyage Southampton 1912", "history of early photography techniques", "time travel paradoxes in fiction"]
```

**Expected:**
- [ ] Agent calls `write_short_story`
- [ ] Story uses historical-time-travel tone (meticulous, wonder-infused)
- [ ] **Writing Prime Directive:** Clear everyday language. Short sentences. Genuine emotion, not manufactured. Concrete details over vague descriptions.
- [ ] Perplexity research on all 3 topics
- [ ] Cover art generated (period-appropriate imagery)
- [ ] Email arrives with complete story
- [ ] Draft row in `published_content` (content_type=short_story)

---

### R09: Generate Cover Art (standalone)

**Tests:** generate_cover_art, DALL-E, genre art guidelines, email with attachment

```
Generate cover art for a political-scifi short story called "The Senate of Stars". The story is about a diplomat navigating a galactic parliament where every species has a fundamentally different concept of justice. Genre slug: political-scifi. The image should show a vast circular chamber with alien delegates, lit by the light of a dying star through a massive viewport.
```

**Expected:**
- [ ] Agent calls `generate_cover_art`
- [ ] Image generated via DALL-E (gpt-image-1)
- [ ] Art style matches political-scifi guidelines (dark, imposing, cerebral)
- [ ] Email arrives with image attachment
- [ ] No text/words in the image

**If it fails:** Check OpenAI credential `xSzPIySN61drme77`. Check `set_art_guidelines` has political-scifi entry.

---

### R10: Repurpose to Social — Twitter

**Tests:** repurpose_to_social, Twitter-specific formatting, Writing Prime Directive

```
Repurpose this into Twitter posts: "The Senate of Stars is a new political sci-fi short story about a diplomat navigating a galactic parliament where every species has a different concept of justice. A meditation on diplomacy, compromise, and whether true fairness is even possible across civilizations." Platform: twitter.
```

**Expected:**
- [ ] Agent calls `repurpose_to_social` with platform=twitter
- [ ] Output is a thread of tweets (each under 280 chars)
- [ ] **Writing Prime Directive:** No cliches, no hype. Reads like a human wrote it.
- [ ] Includes relevant hashtags
- [ ] Email arrives with formatted tweets

---

### R11: Repurpose to Social — LinkedIn

**Tests:** repurpose_to_social, LinkedIn-specific formatting, Writing Prime Directive

```
Repurpose this into LinkedIn posts: "We just published a deep-dive blog post on why post-apocalyptic fiction matters more than ever in 2026. From climate anxiety to AI fears, the genre has become a mirror for our collective anxieties — and surprisingly, a source of hope." Platform: linkedin.
```

**Expected:**
- [ ] Agent calls `repurpose_to_social` with platform=linkedin
- [ ] Output is professional, longer format
- [ ] **Writing Prime Directive:** No filler, no fake excitement. Professional but genuine.
- [ ] LinkedIn-style hashtags
- [ ] Email arrives

---

### R12: Repurpose to Social — Facebook

**Tests:** repurpose_to_social, Facebook formatting, cover image generation

```
Repurpose this into Facebook posts: "The Last Signal is a post-apocalyptic short story about a lone radio operator in flooded Manhattan picking up a mysterious broadcast from across the Atlantic. Now free to read on our blog." Platform: facebook. Genre slug: post-apocalyptic.
```

**Expected:**
- [ ] Agent calls `repurpose_to_social` with platform=facebook
- [ ] Conversational, community-engaging tone
- [ ] Cover image generated via Generate Cover Art sub-workflow
- [ ] Email arrives with posts + image

---

### R13: Repurpose to Social — Instagram

**Tests:** repurpose_to_social, Instagram-specific formatting (caption style, hashtags)

```
Repurpose this into Instagram posts: "A historian discovers that antique photographs can transport her to the moment they were taken. She finds a photo from the Titanic's maiden voyage and must decide whether to change history." Platform: instagram. Genre slug: historical-time-travel.
```

**Expected:**
- [ ] Agent calls `repurpose_to_social` with platform=instagram
- [ ] Caption style, max 2200 chars
- [ ] 20-30 hashtags at end
- [ ] Conversational tone
- [ ] Email arrives with formatted caption

---

## Section C: Writing Tools — New Genres (Tests R14–R19)

These tests verify the 3 new genres work correctly across different writing tools.

---

### R14: Write Blog Post (ancient-history)

**Tests:** ancient-history genre config, art guidelines, content fallback for empty scraped data, Writing Prime Directive

```
Write a blog post in the ancient-history genre. Topic: "The Forgotten Engineers of Rome: How Aqueducts Shaped an Empire". Genre slug: ancient-history. Keywords: Roman engineering, aqueducts, ancient infrastructure, Frontinus. Target length: 1500 words.
```

**Expected:**
- [ ] Blog uses ancient-history tone (immersive, sensory-rich, reverent of detail)
- [ ] **Writing Prime Directive:** Plain language, no hype, concrete examples. Respects the reader's intelligence.
- [ ] Cover art: classical oil painting style, warm golden light, marble/stone
- [ ] Content Ingestion may return 0 items — workflow continues gracefully (fallback working)
- [ ] Email arrives with blog + cover image
- [ ] Draft row in `published_content`

---

### R15: Write Short Story (ai-marketing)

**Tests:** ai-marketing genre config, tech aesthetic art guidelines, Writing Prime Directive

```
Write a short story in the ai-marketing genre. Genre slug: ai-marketing. Premise: An AI trained to write ad copy for a luxury perfume brand starts composing poetry instead — and the poems sell better than any ad ever did. Tone: satirical, sharp, funny. Length: 2000 words. Research topics: ["AI generated advertising 2026", "perfume marketing psychology", "computational creativity"]
```

**Expected:**
- [ ] Story uses ai-marketing tone (authoritative, forward-looking, practical)
- [ ] **Writing Prime Directive:** No jargon or buzzwords. Clear, short sentences. Genuine wit, not manufactured.
- [ ] Cover art: clean tech aesthetic, gradient blues/purples, circuit patterns
- [ ] Email arrives with story + cover image
- [ ] Draft row in `published_content`

---

### R16: Write Newsletter (political-history)

**Tests:** political-history genre config, art guidelines, Writing Prime Directive

```
Write a newsletter for the political-history genre. Topic: "This Month in Political History: Revolutions That Changed the Map". Genre slug: political-history. Date: 2026-03-10.
```

**Expected:**
- [ ] Newsletter uses political-history tone (analytical, layered, draws parallels)
- [ ] **Writing Prime Directive:** Facts over hype. Show don't tell. No filler words.
- [ ] Cover art: documentary/oil painting style, amber lighting, architecture of power
- [ ] Email arrives
- [ ] Draft row in `published_content`

---

### R17: Write Chapter (ancient-history, new project)

**Tests:** write_chapter with new genre, project creation, story bible, Writing Prime Directive

```
Write chapter 1 of a new book. Genre slug: ancient-history. Project title: "The Last Pharaoh's Scribe". Chapter number: 1. Brief: A young scribe in Cleopatra's court discovers that the Library of Alexandria holds a map to a weapon that could repel the Roman invasion. She must navigate court politics, Roman spies, and her own ambitions to find it before Alexandria falls. Outline: Chapter 1 introduces Nefertari in the library, the discovery of the hidden map fragment, and a tense encounter with a Roman centurion posing as a scholar. Research topics: ["Library of Alexandria daily operations", "Cleopatra's court structure and politics", "Roman military presence in Egypt 30 BC", "ancient Egyptian scribal practices"]
```

**Expected:**
- [ ] Chapter uses ancient-history tone (immersive, sensory-rich)
- [ ] **Writing Prime Directive:** Everyday language, short paragraphs, concrete details. No cliches.
- [ ] Perplexity researches all 4 topics
- [ ] Story bible entries created for characters/locations
- [ ] writing_projects row created
- [ ] Email arrives with chapter
- [ ] Draft row in `published_content` (content_type=chapter)

---

### R18: Cover Art — New Genre (ai-marketing)

**Tests:** Art guidelines for new genres specifically

```
Generate cover art for an ai-marketing blog post called "The Algorithm That Learned to Dream". The article explores AI systems that generate creative content. Genre slug: ai-marketing. The image should represent the intersection of artificial intelligence and human creativity.
```

**Expected:**
- [ ] Art uses ai-marketing guidelines (gradient blues/purples, circuit patterns, neural network visualizations)
- [ ] NOT post-apocalyptic (no ruins, wasteland, decay)
- [ ] Email arrives with image

---

### R19: Cover Art — New Genre (ancient-history)

**Tests:** Art guidelines for ancient-history

```
Generate cover art for an ancient-history novel called "The Last Pharaoh's Scribe". Genre slug: ancient-history. The image should show an ancient Egyptian library with papyrus scrolls, oil lamps, and a view of Alexandria's harbor through a columned window.
```

**Expected:**
- [ ] Art uses ancient-history guidelines (classical painting style, warm golden light, earth tones with lapis and gold)
- [ ] NOT modern/tech aesthetic
- [ ] Email arrives with image

---

## Section D: Content Library (Tests R20–R27)

**Prerequisite:** At least 2–3 writing tests from Sections B–C must have passed first, so drafts exist.

---

### R20: List Drafts

**Tests:** manage_library list_drafts operation

```
List my drafts
```

**Expected:**
- [ ] Agent calls `manage_library` with operation=list_drafts
- [ ] Returns formatted list with title, content_type, genre, date, UUID
- [ ] Count matches number of writing tests completed

---

### R21: List Drafts — Filter by Type

**Tests:** content_type_filter parameter

```
List my draft blog posts
```

**Expected:**
- [ ] Returns only items where content_type=blog_post
- [ ] Other types (short_story, newsletter, chapter) excluded

---

### R22: Approve Draft

**Tests:** approve operation, Supabase PATCH, email notification, version snapshot

**Prerequisite:** Note a title from R20.

```
Approve the draft titled "[exact title from R20]"
```

**Expected:**
- [ ] Agent calls manage_library with operation=approve and correct content_id
- [ ] Returns "Content approved successfully" or similar
- [ ] `published_content` row status changed to 'approved'
- [ ] Email notification received confirming approval
- [ ] Version snapshot auto-saved to content_versions table

---

### R23: Publish Content

**Tests:** publish operation, published_at timestamp, version snapshot, email notification

```
Publish the content titled "[same title from R22]"
```

**Expected:**
- [ ] Status changes to 'published'
- [ ] `published_at` timestamp is set
- [ ] Returns confirmation
- [ ] Email notification received confirming publication
- [ ] Version snapshot auto-saved to content_versions table

---

### R24: List Published

**Tests:** list_published operation

```
List my published content
```

**Expected:**
- [ ] Returns the item published in R23
- [ ] Shows published_at date

---

### R25: Reject Draft

**Tests:** reject operation, email notification

**Prerequisite:** Need a different draft (not the one already published).

```
Reject the draft titled "[different title from R20]"
```

**Expected:**
- [ ] Status changes to 'rejected'
- [ ] Returns confirmation
- [ ] Email notification received confirming rejection with content title

---

### R26: Schedule Publishing

**Tests:** schedule operation, email notification, metadata

**Prerequisite:** An approved or draft item exists.

```
Schedule the draft titled "[title]" for 2026-03-20
```

**Expected:**
- [ ] Status changes to 'scheduled'
- [ ] Metadata contains schedule_date = "2026-03-20"
- [ ] Email notification confirms scheduling with the date
- [ ] Returns confirmation message with schedule date

---

### R27: List Scheduled Content

**Tests:** list_scheduled operation

**Prerequisite:** R26 must have succeeded.

```
List my scheduled content
```

**Expected:**
- [ ] Returns list including the item scheduled in R26
- [ ] Shows the scheduled date for each item

---

## Section E: Version History (Tests R28–R29)

---

### R28: Version History on Approve/Publish

**Tests:** auto-version-snapshot, list_versions operation

**Prerequisite:** Content has been approved or published (R22/R23).

```
Show version history for [content_id from R23]
```

**Expected:**
- [ ] Returns at least one version entry
- [ ] Each version shows version_number, changed_by, change_note, and timestamp

---

### R29: Get Specific Version

**Tests:** get_version operation

**Prerequisite:** R28 confirmed at least one version exists.

```
Get version 1 of [content_id from R23]
```

**Expected:**
- [ ] Returns the full content_text from version 1
- [ ] Includes version_number, changed_by, and change_note

---

## Section F: Brainstorm & Outline (Tests R30–R32)

---

### R30: Brainstorm Story

**Tests:** brainstorm_story workflow, Perplexity research, Claude structured outline, writing_projects save, email, Writing Prime Directive

```
Brainstorm a post-apocalyptic story called "The Seed Vault" about the last botanist on Earth protecting the Svalbard seed vault from raiders who don't understand its value. Themes: preservation, sacrifice, legacy, nature vs. human destruction. 6 chapters. Genre slug: post-apocalyptic.
```

**Expected:**
- [ ] Agent calls `brainstorm_story`
- [ ] Email arrives with HTML-formatted outline containing:
  - Title, premise, themes
  - Character profiles (name, role, arc, description)
  - 6 chapter breakdowns (number, title, brief, arc_notes, research_topics)
- [ ] **Writing Prime Directive:** Outline language is clear, direct, no cliches or buzzwords
- [ ] `writing_projects` row created with `outline` JSONB populated
- [ ] Hub returns summary confirming outline saved

---

### R31: Write Chapter from Stored Outline

**Tests:** Write Chapter auto-loading outline from writing_projects.outline

**Prerequisite:** R30 must have succeeded.

```
Write chapter 1 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 1.
```

**Expected:**
- [ ] Agent calls `write_chapter` WITHOUT providing brief or outline
- [ ] `build_chapter_prompt` loads stored outline from `writing_projects.outline`
- [ ] Chapter content references specific characters and plot from the brainstormed outline
- [ ] Story bible entries created for Chapter 1 characters/locations
- [ ] Email arrives with chapter

---

### R32: Story Bible — Read After Chapter

**Tests:** Story bible populated by write_chapter

**Prerequisite:** R31 must have succeeded.

```
Get the story bible for project "The Seed Vault"
```

**Expected:**
- [ ] Returns character entries, location entries, plot threads from Chapter 1
- [ ] Entries have chapter_introduced=1

---

## Section G: Research Reports (Tests R33–R35)

---

### R33: List Research Reports

**Tests:** manage_research_reports list operation

```
List my research reports
```

**Expected:**
- [ ] Agent calls `manage_research_reports` with operation=list
- [ ] Returns list of reports (at least the one from R02)
- [ ] Shows id, topic, genre_slug, status

---

### R34: Get Research Report

**Tests:** manage_research_reports get operation

**Prerequisite:** Note a report_id from R33.

```
Get the research report about "Post-Apocalyptic Fiction Trends 2026"
```

**Expected:**
- [ ] Agent calls `manage_research_reports` with operation=get
- [ ] Returns full report content

---

### R35: Update Research Report

**Tests:** manage_research_reports update operation

```
Update the research report "Post-Apocalyptic Fiction Trends 2026" — change its status to published.
```

**Expected:**
- [ ] Agent calls `manage_research_reports` with operation=update
- [ ] Status changes to published
- [ ] updated_at timestamp refreshed

---

## Section H: Content Retrieval (Tests R36–R37)

---

### R36: Retrieve Content — Search by Title

**Tests:** retrieve_content workflow, keyword extraction, Supabase search

**Prerequisite:** At least one writing test must have completed (draft exists).

```
Find my draft about the Titanic
```

**Expected:**
- [ ] Agent calls `retrieve_content` with search_term matching "Titanic"
- [ ] Returns match from `published_content` (the R08 short story)
- [ ] Shows title, content_type, character count
- [ ] No callback triggered (no callback language)

---

### R37: Retrieve Content — Not Found

**Tests:** retrieve_content error handling

```
Find my draft about quantum surfing on Jupiter
```

**Expected:**
- [ ] Agent calls `retrieve_content`
- [ ] Returns found=false
- [ ] Agent suggests trying a different search term or listing drafts
- [ ] No crash or unhandled error

---

## Section I: Edge Cases & Cross-Genre (Tests R38–R42)

---

### R38: Unknown Genre Slug

**Tests:** Agent handles bad genre gracefully

```
Write a blog post in the cyberpunk genre. Genre slug: cyberpunk. Topic: "Neon and Chrome". Target length: 1000 words.
```

**Expected:**
- [ ] Agent either asks for clarification OR picks closest genre (political-scifi)
- [ ] Does NOT crash or return null genre config
- [ ] If it proceeds, blog still generates (using fallback or closest match)

---

### R39: Minimal Input (Agent Fills Gaps)

**Tests:** Agent intelligence — fills in missing fields

```
Write me a short story about a robot learning to paint
```

**Expected:**
- [ ] Agent infers genre (likely ai-marketing) and fills in genre_slug
- [ ] Agent creates a premise from the brief description
- [ ] Agent picks a reasonable tone and length
- [ ] Story is written and emailed

---

### R40: Multi-Step Conversation

**Tests:** Chat memory, sequential tool calls

```
Message 1: Research ancient Roman gladiator training methods
```

Wait for response, then:

```
Message 2: Now write a blog post about that research. Genre slug: ancient-history. Keywords: gladiators, Roman arena, combat training. Target length: 1200 words.
```

**Expected:**
- [ ] Message 1: Agent calls deep_research_topic, saves via manage_research_reports
- [ ] Message 2: Agent references the research context and calls write_blog_post
- [ ] Blog content incorporates the research findings

---

### R41: Cross-Genre Cover Art

**Tests:** Art guidelines change correctly per genre

```
Message 1: Generate cover art for a post-apocalyptic story called "Ash". Genre slug: post-apocalyptic. A lone figure walking through a gray, ash-covered landscape.
```

Wait, then:

```
Message 2: Now generate cover art for an ancient-history novel called "The Golden Temple". Genre slug: ancient-history. A grand temple at sunset with priests on the steps.
```

**Expected:**
- [ ] Image 1: post-apocalyptic style (muted, atmospheric, desolate)
- [ ] Image 2: ancient-history style (warm golden light, classical painting, rich earth tones)
- [ ] Styles are clearly different from each other

---

### R42: Cron Auto-Publish (Scheduled Publisher)

**Tests:** Cron scheduled publisher workflow, centralized email from app_config

**Manual test:** Set schedule_date to a past date/time in Supabase (`UPDATE published_content SET status='scheduled', metadata=jsonb_set(metadata, '{schedule_date}', '"2026-03-09T00:00:00Z"') WHERE id='[content_id]'`), wait up to 1 hour for the cron to run.

**Expected:**
- [ ] Status changes from 'scheduled' to 'published'
- [ ] published_at timestamp is set
- [ ] Email notification sent to centralized `RECIPIENT_EMAIL` from app_config (not hardcoded)
- [ ] Cron `settings` Code node reads from Supabase app_config table
- [ ] Version snapshot auto-saved before publishing

**If it fails:** Check workflow `AtMuc7ZsL28LfU1b` is active. Check `settings` node is type `n8n-nodes-base.code`. Check `app_config` table has `recipient_email` row.

---

## Section J: Writing Prime Directive Verification (Tests R43–R48)

> **Purpose:** These tests specifically verify the Writing Prime Directive is active across all 6 content-generating workflows. Each test checks that AI-generated text avoids banned patterns and follows the humanized writing style.
>
> **How to verify:** Read the generated content and check for banned words/patterns. The Writing Prime Directive bans: revolutionize, game-changing, unleash, delve, filler words, hype, fake excitement, vague claims, long paragraphs.

---

### R43: Prime Directive — Blog Post

**Tests:** Writing Prime Directive in write_blog_post `build_prompt` node

```
Write a blog post in the ai-marketing genre. Topic: "How AI Tools Are Changing Content Marketing". Genre slug: ai-marketing. Keywords: AI content tools, marketing automation, generative AI. Target length: 1200 words.
```

**Expected:**
- [ ] Blog does NOT contain: "revolutionize", "game-changing", "unleash", "delve", "cutting-edge", "leverage"
- [ ] Paragraphs are short (2-4 sentences max)
- [ ] Uses concrete examples instead of vague claims
- [ ] Reads like a human pitched it to a smart friend
- [ ] No manufactured excitement or hype

---

### R44: Prime Directive — Newsletter

**Tests:** Writing Prime Directive in write_newsletter `build_newsletter_prompt` node

```
Write a newsletter for the ancient-history genre. Topic: "New Archaeological Discoveries Reshaping Our Understanding of Ancient Egypt". Genre slug: ancient-history. Date: 2026-03-10.
```

**Expected:**
- [ ] Newsletter does NOT contain banned cliche words
- [ ] Gets to the point — no filler words or padding
- [ ] Shows, doesn't tell — uses specific findings instead of "amazing discoveries"
- [ ] Genuine tone, not manufactured excitement

---

### R45: Prime Directive — Short Story

**Tests:** Writing Prime Directive in write_short_story `build_story_prompt` node

```
Write a short story in the political-scifi genre. Genre slug: political-scifi. Premise: A junior senator discovers that the AI running the galactic parliament has been quietly editing legislation before votes. Tone: tense, cynical. Length: 1500 words.
```

**Expected:**
- [ ] Story prose is clean — no purple prose or overwriting
- [ ] Dialogue sounds natural, not stilted
- [ ] Short sentences where appropriate for tension
- [ ] Clear, everyday language even in sci-fi context

---

### R46: Prime Directive — Chapter

**Tests:** Writing Prime Directive in write_chapter `build_chapter_prompt` node

```
Write chapter 2 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 2. Brief: The botanist encounters the first raider scouts approaching the vault. She must decide whether to hide or make contact. Research topics: ["Svalbard seed vault security systems", "post-collapse social dynamics"]
```

**Expected:**
- [ ] Chapter prose avoids cliches and buzzwords
- [ ] Tight descriptions — no unnecessary adjectives/adverbs
- [ ] Action scenes are concrete and specific, not vague
- [ ] Respects the reader's intelligence

---

### R47: Prime Directive — Social Posts

**Tests:** Writing Prime Directive in repurpose_to_social `build_prompt` node

```
Repurpose this into Twitter posts: "New research shows that AI-powered marketing tools are fundamentally changing how brands connect with audiences. From personalized content to predictive analytics, the landscape is shifting fast." Platform: twitter. Genre slug: ai-marketing.
```

**Expected:**
- [ ] Tweets do NOT contain: "game-changing", "revolutionize", "unleash", "cutting-edge"
- [ ] Each tweet reads like a human wrote it, not a corporate bot
- [ ] No hype — just facts and genuine observations
- [ ] Tight and punchy, no filler

---

### R48: Prime Directive — Brainstorm Outline

**Tests:** Writing Prime Directive in brainstorm_story `build_outline_prompt` node

```
Brainstorm a political-history story called "The Diplomat's Gambit" about a Cold War spy who discovers that both superpowers are being manipulated by the same shadowy organization. Themes: deception, loyalty, the illusion of choice. 8 chapters. Genre slug: political-history.
```

**Expected:**
- [ ] Outline premise is direct and clear — no buzzwords
- [ ] Character descriptions are specific, not generic ("brave hero" type)
- [ ] Chapter briefs are concrete — describe what actually happens, not vague "tensions rise"
- [ ] Themes are explored through specific plot mechanics, not abstract descriptions

---

## Section K: Story Structure Guidelines (Tests R49–R52)

These tests verify that the story structure guidelines stored in `app_config` are being fetched and applied correctly across the three workflows that use them: Brainstorm Story, Write Short Story, and Write Chapter.

---

### R49: Story Structure Guidelines — Brainstorm Uses Structure Model

**Tests:** `story_structure_guidelines` fetched from `app_config` in brainstorm_story `settings` node, injected into `build_outline_prompt`, applied by Claude when generating outline

```
Brainstorm a short story about a soldier who wakes up 100 years after a war she started, only to find the enemy she fought won and built a better world. Genre: post-apocalyptic. Title: The Wrong Side. Sections: 5
```

**Expected:**
- [ ] Agent calls `brainstorm_story`
- [ ] Each section's `arc_notes` explicitly names a structural beat (e.g. "Act 1 Setup", "Inciting Incident", "Climax", "Denouement")
- [ ] Outline notes which structural model was chosen (Three-Act, Hero's Journey, Seven-Point, etc.)
- [ ] Characters have clearly assigned roles: Protagonist, Antagonist, Dynamic, Static
- [ ] No character exists without a structural purpose stated in their role/arc

**If it fails:** Check `settings` node in brainstorm_story (StwejB5GLFE26hmU) fetches `story_structure_guidelines` from `app_config`. Verify the `build_outline_prompt` Code node references `$('settings').first().json.story_structure_guidelines`. Confirm `app_config` table has a row with `key='story_structure_guidelines'`.

---

### R50: Story Structure Guidelines — Short Story Has 5-Stage Arc

**Tests:** `story_structure_guidelines` injected into `build_story_prompt` Code node in write_short_story (LTZ63B2H0w8Sl4FW)

```
Write a short story about a city maintenance worker who discovers the AI managing the city's infrastructure has been writing poetry in the gaps between system logs. Genre: ai-marketing. Length: 2500 words. Tone: quiet and melancholic.
```

**Expected:**
- [ ] Agent calls `write_short_story`
- [ ] Story opens in an identifiable "ordinary world" (Exposition — Guideline 2, Stage 1)
- [ ] A clear catalyst disrupts the protagonist's routine (Rising Action — Guideline 2, Stage 2)
- [ ] A peak moment of tension or confrontation exists (Climax — Guideline 2, Stage 3)
- [ ] Story has aftermath/fallout after the peak (Falling Action — Guideline 2, Stage 4)
- [ ] Story resolves with protagonist visibly changed (Resolution — Guideline 2, Stage 5 + Guideline 10)
- [ ] Protagonist does NOT end where they began — transformation is present
- [ ] Story is not a flat sequence of events — emotional/thematic stakes are present throughout

**If it fails:** Check `settings` node in write_short_story fetches `story_structure_guidelines`. Check `build_story_prompt` Code node includes `## Story Structure Guidelines` section in the prompt string.

---

### R51: Story Structure Guidelines — Chapter Has Internal Arc + Transformation

**Tests:** `story_structure_guidelines` injected into `build_chapter_prompt` Code node in write_chapter (tpj55Sf66jrBPNT8)

```
Write chapter 1 of a story called "The Cartographer's Lie" in post-apocalyptic genre. Brief: A map-maker is hired to chart the forbidden eastern territories. On the first day, she discovers the map she was given to copy is intentionally wrong.
```

**Expected:**
- [ ] Agent calls `write_chapter`
- [ ] Chapter has an identifiable internal arc (not just events)
- [ ] Protagonist ends the chapter in a different emotional/psychological state than they started
- [ ] `next_chapter_notes` references where the character arc goes next (not just plot logistics)
- [ ] At least one character role is identifiable: Protagonist, Antagonist, Dynamic, or Static
- [ ] Chapter does not end in the same emotional register it began

**If it fails:** Check `settings` node in write_chapter fetches `story_structure_guidelines`. Check `build_chapter_prompt` Code node includes `## Story Structure Guidelines` section between the Writing Prime Directive and the Writing Style Reference.

---

### R52: Story Structure Guidelines — Correct Genre Name Preserved (R43 Guard)

**Tests:** Genre config fetch works correctly alongside `story_structure_guidelines` fetch; `json[0]` regression does not re-appear

```
Write a short story about a political consultant who realizes the candidate she is managing is being blackmailed by a rival AI. Genre: political-scifi. Length: 2000 words. Tone: tense thriller.
```

**Expected:**
- [ ] Agent calls `write_short_story`
- [ ] Story reflects political sci-fi genre themes (not undefined or generic)
- [ ] Writing style reflects the genre guidelines (not a blank/default prompt)
- [ ] No `[undefined]` appears in email subject, story text, or story title
- [ ] Story has a clear tension arc with protagonist transformation

**If it fails:** This is the `json[0]` regression test. Check `build_story_prompt` Code node uses `$('get_genre_config').first().json.genre_name` (NOT `json[0]?.genre_name`). The HTTP node returns the object directly — array indexing returns undefined.

---

## Section L: Story Arcs (Tests R53–R61)

These tests verify that the story arcs feature works end-to-end: listing available arcs, selecting a specific arc during brainstorming, and confirming the outline follows the chosen arc's structural beats. Each test uses the two-step pattern: retrieve the arc first, then brainstorm using it.

---

### R53: List Story Arcs

**Tests:** retrieve_content with content_type=story_arc, `story_arcs` table query, preprocess_message routing

```
List the story arcs
```

**Expected:**
- [ ] Agent calls `retrieve_content` with content_type=story_arc (or search_term containing "story arcs")
- [ ] Response lists both arcs: **Freytags Pyramid** and **Three-Act Structure**
- [ ] Each arc has a description
- [ ] Agent does NOT call brainstorm_story or any writing tool

**If it fails:** Check `retrieve_content` Code node has the `story_arc` handler block. Verify `story_arcs` table has both rows. Check `preprocess_message` regex detects "list story arcs" as a retrieve op.

---

### R54: Brainstorm Short Story — Freytags Pyramid (Post-Apocalyptic)

**Tests:** brainstorm_story with story_arc parameter, story_arcs DB lookup, 5-act structure in outline

```
Brainstorm a short story using Freytags Pyramid about a plague doctor in the ruins of Manhattan who discovers that the disease wiping out survivors is man-made, and the cure lies in the hands of the people who created it. Genre: post-apocalyptic. Title: The Inoculator. Sections: 5. Themes: trust, complicity, the cost of survival.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with story_arc="Freytags Pyramid"
- [ ] `settings` node loads the full Freytags Pyramid prompt from `story_arcs` table
- [ ] Outline arc_notes reference **5-act Freytag beats**: Introduction, Rising Action, Climax (Midpoint), Falling Action, Catastrophe/Denouement
- [ ] Climax section represents the **apex** (peak of desire + simultaneous crack), NOT the final confrontation
- [ ] Falling Action sections show protagonist's descent / consequences accelerating
- [ ] Final section delivers catastrophe or survival-with-consequence ending
- [ ] Characters have assigned roles (Protagonist, Antagonist, Dynamic, Static)
- [ ] Email subject line contains "The Inoculator"
- [ ] Outline saved to `writing_projects` table

**If it fails:** Check `settings` node in brainstorm_story fetches from `story_arcs` table using `ilike` match. Verify `build_outline_prompt` references `story_arc_prompt` (not `story_structure_guidelines`). Confirm "Freytags Pyramid" row exists in `story_arcs`.

---

### R55: Brainstorm Book — Freytags Pyramid (Political Sci-Fi)

**Tests:** Freytags Pyramid applied to a full book outline with more chapters, political-scifi genre

```
Help me brainstorm a book using Freytags Pyramid about a diplomat who brokers peace between two warring colony planets, only to discover the peace treaty she negotiated will secretly enslave one side. Genre: political-scifi. Title: The Accord. 10 chapters. Themes: complicity, the machinery of power, moral compromise, the price of peace.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with story_arc="Freytags Pyramid"
- [ ] Outline has 10 chapters mapped to the 5-act pyramid structure
- [ ] Chapters 1-2 cover Introduction (ordinary world + inciting incident)
- [ ] Chapters 3-5 cover Rising Action (escalating moral compromises)
- [ ] Chapter 5 or 6 is the Climax (Midpoint) — diplomat achieves her goal but the crack appears
- [ ] Chapters 7-8 cover Falling Action (descent, secrets surfacing)
- [ ] Chapters 9-10 deliver the Catastrophe/Denouement
- [ ] arc_notes name specific Freytag beats, not generic labels
- [ ] Protagonist has a **fatal flaw** identifiable from Act 1

**If it fails:** Same as R54. Also confirm the genre_slug=political-scifi is passed and genre_config is loaded correctly.

---

### R56: Brainstorm Short Story — Freytags Pyramid (Ancient History)

**Tests:** Freytags Pyramid with ancient-history genre, tragedy arc

```
Brainstorm a short story using Freytags Pyramid about a Roman senator who poisons his rivals to secure the consulship, only for his own family to be destroyed by the same poison network he built. Genre: ancient-history. Title: The Consulship of Gaius Varro. 5 sections. Themes: ambition, legacy, self-destruction.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with story_arc="Freytags Pyramid"
- [ ] Outline follows classic tragedy arc — protagonist's ambition causes their ruin
- [ ] Climax (midpoint) = senator achieves consulship BUT the unraveling begins simultaneously
- [ ] Falling Action shows the poison network turning against him
- [ ] Catastrophe delivers total ruin or grim denouement
- [ ] Genre research pulls Roman political/historical details
- [ ] arc_notes reference Freytag-specific terminology (not Three-Act terminology)

**If it fails:** Confirm `get_genre_config` fetches ancient-history. Verify the prompt explicitly says "Freytags Pyramid" framework.

---

### R57: Brainstorm Short Story — Freytags Pyramid (Historical Time Travel)

**Tests:** Freytags Pyramid with historical-time-travel genre, verifying the arc works with speculative mechanics

```
Brainstorm a short story using Freytags Pyramid about a historian who travels to 1692 Salem to observe the witch trials, but accidentally provides testimony that condemns an innocent woman. Genre: historical-time-travel. Title: The Witness. 5 sections. Themes: guilt, the observer effect, whether the past can be repaired.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with story_arc="Freytags Pyramid"
- [ ] Introduction establishes the historian's ordinary world + inciting incident (time travel to Salem)
- [ ] Climax = historian achieves their research goal BUT the false testimony event occurs simultaneously
- [ ] Falling Action = consequences cascade, historian tries to fix it and makes things worse
- [ ] Catastrophe = the historian faces the irreversibility of what they've done
- [ ] Research includes Salem witch trial historical details
- [ ] Fatal flaw is present from Section 1

**If it fails:** Same checks as R54.

---

### R58: Brainstorm Short Story — Three-Act Structure (Post-Apocalyptic)

**Tests:** brainstorm_story with story_arc="Three-Act Structure", 3-act beats in outline

```
Brainstorm a short story using the Three-Act Structure about a radio operator in a flooded world who picks up a signal from a city that was supposed to be underwater. Genre: post-apocalyptic. Title: Signal from the Deep. 5 sections. Themes: hope vs. delusion, isolation, the pull of the impossible.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with story_arc="Three-Act Structure"
- [ ] `settings` node loads the Three-Act Structure prompt from `story_arcs` table
- [ ] Outline arc_notes reference **3-act beats**: Setup (Exposition + Inciting Incident), Confrontation (Rising Action + Midpoint), Resolution (Pre-Climax + Climax + Denouement)
- [ ] Section 1 covers Act 1 Setup (~25%) — protagonist's world + inciting incident (the signal)
- [ ] Sections 2-3 cover Act 2 Confrontation (~50%) — escalating obstacles + midpoint gut-punch
- [ ] Midpoint is a devastating setback (NOT the final climax)
- [ ] Sections 4-5 cover Act 3 Resolution — pre-climax false resolution, true climax, denouement
- [ ] Pre-climax beat is identifiable (false resolution before the real ending)
- [ ] Email sent with outline
- [ ] Saved to `writing_projects`

**If it fails:** Confirm "Three-Act Structure" row exists in `story_arcs`. Check `settings` node does `ilike` match for the arc name.

---

### R59: Brainstorm Book — Three-Act Structure (AI Marketing)

**Tests:** Three-Act Structure applied to non-fiction/hybrid content, ai-marketing genre

```
Help me brainstorm a book using the Three-Act Structure about an AI startup founder who discovers her company's flagship product is manipulating users' purchasing decisions in ways she didn't authorize. Genre: ai-marketing. Title: The Optimization. 8 chapters. Themes: ethics in tech, the line between persuasion and manipulation, corporate accountability.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with story_arc="Three-Act Structure"
- [ ] Chapters 1-2 cover Act 1 Setup (25%) — founder's world, inciting incident (discovery)
- [ ] Chapters 3-6 cover Act 2 Confrontation (50%) — obstacles, midpoint reversal
- [ ] Chapters 7-8 cover Act 3 Resolution (25%) — pre-climax, climax, denouement
- [ ] Midpoint is clearly identified as a gut-punch that resets stakes (not the climax)
- [ ] Climax is a single decisive confrontation
- [ ] Denouement addresses the thematic "Philosophy" — what does the story mean?
- [ ] arc_notes reference Three-Act terminology, NOT Freytag terminology
- [ ] Narrative goal is established in Act 1 and resolved in Act 3

**If it fails:** Same as R58. Also verify ai-marketing genre_config loads correctly.

---

### R60: Brainstorm Short Story — Three-Act Structure (Political History)

**Tests:** Three-Act Structure with political-history genre, fact-based narrative

```
Brainstorm a short story using the Three-Act Structure about a journalist in 1970s Chile who uncovers evidence of CIA involvement in the upcoming coup, but no one will publish her story. Genre: political-history. Title: The Unpublished. 5 sections. Themes: truth vs. power, the cost of speaking out, complicity of silence.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with story_arc="Three-Act Structure"
- [ ] Act 1 Setup: journalist's world + inciting incident (discovering the evidence)
- [ ] Act 2 Confrontation: at least 3 escalating obstacles, midpoint setback
- [ ] Act 3 Resolution: pre-climax false resolution + true climax + denouement
- [ ] Research includes 1970s Chile / Pinochet coup historical context
- [ ] Denouement addresses the "Philosophy" — what does the story say about truth and power?
- [ ] Protagonist's narrative goal is clear from Act 1

**If it fails:** Same checks as R58.

---

### R61: Brainstorm Book — Three-Act Structure (Historical Time Travel)

**Tests:** Three-Act Structure with historical-time-travel genre, full book outline

```
Help me brainstorm a book using the Three-Act Structure about a grief-stricken physicist who invents a time machine to save her daughter from a car accident, but each trip changes the present in ways that make the world progressively worse. Genre: historical-time-travel. Title: The Correction. 10 chapters. Themes: grief, the tyranny of good intentions, accepting loss, the butterfly effect.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with story_arc="Three-Act Structure"
- [ ] Chapters 1-2 (Act 1 Setup, ~25%): physicist's grief, inciting incident (machine works), narrative goal locked in
- [ ] Chapters 3-7 (Act 2 Confrontation, ~50%): escalating trips with worsening consequences, midpoint gut-punch
- [ ] Chapters 8-10 (Act 3 Resolution, ~25%): pre-climax false resolution, true climax, denouement
- [ ] Midpoint is NOT the final climax — it's a devastating reset that reorients expectations
- [ ] Pre-climax beat exists (protagonist thinks she's fixed it — but hasn't)
- [ ] Climax is a single decisive moment
- [ ] Denouement resolves the thematic question (can loss be undone? what does acceptance look like?)
- [ ] arc_notes use Three-Act terminology throughout
- [ ] 10 chapters properly distributed across the three acts

**If it fails:** Same as R58. Confirm target_chapter_count=10 reaches the workflow.

---

## Section M: Write from Brainstormed Outline (Tests R62–R69)

These tests verify the full brainstorm-to-write loop: an outline created by R54–R61 is stored in `writing_projects`, and then `write_short_story` or `write_chapter` auto-loads that outline to produce content that follows the arc's structural beats. Each test has a prerequisite brainstorm test that must have succeeded first.

---

### R62: Write Short Story from Freytags Pyramid Outline (Post-Apocalyptic)

**Tests:** write_short_story auto-loads Freytags Pyramid outline from writing_projects, story follows 5-act beats

**Prerequisite:** R54 must have succeeded (outline for "The Inoculator" saved to writing_projects).

```
Write the short story "The Inoculator". Genre slug: post-apocalyptic.
```

**Expected:**
- [ ] Agent calls `write_short_story` with title="The Inoculator", genre_slug="post-apocalyptic"
- [ ] `build_story_prompt` loads stored outline from `writing_projects.outline`
- [ ] Story has 5 sections matching the brainstormed Freytags Pyramid outline
- [ ] Section structure follows Freytag beats: Introduction → Rising Action → Climax (Midpoint) → Falling Action → Catastrophe/Denouement
- [ ] Climax section is the midpoint apex (plague doctor achieves a goal BUT the crack appears), NOT the final confrontation
- [ ] Falling Action shows consequences accelerating
- [ ] Final section delivers catastrophe or survival-with-consequence ending
- [ ] Characters match those defined in the R54 outline (plague doctor, antagonists, etc.)
- [ ] Writing Prime Directive followed — no cliches, no stage directions, clear prose
- [ ] Email arrives with completed story
- [ ] Draft saved to Supabase Storage and `published_content` table

**If it fails:** Check `build_story_prompt` in write_short_story (LTZ63B2H0w8Sl4FW) loads outline from `writing_projects` when no outline is passed in trigger. Verify "The Inoculator" row exists in `writing_projects` with populated `outline` field.

---

### R63: Write Chapter 1 from Freytags Pyramid Outline (Political Sci-Fi)

**Tests:** write_chapter auto-loads Freytags Pyramid outline from writing_projects, chapter 1 covers Introduction beat

**Prerequisite:** R55 must have succeeded (outline for "The Accord" saved to writing_projects).

```
Write chapter 1 of "The Accord". Genre slug: political-scifi. Chapter number: 1.
```

**Expected:**
- [ ] Agent calls `write_chapter` with title="The Accord", genre_slug="political-scifi", chapter_number=1
- [ ] `build_chapter_prompt` loads stored 10-chapter outline from `writing_projects.outline`
- [ ] Chapter 1 covers the Freytag Introduction beat — establishes the diplomat's ordinary world and inciting incident
- [ ] The diplomat's fatal flaw (from the outline) is planted in this chapter
- [ ] Characters and plot points match the R55 outline
- [ ] Writing Prime Directive followed
- [ ] Email arrives with chapter
- [ ] Story bible entries created for Chapter 1 characters/locations

**If it fails:** Check `build_chapter_prompt` in write_chapter (tpj55Sf66jrBPNT8) fetches from `writing_projects` using title match. Verify "The Accord" row exists with outline populated.

---

### R64: Write Short Story from Freytags Pyramid Outline (Ancient History)

**Tests:** write_short_story with Freytags Pyramid tragedy arc outline, ancient-history genre

**Prerequisite:** R56 must have succeeded (outline for "The Consulship of Gaius Varro" saved to writing_projects).

```
Write the short story "The Consulship of Gaius Varro". Genre slug: ancient-history.
```

**Expected:**
- [ ] Agent calls `write_short_story` with title="The Consulship of Gaius Varro", genre_slug="ancient-history"
- [ ] Stored Freytags Pyramid outline is auto-loaded
- [ ] Story follows classic tragedy arc — senator's ambition causes his ruin
- [ ] Climax (midpoint) = senator achieves consulship BUT unraveling begins
- [ ] Falling Action = poison network turns against him
- [ ] Catastrophe = total ruin or grim denouement
- [ ] Roman political/historical details from the outline's research are woven into the narrative
- [ ] Writing Prime Directive followed
- [ ] Email arrives with completed story

**If it fails:** Same as R62. Verify "The Consulship of Gaius Varro" exists in `writing_projects`.

---

### R65: Write Short Story from Freytags Pyramid Outline (Historical Time Travel)

**Tests:** write_short_story with Freytags Pyramid outline, historical-time-travel genre, speculative mechanics

**Prerequisite:** R57 must have succeeded (outline for "The Witness" saved to writing_projects).

```
Write the short story "The Witness". Genre slug: historical-time-travel.
```

**Expected:**
- [ ] Agent calls `write_short_story` with title="The Witness", genre_slug="historical-time-travel"
- [ ] Stored Freytags Pyramid outline is auto-loaded
- [ ] Introduction establishes the historian's world + time travel to Salem
- [ ] Climax = historian achieves research goal BUT false testimony occurs simultaneously
- [ ] Falling Action = consequences cascade, attempts to fix make it worse
- [ ] Catastrophe = irreversibility confronted
- [ ] Salem witch trial historical details from research are present
- [ ] Writing Prime Directive followed
- [ ] Email arrives with completed story

**If it fails:** Same as R62. Verify "The Witness" exists in `writing_projects`.

---

### R66: Write Short Story from Three-Act Outline (Post-Apocalyptic)

**Tests:** write_short_story auto-loads Three-Act Structure outline, story follows 3-act beats

**Prerequisite:** R58 must have succeeded (outline for "Signal from the Deep" saved to writing_projects).

```
Write the short story "Signal from the Deep". Genre slug: post-apocalyptic.
```

**Expected:**
- [ ] Agent calls `write_short_story` with title="Signal from the Deep", genre_slug="post-apocalyptic"
- [ ] Stored Three-Act Structure outline is auto-loaded
- [ ] Section 1 covers Act 1 Setup (~25%) — radio operator's world + inciting incident (the signal)
- [ ] Sections 2-3 cover Act 2 Confrontation (~50%) — escalating obstacles + midpoint gut-punch
- [ ] Midpoint is a devastating setback, NOT the final climax
- [ ] Sections 4-5 cover Act 3 Resolution — pre-climax false resolution, true climax, denouement
- [ ] Pre-climax false resolution is identifiable (protagonist thinks problem is solved — it isn't)
- [ ] Writing Prime Directive followed
- [ ] Email arrives with completed story

**If it fails:** Same as R62. Verify "Signal from the Deep" exists in `writing_projects`.

---

### R67: Write Chapter 1 from Three-Act Outline (AI Marketing)

**Tests:** write_chapter auto-loads Three-Act Structure outline, chapter 1 covers Act 1 Setup

**Prerequisite:** R59 must have succeeded (outline for "The Optimization" saved to writing_projects).

```
Write chapter 1 of "The Optimization". Genre slug: ai-marketing. Chapter number: 1.
```

**Expected:**
- [ ] Agent calls `write_chapter` with title="The Optimization", genre_slug="ai-marketing", chapter_number=1
- [ ] `build_chapter_prompt` loads stored 8-chapter outline from `writing_projects.outline`
- [ ] Chapter 1 covers Act 1 Setup — founder's ordinary world, inciting incident (discovering the manipulation)
- [ ] Narrative goal is established (what the protagonist wants to achieve)
- [ ] Characters and plot points match the R59 outline
- [ ] Writing Prime Directive followed
- [ ] Email arrives with chapter
- [ ] Story bible entries created for Chapter 1

**If it fails:** Same as R63. Verify "The Optimization" exists in `writing_projects` with outline populated.

---

### R68: Write Short Story from Three-Act Outline (Political History)

**Tests:** write_short_story with Three-Act Structure outline, political-history genre, fact-based narrative

**Prerequisite:** R60 must have succeeded (outline for "The Unpublished" saved to writing_projects).

```
Write the short story "The Unpublished". Genre slug: political-history.
```

**Expected:**
- [ ] Agent calls `write_short_story` with title="The Unpublished", genre_slug="political-history"
- [ ] Stored Three-Act Structure outline is auto-loaded
- [ ] Act 1 Setup: journalist's world + inciting incident (discovering CIA evidence)
- [ ] Act 2 Confrontation: at least 3 escalating obstacles + midpoint setback
- [ ] Act 3 Resolution: pre-climax false resolution + true climax + denouement
- [ ] 1970s Chile / Pinochet coup historical context from research is woven into narrative
- [ ] Denouement addresses the thematic question (truth vs. power)
- [ ] Writing Prime Directive followed
- [ ] Email arrives with completed story

**If it fails:** Same as R62. Verify "The Unpublished" exists in `writing_projects`.

---

### R69: Write Chapter 1 from Three-Act Outline (Historical Time Travel)

**Tests:** write_chapter auto-loads Three-Act Structure outline, chapter 1 covers Act 1 Setup, 10-chapter book

**Prerequisite:** R61 must have succeeded (outline for "The Correction" saved to writing_projects).

```
Write chapter 1 of "The Correction". Genre slug: historical-time-travel. Chapter number: 1.
```

**Expected:**
- [ ] Agent calls `write_chapter` with title="The Correction", genre_slug="historical-time-travel", chapter_number=1
- [ ] `build_chapter_prompt` loads stored 10-chapter outline from `writing_projects.outline`
- [ ] Chapter 1 covers Act 1 Setup — physicist's grief, ordinary world, inciting incident (machine works)
- [ ] Narrative goal is locked in by end of chapter
- [ ] Characters and emotional tone match the R61 outline
- [ ] Writing Prime Directive followed
- [ ] Email arrives with chapter
- [ ] Story bible entries created for Chapter 1

**If it fails:** Same as R63. Verify "The Correction" exists in `writing_projects` with outline populated.

---

## Section N: Prologue & Epilogue — Retrieve, Revise Outline, Write (Tests R70–R81)

These tests exercise the full prologue/epilogue workflow: retrieve an existing outline, revise it to add a prologue and/or epilogue, then write the prologue or epilogue as a chapter.

---

### R70: Retrieve Outline — The Accord (Freytag's Pyramid, Political Sci-Fi)

**Tests:** retrieve_content fetches stored outline for a previously brainstormed book

**Prerequisite:** R55 must have succeeded ("The Accord" outline saved to writing_projects).

```
Retrieve the outline for "The Accord"
```

**Expected:**
- [ ] Agent calls `retrieve_content` with search_term="The Accord"
- [ ] Returns the full outline with all 10 chapters, characters, themes, premise
- [ ] Outline uses Freytag's Pyramid structure (Introduction, Rising Action, Climax, Falling Action, Catastrophe)

**If it fails:** Check `writing_projects` table for a row with title matching "The Accord" and a populated `outline` JSONB column.

---

### R71: Revise Outline — Add Prologue and Epilogue to The Accord

**Tests:** brainstorm_story re-runs with updated concept requesting prologue and epilogue, preserves project title

**Prerequisite:** R70 must have succeeded (outline retrieved).

```
Revise the outline for "The Accord". Add a prologue that opens with a classified diplomatic transmission intercepted decades before the main story begins — hinting at the alien contact that will drive the political crisis. Add an epilogue set 20 years after the climax showing the long-term consequences of the accord on human civilization. Keep the existing 10 chapters and Freytags Pyramid structure. Genre slug: political-scifi.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with project_title="The Accord", story_arc="Freytags Pyramid", target_chapter_count=10
- [ ] Revised outline includes Section 0 (Prologue) — classified transmission, alien contact foreshadowing
- [ ] Revised outline includes Section 11 (Epilogue) — 20 years later, long-term consequences
- [ ] Original 10 chapters (1–10) preserved with Freytag's structure intact
- [ ] Outline saved/updated in `writing_projects`
- [ ] Email arrives with revised outline showing Prologue, 10 chapters, and Epilogue

**If it fails:** Check that brainstorm_story prompt includes prologue/epilogue instructions. Verify the outline JSON has chapters with number=0 and number=11.

---

### R72: Write Prologue — The Accord

**Tests:** write_chapter handles chapter_number="Prologue", uses prologue-specific prompt, shorter word count

**Prerequisite:** R71 must have succeeded (revised outline with prologue saved).

```
Write the prologue for "The Accord". Genre slug: political-scifi.
```

**Expected:**
- [ ] Agent calls `write_chapter` with project_title="The Accord", chapter_number="Prologue"
- [ ] `build_chapter_prompt` detects "Prologue" and sets chapterLabel="Prologue" (not "Chapter 0")
- [ ] Prompt includes prologue-specific instructions: "set the stage, establish tone and world, hook the reader"
- [ ] Word count target is 1500–3000 (not 3000–5000)
- [ ] Content matches the classified diplomatic transmission / alien contact concept from R71 outline
- [ ] Email subject reads: "The Accord - Prologue: [title]" (not "Chapter 0")
- [ ] File saved as `chapter_the-accord_prologue_[timestamp].md`
- [ ] Story bible entries created for Prologue
- [ ] Writing Prime Directive followed

**If it fails:** Check regex detection in `build_chapter_prompt`: `/^(prologue|prol|0)$/i`. Verify `update_story_bible` uses chapterNum=0. Check email subject expression.

---

### R73: Write Epilogue — The Accord

**Tests:** write_chapter handles chapter_number="Epilogue", uses epilogue-specific prompt

**Prerequisite:** R71 must have succeeded (revised outline with epilogue saved).

```
Write the epilogue for "The Accord". Genre slug: political-scifi.
```

**Expected:**
- [ ] Agent calls `write_chapter` with project_title="The Accord", chapter_number="Epilogue"
- [ ] `build_chapter_prompt` detects "Epilogue" and sets chapterLabel="Epilogue"
- [ ] Prompt includes epilogue-specific instructions: "provide closure, reflect on the journey, tie up remaining threads"
- [ ] Word count target is 1500–3000
- [ ] Content set 20 years after the climax, showing long-term consequences per R71 outline
- [ ] Email subject reads: "The Accord - Epilogue: [title]"
- [ ] File saved as `chapter_the-accord_epilogue_[timestamp].md`
- [ ] `update_story_bible` does NOT update `chapter_count` (prologue/epilogue skip this)
- [ ] Story bible entries created for Epilogue
- [ ] Writing Prime Directive followed

**If it fails:** Check regex detection for "Epilogue". Verify `Object.assign` logic skips `chapter_count` update when `isEpil` is true.

---

### R74: Retrieve Outline — The Correction (Three-Act Structure, Historical Time Travel)

**Tests:** retrieve_content fetches stored outline for a Three-Act Structure book

**Prerequisite:** R61 must have succeeded ("The Correction" outline saved to writing_projects).

```
Retrieve the outline for "The Correction"
```

**Expected:**
- [ ] Agent calls `retrieve_content` with search_term="The Correction"
- [ ] Returns the full outline with all 10 chapters, characters, themes, premise
- [ ] Outline uses Three-Act Structure (Setup, Confrontation, Resolution)

**If it fails:** Check `writing_projects` table for "The Correction" with populated `outline` JSONB.

---

### R75: Revise Outline — Add Prologue to The Correction

**Tests:** brainstorm_story re-runs adding only a prologue (no epilogue), preserves Three-Act Structure

**Prerequisite:** R74 must have succeeded (outline retrieved).

```
Revise the outline for "The Correction". Add a prologue set in 2089 where the protagonist's granddaughter discovers her grandmother's hidden journal describing impossible historical events — this frames the entire story as a mystery being uncovered. Keep the existing 10 chapters and Three-Act Structure. Genre slug: historical-time-travel.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with project_title="The Correction", story_arc="Three-Act Structure", target_chapter_count=10
- [ ] Revised outline includes Section 0 (Prologue) — 2089, granddaughter, hidden journal, mystery framing
- [ ] Original 10 chapters (1–10) preserved with Three-Act Structure intact
- [ ] No Epilogue added (only prologue was requested)
- [ ] Outline saved/updated in `writing_projects`
- [ ] Email arrives with revised outline

**If it fails:** Check that the outline prompt allows prologue without forcing epilogue. The "Do NOT force them" instruction should prevent an unwanted epilogue.

---

### R76: Write Prologue — The Correction

**Tests:** write_chapter with Prologue for a Three-Act Structure book

**Prerequisite:** R75 must have succeeded (revised outline with prologue saved).

```
Write the prologue for "The Correction". Genre slug: historical-time-travel.
```

**Expected:**
- [ ] Agent calls `write_chapter` with project_title="The Correction", chapter_number="Prologue"
- [ ] Content set in 2089 with the granddaughter discovering the journal (matches R75 outline)
- [ ] Prologue creates mystery/urgency that pulls reader into Chapter 1
- [ ] Word count 1500–3000
- [ ] Email subject: "The Correction - Prologue: [title]"
- [ ] File: `chapter_the-correction_prologue_[timestamp].md`
- [ ] Writing Prime Directive followed

**If it fails:** Same as R72. Additionally verify outline lookup finds chapter with number=0 or title matching "Prologue".

---

### R77: Retrieve Outline — The Optimization (Three-Act Structure, AI Marketing)

**Tests:** retrieve_content fetches stored outline for an 8-chapter book

**Prerequisite:** R59 must have succeeded ("The Optimization" outline saved to writing_projects).

```
Retrieve the outline for "The Optimization"
```

**Expected:**
- [ ] Agent calls `retrieve_content` with search_term="The Optimization"
- [ ] Returns the full outline with all 8 chapters, characters, themes, premise
- [ ] Outline uses Three-Act Structure

**If it fails:** Check `writing_projects` table for "The Optimization" with populated `outline`.

---

### R78: Revise Outline — Add Epilogue Only to The Optimization

**Tests:** brainstorm_story re-runs adding only an epilogue (no prologue), 8-chapter book

**Prerequisite:** R77 must have succeeded (outline retrieved).

```
Revise the outline for "The Optimization". Add an epilogue set 5 years later where the protagonist discovers that the AI marketing system they dismantled has quietly rebuilt itself inside a competitor's platform — but this time it has learned from its mistakes. Keep the existing 8 chapters and Three-Act Structure. Genre slug: ai-marketing.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with project_title="The Optimization", story_arc="Three-Act Structure", target_chapter_count=8
- [ ] Revised outline includes Section 9 (Epilogue) — 5 years later, AI rebuilt itself in competitor platform
- [ ] Original 8 chapters (1–8) preserved with Three-Act Structure intact
- [ ] No Prologue added (only epilogue was requested)
- [ ] Outline saved/updated in `writing_projects`
- [ ] Email arrives with revised outline

**If it fails:** Verify epilogue number is `chapterCount + 1` (9 for an 8-chapter book). Check that prologue is not forced.

---

### R79: Write Epilogue — The Optimization

**Tests:** write_chapter with Epilogue for an 8-chapter Three-Act book

**Prerequisite:** R78 must have succeeded (revised outline with epilogue saved).

```
Write the epilogue for "The Optimization". Genre slug: ai-marketing.
```

**Expected:**
- [ ] Agent calls `write_chapter` with project_title="The Optimization", chapter_number="Epilogue"
- [ ] Content set 5 years later, AI system has rebuilt itself (matches R78 outline)
- [ ] Epilogue provides closure and lasting emotional resonance
- [ ] Word count 1500–3000
- [ ] Email subject: "The Optimization - Epilogue: [title]"
- [ ] File: `chapter_the-optimization_epilogue_[timestamp].md`
- [ ] `chapter_count` NOT updated (epilogue skips this)
- [ ] Writing Prime Directive followed

**If it fails:** Same as R73. Verify epilogue lookup finds the correct chapter entry in the stored outline.

---

### R80: Retrieve Outline — The Consulship of Gaius Varro (Freytag's Pyramid, Ancient History)

**Tests:** retrieve_content fetches stored outline for a short story brainstorm

**Prerequisite:** R56 must have succeeded ("The Consulship of Gaius Varro" outline saved to writing_projects).

```
Retrieve the outline for "The Consulship of Gaius Varro"
```

**Expected:**
- [ ] Agent calls `retrieve_content` with search_term="The Consulship of Gaius Varro"
- [ ] Returns the full outline with chapters, characters, themes, premise
- [ ] Outline uses Freytag's Pyramid structure

**If it fails:** Check `writing_projects` for "The Consulship of Gaius Varro".

---

### R81: Revise Outline — Add Prologue and Epilogue to Gaius Varro, Then Write Prologue

**Tests:** Full end-to-end: revise outline to add both prologue and epilogue, then immediately write the prologue

**Prerequisite:** R80 must have succeeded (outline retrieved).

**Step 1 — Revise the outline:**

```
Revise the outline for "The Consulship of Gaius Varro". Add a prologue set during the founding of Rome — Romulus drawing the sacred boundary — as a mythic parallel to Varro's later struggle to hold the Republic's boundaries together. Add an epilogue set centuries later as a medieval monk transcribes Varro's lost writings, realizing the senator's warnings about the Republic's fall echo in his own era. Keep the existing chapters and Freytags Pyramid arc. Genre slug: ancient-history.
```

**Expected for Step 1:**
- [ ] Agent calls `brainstorm_story` with project_title="The Consulship of Gaius Varro", story_arc="Freytags Pyramid"
- [ ] Revised outline includes Prologue (Romulus, sacred boundary) and Epilogue (medieval monk, lost writings)
- [ ] Original chapters preserved with Freytag's Pyramid intact
- [ ] Outline saved/updated in `writing_projects`

**Step 2 — Write the prologue:**

```
Write the prologue for "The Consulship of Gaius Varro". Genre slug: ancient-history.
```

**Expected for Step 2:**
- [ ] Agent calls `write_chapter` with chapter_number="Prologue"
- [ ] Content covers Romulus and the sacred boundary of Rome (matches Step 1 outline)
- [ ] Mythic tone distinct from the main political narrative
- [ ] Word count 1500–3000
- [ ] Email arrives with subject: "The Consulship of Gaius Varro - Prologue: [title]"
- [ ] Story bible entries created (Romulus, founding of Rome, sacred boundary)
- [ ] Writing Prime Directive followed

**If it fails:** Verify both steps independently. Step 1: check outline JSON for number=0 Prologue entry. Step 2: check prologue regex detection and outline chapter lookup for number=0.

---

## Section O: Outline Management — List, Version History, Revert (Tests R82–R93)

These tests exercise the 2026-03-14 outline management features: listing all outlines, viewing outline version history, and reverting to a previous outline version.

---

### R82: List All Outlines

**Tests:** retrieve_content with content_type=outline returns all writing projects that have outlines

```
List all outlines
```

**Expected:**
- [ ] Agent calls `retrieve_content` with an operation that triggers the `list_outlines` path
- [ ] Returns a list of all projects in `writing_projects` that have a non-null `outline` column
- [ ] Each entry shows project title, genre_slug, chapter count, and creation date
- [ ] Does NOT return projects without outlines
- [ ] Does NOT fall through to short story search

**If it fails:** Check `retrieve_content` Code node for `list_outlines` operation handling. Verify the Supabase query filters for `outline.neq.null`.

---

### R83: List Outlines — Alternate Phrasing

**Tests:** preprocess_message detects outline listing requests with natural phrasing

```
Show me my outlines
```

**Expected:**
- [ ] Agent routes to `retrieve_content` with list_outlines operation
- [ ] Same results as R82
- [ ] Stop words ("show", "me", "my", "outlines") are correctly handled

**If it fails:** Check preprocess_message regex for outline listing patterns. Verify stop words list includes "outline", "outlines", "list", "show".

---

### R84: Outline Version History — The Accord

**Tests:** retrieve_content returns version history for a revised outline

**Prerequisite:** R71 must have succeeded (The Accord outline was revised, creating a version snapshot).

```
Show outline version history for "The Accord"
```

**Expected:**
- [ ] Agent calls `retrieve_content` with operation matching `outline_versions`
- [ ] Returns version list from `outline_versions` table for "The Accord"
- [ ] Each version shows: version number, snapshot date, chapter count at time of snapshot
- [ ] At least one version exists (the pre-revision snapshot from R71)

**If it fails:** Check `outline_versions` table for rows matching "The Accord" project. Verify the `save_outline` node in Brainstorm Story creates snapshots before overwriting.

---

### R85: Outline Version History — The Correction

**Tests:** outline_versions works for a different project with Three-Act Structure

**Prerequisite:** R75 must have succeeded (The Correction outline was revised).

```
Show outline version history for "The Correction"
```

**Expected:**
- [ ] Returns version list from `outline_versions` for "The Correction"
- [ ] At least one version exists (pre-revision snapshot from R75)
- [ ] Version entry shows the original 10-chapter Three-Act Structure outline before prologue was added

**If it fails:** Same as R84. Check that the project title match is case-insensitive (ilike).

---

### R86: Outline Version History — No Revisions

**Tests:** outline_versions returns empty/informative result for an outline that was never revised

**Prerequisite:** R58 must have succeeded ("Signal from the Deep" brainstormed but never revised).

```
Show outline version history for "Signal from the Deep"
```

**Expected:**
- [ ] Agent calls `retrieve_content` with outline_versions operation
- [ ] Returns empty version list or a message indicating no previous versions exist
- [ ] Does NOT error out — handles the empty case gracefully

**If it fails:** Verify `outline_versions` query handles zero results. Check the Code node returns a friendly message rather than an error.

---

### R87: Revert Outline — The Accord to Version 1

**Tests:** revert_outline restores a previous outline version, replacing the current one

**Prerequisite:** R84 must have succeeded (version history exists for The Accord).

```
Revert the outline for "The Accord" to version 1
```

**Expected:**
- [ ] Agent calls `retrieve_content` with operation matching `revert_outline`
- [ ] The version 1 outline is loaded from `outline_versions`
- [ ] The current outline in `writing_projects.outline` is replaced with the version 1 content
- [ ] A new version snapshot is created before the revert (preserving the current state)
- [ ] Confirmation message includes the project title and version number reverted to
- [ ] The reverted outline is the original pre-revision version (without prologue/epilogue)

**If it fails:** Check the revert logic reads from `outline_versions` and writes to `writing_projects.outline`. Verify a pre-revert snapshot is saved.

---

### R88: Verify Revert — Retrieve Reverted Outline

**Tests:** after revert, the stored outline matches the reverted version

**Prerequisite:** R87 must have succeeded.

```
Retrieve the outline for "The Accord"
```

**Expected:**
- [ ] Returns the version 1 outline (the original without prologue/epilogue)
- [ ] Outline has the original 10 chapters only — no Prologue (section 0) or Epilogue (section 11)
- [ ] Freytag's Pyramid structure is intact
- [ ] Chapter briefs match the original brainstorm, not the revised version

**If it fails:** Check `writing_projects.outline` was actually updated by the revert operation. Verify the revert didn't just return the old version without saving it.

---

### R89: Revert Outline — The Optimization to Pre-Epilogue Version

**Tests:** revert works for an 8-chapter book, restoring outline without epilogue

**Prerequisite:** R78 must have succeeded (The Optimization was revised to add epilogue). R84-like version history must exist.

```
Show outline version history for "The Optimization"
```

Then:

```
Revert the outline for "The Optimization" to version 1
```

**Expected for Step 1:**
- [ ] Version history shows at least one entry (pre-epilogue snapshot)

**Expected for Step 2:**
- [ ] Outline reverted to original 8-chapter version without epilogue
- [ ] Pre-revert snapshot saved (the version with epilogue)
- [ ] Confirmation message returned

**If it fails:** Same as R87. Verify version number is correct — version 1 should be the original 8-chapter outline.

---

### R90: Revert Outline — Invalid Version Number

**Tests:** revert_outline handles a non-existent version gracefully

**Prerequisite:** R84 must have succeeded (The Accord has version history).

```
Revert the outline for "The Accord" to version 99
```

**Expected:**
- [ ] Agent attempts revert but version 99 does not exist
- [ ] Returns a clear error message: version not found
- [ ] The current outline is NOT modified
- [ ] No snapshot is created (nothing changed)

**If it fails:** Check the revert logic validates the version exists before proceeding. Verify error handling returns a user-friendly message.

---

### R91: Revert Outline — Project Not Found

**Tests:** revert_outline handles a non-existent project gracefully

```
Revert the outline for "A Story That Does Not Exist" to version 1
```

**Expected:**
- [ ] Returns a clear error message: project not found
- [ ] No database changes made

**If it fails:** Check the project lookup query and error handling path.

---

### R92: Outline Revision Creates Version Snapshot

**Tests:** re-revising an outline after a revert creates a new version snapshot

**Prerequisite:** R87 must have succeeded (The Accord was reverted to version 1).

```
Revise the outline for "The Accord". Add a prologue set during humanity's first contact with the alien signal — a radio astronomer alone in an observatory at 3 AM hearing a pattern in the static. Keep the existing 10 chapters and Freytags Pyramid structure. Genre slug: political-scifi.
```

**Expected:**
- [ ] Agent calls `brainstorm_story` with project_title="The Accord"
- [ ] Before saving, the current outline (version 1 content) is snapshotted to `outline_versions`
- [ ] Revised outline includes a new Prologue (section 0) — radio astronomer, first contact
- [ ] Original 10 chapters preserved with Freytag's Pyramid intact
- [ ] No epilogue added (only prologue was requested)
- [ ] Outline saved to `writing_projects`
- [ ] Email arrives with revised outline
- [ ] Revision mode: existing characters from The Accord are preserved (PRESERVE EXISTING CHARACTERS rule)

**If it fails:** Check that the save_outline node creates a snapshot even when the current outline is itself a reverted version. Verify the brainstorm revision mode loads and preserves existing characters.

---

### R93: Verify Version History After Multiple Revisions

**Tests:** version history accumulates correctly across revisions and reverts

**Prerequisite:** R92 must have succeeded.

```
Show outline version history for "The Accord"
```

**Expected:**
- [ ] Version history shows at least 3 entries:
  - Version 1: Original brainstorm (10 chapters, no prologue/epilogue)
  - Version 2: First revision (prologue + epilogue added, from R71)
  - Version 3: Pre-revert snapshot (the version with prologue/epilogue, from R87 revert)
- [ ] Versions are ordered chronologically
- [ ] Each version shows snapshot date and chapter count

**If it fails:** Check `outline_versions` table for all rows matching "The Accord". Verify the revert operation (R87) created a pre-revert snapshot and the re-revision (R92) created another.

---

# PART 2: VOICE REGRESSION TESTS

> **How to run:** Speak these commands to the ElevenLabs voice agent (Eve). The voice agent POSTs to the hub's webhook at `/author_request`. The hub's system prompt is designed to interpret messy voice transcriptions.
>
> **Important:** Voice transcriptions are often imperfect — words get misheard, sentences run together, there's no punctuation. These tests simulate real voice usage.

---

## Section V-A: Core Voice Commands (Tests V01–V18)

---

### V01: Voice — Deep Research

**Speak:**
> "Hey can you research what's going on with post apocalyptic fiction right now like what are the big trends and new books coming out? what are current hot amazon kindle keywords and best sellers?"

**Expected:** Agent calls `deep_research_topic`. Returns research summary in chat.

---

### V02: Voice — Save Research

**Speak:**
> "Save that research as a report call it post apocalyptic trends twenty twenty six"

**Expected:** Agent calls `manage_research_reports` operation=save. Report saved to Supabase.

---

### V03: Voice — Email Report

**Speak:**
> "Send me an email with a summary of that research use the subject line voice test research report"

**Expected:** Agent calls `email_report`. Email arrives.

---

### V04: Voice — Write Blog Post

**Speak:**
> "Write a blog post about how AI is changing marketing in twenty twenty six genre slug ai marketing keywords AI tools marketing automation target about fifteen hundred words"

**Expected:** Agent maps to write_blog_post with genre_slug=ai-marketing. Blog written and emailed. No cliches (Writing Prime Directive active).

---

### V05: Voice — Write Newsletter

**Speak:**
> "Write me a newsletter for the political history genre about revolutions that changed the world date today"

**Expected:** Agent maps to write_newsletter with genre_slug=political-history. Newsletter emailed.

---

### V06: Voice — Write Short Story

**Speak:**
> "Write a short story in the ancient history genre about a Roman soldier who discovers a hidden library beneath the Colosseum make it about three thousand words and research Roman military life and the Colosseum underground tunnels"

**Expected:** Agent maps to write_short_story with genre_slug=ancient-history. Perplexity researches topics. Story written and emailed.

---

### V07: Voice — Generate Cover Art

**Speak:**
> "Generate cover art for a post apocalyptic story called The Last Signal show a figure on a rooftop with a radio antenna surrounded by flooded city at sunset"

**Expected:** Agent maps to generate_cover_art with genre_slug=post-apocalyptic. Image generated and emailed.

---

### V08: Voice — Social Media (Twitter)

**Speak:**
> "Take this and make twitter posts from it The Last Signal is a new story about a radio operator in flooded Manhattan picking up a mysterious broadcast platform twitter"

**Expected:** Agent maps to repurpose_to_social platform=twitter. Tweets generated and emailed.

---

### V09: Voice — Social Media (LinkedIn)

**Speak:**
> "Repurpose that blog post about AI marketing into LinkedIn posts"

**Expected:** Agent maps to repurpose_to_social platform=linkedin. Posts generated.

---

### V10: Voice — Social Media (Instagram)

**Speak:**
> "Turn that time travel story about the Titanic into Instagram posts with lots of hashtags"

**Expected:** Agent maps to repurpose_to_social platform=instagram. Caption-style post with 20-30 hashtags. Email arrives.

---

### V11: Voice — Brainstorm Story

**Speak:**
> "Brainstorm a new story called The Clockwork Rebellion its about sentient clockwork automatons in Victorian London who organize a labor revolution genre post apocalyptic eight chapters themes are freedom versus control and what makes someone human"

**Expected:** Agent maps to brainstorm_story. Outline emailed. Saved to writing_projects.

---

### V12: Voice — Write Chapter from Outline

**Speak:**
> "Write chapter one of The Clockwork Rebellion genre post apocalyptic chapter number one"

**Prerequisite:** V11 must have succeeded.

**Expected:** Agent maps to write_chapter. Loads stored outline. Chapter written and emailed.

---

### V13: Voice — List Drafts

**Speak:**
> "Show me my drafts"

**Expected:** Agent maps to manage_library operation=list_drafts. Returns formatted list.

---

### V14: Voice — Approve and Publish

**Speak:**
> "Approve the draft called [title from V13]"

Then:

> "Now publish it"

**Expected:** First command approves, second publishes. Status changes confirmed. Email notifications for each.

---

### V15: Voice — Reject Draft

**Speak:**
> "Reject the draft called [different title from V13]"

**Expected:** Agent maps to manage_library operation=reject. Status changes to rejected. Email notification.

---

### V16: Voice — Schedule Content

**Speak:**
> "Schedule the draft called [title from V13] for March twentieth twenty twenty six"

**Expected:** Agent maps to manage_library operation=schedule with schedule_date=2026-03-20. Status changes to scheduled. Email notification with date.

---

### V17: Voice — List Scheduled

**Speak:**
> "Show me my scheduled content"

**Expected:** Agent maps to manage_library operation=list_scheduled. Returns list with scheduled dates.

---

### V18: Voice — Story Bible

**Speak:**
> "Get the story bible for The Clockwork Rebellion"

**Prerequisite:** V12 must have succeeded.

**Expected:** Agent calls manage_story_bible operation=get. Returns character/location entries.

---

## Section V-B: Voice Genre Inference & Edge Cases (Tests V19–V23)

---

### V19: Voice — Genre Inference (Ambiguous)

**Speak:**
> "Write me a story about ancient Egypt like pharaohs and pyramids and stuff"

**Expected:** Agent infers genre_slug=ancient-history without being explicitly told. Fills in other parameters. Story written.

---

### V20: Voice — Messy/Natural Speech

**Speak:**
> "Um yeah so I want to uh write a blog post about like how political science fiction predicted the rise of like AI governance and surveillance states you know like nineteen eighty four and all that genre is political sci fi about two thousand words"

**Expected:** Agent parses through the filler words. Maps to write_blog_post with genre_slug=political-scifi. Blog written.

---

### V21: Voice — List Research Reports

**Speak:**
> "Show me all my research reports"

**Expected:** Agent calls manage_research_reports operation=list. Returns report list.

---

### V22: Voice — Multi-Step Voice Workflow

**Speak (Message 1):**
> "Research the fall of the Roman Empire and why it collapsed"

**Speak (Message 2, after response):**
> "Now write a blog post about that for the ancient history genre about fifteen hundred words"

**Expected:** Agent researches first, then writes blog incorporating the findings.

---

### V23: Voice — Retrieve Content (No Callback)

**Speak:**
> "Find my draft story about the Titanic"

**Expected:**
- [ ] Agent calls `retrieve_content` with search_term matching "Titanic"
- [ ] Returns summary (title, content_type, character count)
- [ ] No outbound call triggered (no callback language)

---

## Section V-C: Eve Knowledge Callback & Review Mode (Tests V24–V32)

> **How to run:** These tests require content to already exist in Supabase (research reports, drafts). Run at least R02, R06, and R30 first so there is content to retrieve.
>
> **What's being tested:** Eve retrieves content → n8n hub fetches from Supabase → ElevenLabs Knowledge Base API injects content → Outbound Call API triggers Eve to call you back → Eve discusses/revises the loaded content.

---

### V24: Voice — Retrieve Research Report (No Callback)

**Speak:**
> "Can you pull up my research report about post apocalyptic fiction trends"

**Expected:**
- [ ] Eve fires `forward_writing_request`
- [ ] Hub calls `retrieve_content` with content_type=research_report, search_term matching "post apocalyptic fiction trends"
- [ ] Hub returns summary: found title, character count
- [ ] Eve relays the summary back — no outbound call triggered (no callback language)

**If it fails:** Check Sub - Retrieve Content workflow (DQS2zIhVjyuxabcb) is active. Check `research_reports` table has matching row.

---

### V25: Voice — Retrieve Draft Story (No Callback)

**Speak:**
> "Find my draft short story about the Titanic"

**Expected:**
- [ ] Hub calls `retrieve_content` with search_term matching "Titanic"
- [ ] Returns match from `published_content` (the R08 short story)
- [ ] Eve relays result — no callback

---

### V26: Voice — Retrieve & Callback — Review Mode

**Speak:**
> "Pull up my draft blog post about aqueducts and call me back so we can revise it"

**Expected:**
- [ ] Eve says something like "Let me pull that up... I'll call you right back"
- [ ] Eve fires `forward_writing_request` with "RETRIEVE AND CALLBACK" language
- [ ] Hub calls `retrieve_content` → finds the blog post from R14
- [ ] Hub calls `eve_knowledge_callback` with content_text, callback_mode=review
- [ ] ElevenLabs KB: old "Eve Session:" docs cleaned up, new doc created and attached
- [ ] Outbound call triggered to +14435012219
- [ ] Eve calls you back within ~30 seconds
- [ ] Eve opens with review-mode greeting: mentions the content title, asks highlights or revisions
- [ ] Eve can reference specific passages from the blog post during discussion

**If it fails:** Check Sub - Eve Knowledge Callback (PaFJlsxWq4BKt0iq) is active. Check ElevenLabs API key. Check phone number is correct in settings node.

---

### V27: Voice — Retrieve & Callback — Brainstorm Mode

**Speak:**
> "Load the research report on post apocalyptic trends and call me back let's brainstorm a new story outline from it"

**Expected:**
- [ ] Eve says she'll pull it up and call back
- [ ] Hub calls `retrieve_content` → finds research report
- [ ] Hub calls `eve_knowledge_callback` with callback_mode=brainstorm
- [ ] Eve calls back with brainstorm-mode greeting: asks highlights or dive into brainstorming
- [ ] Eve references specific data points and findings from the research report during brainstorming
- [ ] You can brainstorm interactively — suggest characters, themes, plot points — Eve builds on the research

---

### V28: Voice — Callback Review with Editorial Feedback

**Speak:**
> "Get my short story about the Roman soldier under the Colosseum and help me improve it"

**Prerequisite:** V06 must have succeeded (ancient-history short story).

**Expected:**
- [ ] Eve fires callback with callback_mode=review
- [ ] On callback, Eve can give specific editorial feedback:
  - Identify weak openings or slow pacing
  - Suggest stronger word choices
  - Flag structural issues
  - Quote or reference specific passages from the story
- [ ] Feedback is constructive and actionable, not generic

---

### V29: Voice — KB Cleanup (Back-to-Back Retrievals)

**Purpose:** Verify old session KB docs are removed before new ones are added.

**Speak (first call):**
> "Pull up my research report about post apocalyptic trends and call me back to review it"

**Wait for callback, discuss briefly, then hang up.**

**Speak (second call):**
> "Now pull up my draft blog post about aqueducts and call me back to revise that instead"

**Expected:**
- [ ] Second callback works correctly — Eve has the blog post loaded, NOT the research report
- [ ] ElevenLabs agent config shows only ONE "Eve Session:" KB doc (the blog post, not both)
- [ ] Eve cannot reference the research report (it was cleaned up)

**If it fails:** Check `cleanup_old_kb` logic in eve_callback Code node filters for docs starting with "Eve Session:".

---

### V30: Voice — Content Not Found

**Speak:**
> "Pull up my draft story about alien wizards on Neptune and call me back"

**Expected:**
- [ ] Hub calls `retrieve_content` — returns found=false
- [ ] Hub does NOT call `eve_knowledge_callback` (no content to load)
- [ ] Eve relays error: content not found, suggests trying a different search term or listing drafts
- [ ] No outbound call is triggered

---

### V31: Voice — Parallel Tasks + Callback

**Speak:**
> "Write a newsletter about ancient Roman festivals for the ancient history genre and also pull up my research report about post apocalyptic trends and call me back to brainstorm"

**Expected:**
- [ ] Eve detects two independent tasks
- [ ] Task 1: fires `forward_writing_request` for the newsletter (write_newsletter)
- [ ] Task 2: fires `forward_writing_request` with "RETRIEVE AND CALLBACK" for the research report
- [ ] Newsletter gets written and emailed (async)
- [ ] Research report gets loaded into KB and Eve calls back for brainstorming
- [ ] Both tasks execute — one produces an email, one produces a callback

---

### V32: Voice — Centralized Email Verification

**Speak:**
> "Send me an email report with just the text centralized email voice test and subject line V32 Email Config Test"

**Expected:**
- [ ] Email arrives at the address stored in `app_config.recipient_email` (not hardcoded)
- [ ] If `bcc_email` is set, BCC recipient also receives it
- [ ] Confirms the hub_settings Code node correctly reads from Supabase even for voice-triggered requests

---

# PART 3: RECOMMENDED TEST ORDER (WITH PROMPTS)

## Smoke Test (Fastest — 12 tests, covers all critical paths)

---

**1. R01 — Deep Research (Perplexity)**

```
Research the current state of post-apocalyptic fiction in 2026. What are the trending themes, notable new releases, and how has the genre evolved since COVID? Include citations.
```

---

**2. R05 — Centralized Email Config**

```
Send me an email report with this content:

# Centralized Email Test

This test verifies that the hub reads recipient_email from the app_config table in Supabase.

Use subject line "R05: Centralized Email Config Test"
```

---

**3. R06 — Blog Post (original genre, full pipeline + prime directive)**

```
Write a blog post for the post-apocalyptic genre. Topic: "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026". Genre slug: post-apocalyptic. Keywords: post-apocalyptic books, climate fiction, survival stories, dystopian novels. Target length: 1500 words.
```

---

**4. R14 — Blog Post (new genre, content fallback)**

```
Write a blog post in the ancient-history genre. Topic: "The Forgotten Engineers of Rome: How Aqueducts Shaped an Empire". Genre slug: ancient-history. Keywords: Roman engineering, aqueducts, ancient infrastructure, Frontinus. Target length: 1500 words.
```

---

**5. R20 — List Drafts (library works)**

```
List my drafts
```

---

**6. R22 — Approve Draft**

```
Approve the draft titled "[exact title from R20 results]"
```

---

**7. R30 — Brainstorm Story**

```
Brainstorm a post-apocalyptic story called "The Seed Vault" about the last botanist on Earth protecting the Svalbard seed vault from raiders who don't understand its value. Themes: preservation, sacrifice, legacy, nature vs. human destruction. 6 chapters. Genre slug: post-apocalyptic.
```

---

**8. R31 — Write Chapter from Stored Outline**

```
Write chapter 1 of "The Seed Vault". Genre slug: post-apocalyptic. Chapter number: 1.
```

---

**9. R42 — Cron Auto-Publish**

*(Manual test — requires setting schedule_date in the past on an approved item in the database. The cron workflow runs hourly and auto-publishes.)*

---

**10. R43 — Writing Prime Directive Verification**

```
Write a blog post in the ai-marketing genre. Topic: "How AI Tools Are Changing Content Marketing". Genre slug: ai-marketing. Keywords: AI content tools, marketing automation, generative AI. Target length: 1200 words.
```

---

**11. V04 — Voice Blog Post**

> "Write a blog post about how AI is changing marketing in twenty twenty six genre slug ai marketing keywords AI tools marketing automation target about fifteen hundred words"

---

**12. V26 — Retrieve & Callback (review mode)**

> "Pull up my draft blog post about aqueducts and call me back so we can revise it"

---

## Medium Regression (with prompts)

Run the 12 Smoke Tests above first, then continue with these additional tests.

---

### Group 1: Infrastructure + Centralized Email (R01–R05)

**R01** — *(see Smoke Test #1 above)*

**R02 — Save Research Report**

```
Save that research as a report with topic "Post-Apocalyptic Fiction Trends 2026" and genre slug post-apocalyptic.
```

**R03 — Email Report**

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

**R04 — Story Bible Read (Empty)**

```
Get the story bible for project "Regression Test Project"
```

**R05** — *(see Smoke Test #2 above)*

---

### Group 2: Blog + Short Story, Original Genres (R06, R08)

**R06** — *(see Smoke Test #3 above)*

**R08 — Write Short Story (historical-time-travel)**

```
Write a short story. Genre slug: historical-time-travel. Premise: A historian discovers that antique photographs can transport her to the moment they were taken. She finds a photo of the Titanic's maiden voyage departure and must decide whether to warn the passengers. Tone: literary, bittersweet. Length: 2500 words. Research topics: ["Titanic maiden voyage Southampton 1912", "history of early photography techniques", "time travel paradoxes in fiction"]
```

---

### Group 3: Cover Art + Social (R09, R10, R13)

**R09 — Generate Cover Art**

```
Generate cover art for a political-scifi short story called "The Senate of Stars". The story is about a diplomat navigating a galactic parliament where every species has a fundamentally different concept of justice. Genre slug: political-scifi. The image should show a vast circular chamber with alien delegates, lit by the light of a dying star through a massive viewport.
```

**R10 — Repurpose to Social — Twitter**

```
Repurpose this into Twitter posts: "The Senate of Stars is a new political sci-fi short story about a diplomat navigating a galactic parliament where every species has a different concept of justice. A meditation on diplomacy, compromise, and whether true fairness is even possible across civilizations." Platform: twitter.
```

**R13 — Repurpose to Social — Instagram**

```
Repurpose this into Instagram posts: "A historian discovers that antique photographs can transport her to the moment they were taken. She finds a photo from the Titanic's maiden voyage and must decide whether to change history." Platform: instagram. Genre slug: historical-time-travel.
```

---

### Group 4: New Genres — One Each Type (R14, R15, R16)

**R14** — *(see Smoke Test #4 above)*

**R15 — Write Short Story (ai-marketing)**

```
Write a short story in the ai-marketing genre. Genre slug: ai-marketing. Premise: An AI trained to write ad copy for a luxury perfume brand starts composing poetry instead — and the poems sell better than any ad ever did. Tone: satirical, sharp, funny. Length: 2000 words. Research topics: ["AI generated advertising 2026", "perfume marketing psychology", "computational creativity"]
```

**R16 — Write Newsletter (political-history)**

```
Write a newsletter for the political-history genre. Topic: "This Month in Political History: Revolutions That Changed the Map". Genre slug: political-history. Date: 2026-03-10.
```

---

### Group 5: Content Library Full Lifecycle (R20–R24)

**R20** — *(see Smoke Test #5 above)*

**R21 — List Drafts — Filter by Type**

```
List my draft blog posts
```

**R22** — *(see Smoke Test #6 above)*

**R23 — Publish Content**

```
Publish the content titled "[same title from R22]"
```

**R24 — List Published**

```
List my published content
```

---

### Group 6: Scheduling (R26–R27)

**R26 — Schedule Publishing**

```
Schedule the draft titled "[title from R20]" for 2026-03-20
```

**R27 — List Scheduled Content**

```
List my scheduled content
```

---

### Group 7: Brainstorm → Chapter → Story Bible (R30–R32)

**R30** — *(see Smoke Test #7 above)*

**R31** — *(see Smoke Test #8 above)*

**R32 — Story Bible Read After Chapter**

```
Get the story bible for project "The Seed Vault"
```

---

### Group 8: Research Reports (R33)

**R33 — List Research Reports**

```
List my research reports
```

---

### Group 9: Cron Auto-Publish (R42)

**R42** — *(see Smoke Test #9 above — manual database test)*

---

### Group 10: Prime Directive (R43, R45)

**R43** — *(see Smoke Test #10 above)*

**R45 — Prime Directive — Short Story**

```
Write a short story in the political-scifi genre. Genre slug: political-scifi. Premise: A junior senator discovers that the AI running the galactic parliament has been quietly editing legislation before votes. Tone: tense, cynical. Length: 1500 words.
```

---

### Group 11: Story Structure Guidelines (R49, R50, R51)

**R49 — Story Structure Guidelines — Brainstorm Uses Structure Model**

```
Brainstorm a short story about a soldier who wakes up 100 years after a war she started, only to find the enemy she fought won and built a better world. Genre: post-apocalyptic. Title: The Wrong Side. Sections: 5
```

**R50 — Story Structure Guidelines — Short Story Has 5-Stage Arc**

```
Write a short story about a city maintenance worker who discovers the AI managing the city's infrastructure has been writing poetry in the gaps between system logs. Genre: ai-marketing. Length: 2500 words. Tone: quiet and melancholic.
```

**R51 — Story Structure Guidelines — Chapter Has Internal Arc**

```
Write chapter 1 of a story called "The Cartographer's Lie" in post-apocalyptic genre. Brief: A map-maker is hired to chart the forbidden eastern territories. On the first day, she discovers the map she was given to copy is intentionally wrong.
```

---

### Group 12: Voice — Blog, Story, Brainstorm (V04, V06, V11)

**V04** — *(see Smoke Test #11 above)*

**V06 — Voice — Write Short Story**

> "Write a short story in the ancient history genre about a Roman soldier who discovers a hidden library beneath the Colosseum make it about three thousand words and research Roman military life and the Colosseum underground tunnels"

**V11 — Voice — Brainstorm Story**

> "Brainstorm a new story called The Clockwork Rebellion its about sentient clockwork automatons in Victorian London who organize a labor revolution genre post apocalyptic eight chapters themes are freedom versus control and what makes someone human"

---

### Group 13: Retrieve Content + Eve Callback (V24, V26, V27)

**V24 — Retrieve Research Report (No Callback)**

> "Can you pull up my research report about post apocalyptic fiction trends"

**V26** — *(see Smoke Test #12 above)*

**V27 — Retrieve & Callback — Brainstorm Mode**

> "Load the research report on post apocalyptic trends and call me back let's brainstorm a new story outline from it"

---

### Group 14: Edge Case (V30)

**V30 — Content Not Found**

> "Pull up my draft story about alien wizards on Neptune and call me back"

---

### Group 15: Voice Centralized Email (V32)

**V32 — Centralized Email Verification**

> "Send me an email report with just the text centralized email voice test and subject line V32 Email Config Test"

---

### Group 16: Prologue & Epilogue (R70–R73)

**R70 — Retrieve Outline — The Accord**

```
Retrieve the outline for "The Accord"
```

**R71 — Revise Outline — Add Prologue and Epilogue to The Accord**

```
Revise the outline for "The Accord". Add a prologue that opens with a classified diplomatic transmission intercepted decades before the main story begins — hinting at the alien contact that will drive the political crisis. Add an epilogue set 20 years after the climax showing the long-term consequences of the accord on human civilization. Keep the existing 10 chapters and Freytags Pyramid structure. Genre slug: political-scifi.
```

**R72 — Write Prologue — The Accord**

```
Write the prologue for "The Accord". Genre slug: political-scifi.
```

**R73 — Write Epilogue — The Accord**

```
Write the epilogue for "The Accord". Genre slug: political-scifi.
```

---

### Group 17: Outline Management (R82–R93)

**R82 — List All Outlines**

```
List all outlines
```

**R83 — List Outlines — Alternate Phrasing**

```
Show me my outlines
```

**R84 — Outline Version History — The Accord**

```
Show outline version history for "The Accord"
```

**R85 — Outline Version History — The Correction**

```
Show outline version history for "The Correction"
```

**R86 — Outline Version History — No Revisions**

```
Show outline version history for "Signal from the Deep"
```

**R87 — Revert Outline — The Accord to Version 1**

```
Revert the outline for "The Accord" to version 1
```

**R88 — Verify Revert — Retrieve Reverted Outline**

```
Retrieve the outline for "The Accord"
```

**R89 — Revert Outline — The Optimization (two-step)**

```
Show outline version history for "The Optimization"
```

Then:

```
Revert the outline for "The Optimization" to version 1
```

**R90 — Revert Outline — Invalid Version Number**

```
Revert the outline for "The Accord" to version 99
```

**R91 — Revert Outline — Project Not Found**

```
Revert the outline for "A Story That Does Not Exist" to version 1
```

**R92 — Re-Revise After Revert**

```
Revise the outline for "The Accord". Add a prologue set during humanity's first contact with the alien signal — a radio astronomer alone in an observatory at 3 AM hearing a pattern in the static. Keep the existing 10 chapters and Freytags Pyramid structure. Genre slug: political-scifi.
```

**R93 — Verify Version History After Multiple Revisions**

```
Show outline version history for "The Accord"
```

---

## Full Regression (All 108 tests)

Run all R01–R93 chat tests, then V01–V32 voice tests, in order. Each test in Parts 1 and 2 includes its exact prompt.

---

# PART 4: CHANGE LOG REFERENCE

### Outline Management (2026-03-14)
| Change | Description |
|--------|-------------|
| Retrieve Content (DQS2zIhVjyuxabcb) | `list_outlines` operation — returns all writing projects with non-null outlines |
| Retrieve Content (DQS2zIhVjyuxabcb) | `outline_versions` operation — returns version history for a project's outline from `outline_versions` table |
| Retrieve Content (DQS2zIhVjyuxabcb) | `revert_outline` operation — restores a previous outline version, snapshots current before reverting |
| Retrieve Content (DQS2zIhVjyuxabcb) | `const self = this` renamed to `const httpSelf = this` — fixes strict mode initialization error |
| Retrieve Content (DQS2zIhVjyuxabcb) | Stop words expanded: "outline", "outlines", "list", "show" added |
| Brainstorm Story (StwejB5GLFE26hmU) | Revision mode — loads current characters/chapters from DB, injects PRESERVE EXISTING CHARACTERS rule |
| Brainstorm Story (StwejB5GLFE26hmU) | `save_outline` node snapshots previous outline to `outline_versions` before overwriting |
| `outline_versions` Supabase table | Stores version snapshots with project reference, version number, outline JSON, snapshot timestamp |
| Metaphysical Romance genre | New genre added (slug: `metaphysical-romance`) — soulmates, past lives, reincarnation, grief, caregiving |
| Regression tests R82–R93 | 12 new tests covering list_outlines, outline_versions, revert_outline, edge cases |

### Prologue & Epilogue Support (2026-03-13)
| Change | Description |
|--------|-------------|
| Brainstorm Story (StwejB5GLFE26hmU) | `build_outline_prompt` now instructs Claude to optionally include Prologue (number: 0) and/or Epilogue (number: N+1) when the story arc calls for it |
| Write Chapter (tpj55Sf66jrBPNT8) | `build_chapter_prompt` detects Prologue/Epilogue via regex, adjusts writing instructions (stage-setting vs closure), word count (1500-3000), labels, filenames, email subjects |
| Write Chapter — story bible | `update_story_bible` handles non-numeric chapters (Prologue=0, Epilogue=999), skips `chapter_count` update for prologue/epilogue |
| Write Chapter — insert_draft | Title and chapter_number handle Prologue/Epilogue labels correctly |
| Hub (RcHfwiB7uM2vFfJ3) | System prompt adds "Prologue and Epilogue" section, single-task rules include prologue/epilogue detection, write_chapter tool description updated |

### Story Structure Guidelines (2026-03-12)
| Change | Description |
|--------|-------------|
| `story_structure_guidelines` added to `app_config` | 10 structural guidelines (5-stage arc, Hero's Journey, Three-Act, Seven-Point, 10-beat outline, character roles, Fichtean Curve, character transformation) stored as key/value in Supabase |
| Brainstorm Story (StwejB5GLFE26hmU) | `settings` node fetches `story_structure_guidelines`; `build_outline_prompt` injects as `## Story Structure Guidelines` section; Claude selects and applies structural model per story type |
| Write Short Story (LTZ63B2H0w8Sl4FW) | `settings` node fetches guidelines; `build_story_prompt` injects after Writing Prime Directive; Claude applies 5-stage arc and character transformation requirement |
| Write Chapter (tpj55Sf66jrBPNT8) | `settings` node fetches guidelines; `build_chapter_prompt` injects between Writing Prime Directive and Writing Style Reference |
| `json[0]` bug fix (write_blog_post, write_newsletter) | `$('get_genre_config').first().json[0]?.genre_name` → `json.genre_name` (HTTP nodes spread arrays into items; `[0]` indexing returns undefined) |

### Bug Fixes in This Release
| Fix | Workflows Affected |
|-----|--------------------|
| `numberOfOutputs: 4` missing on Code node → rewrote to single-output pattern | Sub - Manage Research Reports (MLjncwcdMSjBkS4Z) |
| `alwaysOutputData: true` + optional chaining for empty Content Ingestion | Write Blog Post, Write Newsletter, Write Short Story |
| `fields` → `workflowInputs` (resourceMapper format) | Hub tools: manage_library, brainstorm_story + 4 cover art callers |
| Cover art genre guidelines added for 3 new genres | Generate Cover Art (SxeLHxzvITEKyKc0) |
| Newsletter rewritten to use Perplexity instead of Claude (preserves citation URLs) | Write Newsletter (cjIUEjrqvyGZyKwN) |
| Write Short Story sequential flow fix (style_analysis race condition) | Write Short Story (LTZ63B2H0w8Sl4FW) |
| Eve voice latency: turn_eagerness=eager, optimize_streaming_latency=4 | ElevenLabs Agent (Eve) |

### Centralized Email (2026-03-10)
| Change | Description |
|--------|-------------|
| `app_config` Supabase table | Stores `recipient_email` and `bcc_email` as key/value rows |
| Hub `hub_settings` → Code node | Reads from app_config, merges with trigger data, falls back to defaults |
| Cron `settings` → Code node | Reads from app_config for standalone email delivery |
| All hub tool workflows | Reference `$('hub_settings').first().json.recipient_email` (no hardcoded emails) |
| Sub-workflows | Receive email via trigger params from hub (which reads from app_config) |

### Writing Prime Directive (2026-03-10)
| Workflow | Node Modified |
|----------|---------------|
| Write Blog Post (iMBIWzO2PjsLNH9w) | `build_prompt` Set node |
| Write Newsletter (cjIUEjrqvyGZyKwN) | `build_newsletter_prompt` Set node |
| Write Short Story (LTZ63B2H0w8Sl4FW) | `build_story_prompt` Code node |
| Write Chapter (tpj55Sf66jrBPNT8) | `build_chapter_prompt` Code node |
| Repurpose Social (95z13RGuzJDHVNSw) | `build_prompt` Set node |
| Brainstorm Story (StwejB5GLFE26hmU) | `build_outline_prompt` Code node |

### Eve Voice Agent Updates
| Change | Description |
|--------|-------------|
| Review Mode added to Eve system prompt | Eve can retrieve content, load into KB, call back for review/brainstorm |
| RETRIEVE AND CALLBACK routing in hub | Hub detects callback language, chains retrieve_content → eve_knowledge_callback |
| KB cleanup logic | Old "Eve Session:" KB docs removed before new ones are injected |
| Outbound call API integration | Eve calls +14435012219 after KB injection completes |

### New Workflows
| Workflow | ID |
|----------|----|
| Sub - Manage Library | 1JERh5yJ3yDJka8s |
| Tool - Brainstorm Story | StwejB5GLFE26hmU |
| Sub - Retrieve Content | DQS2zIhVjyuxabcb |
| Sub - Eve Knowledge Callback | PaFJlsxWq4BKt0iq |
| 17 Cron: Scheduled Publisher | AtMuc7ZsL28LfU1b |

### Modified Workflows
| Workflow | Changes |
|----------|---------|
| Hub (RcHfwiB7uM2vFfJ3) | Added manage_library + brainstorm_story + retrieve_content + eve_knowledge_callback tools, updated system prompt for 6 genres + Eve Knowledge Flow routing, hub_settings changed from Set to Code node (reads app_config) |
| Generate Cover Art (SxeLHxzvITEKyKc0) | Added art guidelines for ai-marketing, political-history, ancient-history |
| Write Short Story (LTZ63B2H0w8Sl4FW) | Added insert_draft, fixed cover art workflowInputs, added content fallback, Writing Prime Directive |
| Write Blog Post (iMBIWzO2PjsLNH9w) | Added insert_draft, fixed cover art workflowInputs, added content fallback, Writing Prime Directive |
| Write Newsletter (cjIUEjrqvyGZyKwN) | Added insert_draft, added content fallback, Writing Prime Directive |
| Write Chapter (tpj55Sf66jrBPNT8) | Added insert_draft, auto-load outline from writing_projects, fixed cover art workflowInputs, Writing Prime Directive |
| Repurpose Social (95z13RGuzJDHVNSw) | Fixed cover art workflowInputs, Writing Prime Directive |
| Brainstorm Story (StwejB5GLFE26hmU) | Writing Prime Directive |
| Manage Research Reports (MLjncwcdMSjBkS4Z) | Rewrote from 4-output Code router to single-output handler |
| Cron Scheduled Publisher (AtMuc7ZsL28LfU1b) | settings changed from Set to Code node (reads app_config) |

### Supabase Changes
| Change | Type |
|--------|------|
| 3 new genre_config rows (ai-marketing, political-history, ancient-history) | DML (INSERT) |
| `published_content` table + indexes + RLS | DDL (CREATE TABLE) |
| `content_versions` table | DDL (CREATE TABLE) |
| `writing_projects.outline` JSONB column | DDL (ALTER TABLE) |
| `research_reports` table (if not already present) | DDL (CREATE TABLE) |
| `app_config` table (key/value for centralized settings) | DDL (CREATE TABLE) |
| `app_config` rows: `recipient_email`, `bcc_email` | DML (INSERT) |
