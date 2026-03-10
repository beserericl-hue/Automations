# The Author Agent — Full Regression Test Suite

> **Purpose:** Complete regression testing after the 2026-03-08/09/10 feature releases. Tests every tool, every genre, content library, brainstorm, voice commands, centralized email, writing prime directive, and edge cases.
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

# PART 3: RECOMMENDED TEST ORDER

## Smoke Test (Fastest — 12 tests, covers all critical paths)

1. **R01** — Deep research works
2. **R05** — Centralized email config
3. **R06** — Blog post (original genre, full pipeline + prime directive)
4. **R14** — Blog post (new genre, content fallback)
5. **R20** — List drafts (library works)
6. **R22** — Approve draft
7. **R30** — Brainstorm story
8. **R31** — Write chapter from stored outline
9. **R42** — Cron auto-publish (centralized email)
10. **R43** — Writing Prime Directive verification
11. **V04** — Voice blog post
12. **V26** — Retrieve & callback (review mode — full Eve KB + outbound call pipeline)

## Medium Regression (30 tests, all tools + new features)

1. R01–R05 (infrastructure + centralized email)
2. R06, R08 (blog + short story, original genres)
3. R09, R10, R13 (cover art + social twitter + social instagram)
4. R14, R15, R16 (new genres — one each type)
5. R20–R24 (content library full lifecycle)
6. R26–R27 (scheduling)
7. R30–R32 (brainstorm → chapter → story bible)
8. R33 (research reports list)
9. R42 (cron auto-publish)
10. R43, R45 (prime directive: blog + story)
11. V04, V06, V11 (voice: blog, story, brainstorm)
12. V24, V26, V27 (retrieve content + Eve callback in both modes)
13. V30 (content not found edge case)
14. V32 (voice centralized email)

## Full Regression (All 80 tests)

Run all R01–R48 chat tests, then V01–V32 voice tests, in order.

---

# PART 4: CHANGE LOG REFERENCE

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
