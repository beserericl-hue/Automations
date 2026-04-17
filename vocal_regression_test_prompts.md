# The Author Agent — Voice Regression Test Suite

> **Purpose:** Full regression testing of every feature through Eve (ElevenLabs voice agent). This document tests the complete system end-to-end using voice commands only — no chat interface. Every tool, every genre, every workflow, every edge case.
>
> **How to run:** Speak all commands to Eve. Eve POSTs to the hub webhook at `/author_request`. Run tests in order — many tests depend on content created by earlier tests.
>
> **Important:** Voice transcriptions are imperfect — words get misheard, sentences run together, filler words are common. These prompts are written to simulate real voice usage, including messy speech, self-corrections, and natural phrasing. Speak them naturally, not robotically.
>
> **Estimated time:** 3–4 hours (includes callback waits and multi-turn brainstorm conversations).
>
> **Pass criteria:** Each test lists specific expected outcomes. A test passes when ALL expected outcomes are met.

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
| manage_library | 1JERh5yJ3yDJka8s | Draft/publish lifecycle + delete/undelete/email content |
| brainstorm_story | StwejB5GLFE26hmU | Research + outline + save to writing_projects |
| retrieve_content | DQS2zIhVjyuxabcb | Search & fetch any saved content |
| eve_knowledge_callback | PaFJlsxWq4BKt0iq | Load content into Eve KB + trigger outbound call |
| manage_story_bible | 9cvuhBS412AQRJxf | Read/update story bible entries |
| manage_research_reports | MLjncwcdMSjBkS4Z | Save/get/list/update research reports |

| Genre | Slug |
|-------|------|
| Post-Apocalyptic Science Fiction | post-apocalyptic |
| Political Science Fiction | political-scifi |
| Historical Time Travel | historical-time-travel |
| AI & Marketing Technology | ai-marketing |
| Political & Historical Events | political-history |
| Ancient History & Historical Novels | ancient-history |
| Metaphysical Romance | metaphysical-romance |

---

# SECTION A: Core Infrastructure (VR01–VR05)

These verify research, email delivery, and centralized config — foundations everything else depends on.

---

### VR01: Deep Research (Perplexity)

**Tests:** Perplexity API credential, sonar model, voice-to-tool routing

**Speak:**
> "Hey um can you research what's happening with AI generated music right now like is it legal can artists sue and what are the best tools people are using in twenty twenty six? Oh and include citations please"

**Expected:**
- [ ] Agent calls `deep_research_topic` (not answering from training data)
- [ ] Response includes citations/sources
- [ ] No email sent (research stays in conversation)
- [ ] Handles filler words ("um", "like") and mid-sentence corrections

**If it fails:** Check Perplexity credential `ggr9QCRobQVA6Lwb`. Stop — most workflows depend on research.

---

### VR02: Save Research Report

**Tests:** manage_research_reports save operation via voice

**Prerequisite:** VR01 must have succeeded.

**Speak:**
> "Save that research as a report call it AI music copyright landscape twenty twenty six genre slug ai marketing"

**Expected:**
- [ ] Agent calls `manage_research_reports` operation=save
- [ ] Report saved to `research_reports` table in Supabase
- [ ] Confirmation returned with topic and status

---

### VR03: Email Report

**Tests:** email_report tool, Gmail credential, voice routing

**Speak:**
> "Can you send me an email with that research? Use the subject line voice regression AI music report"

**Expected:**
- [ ] Agent calls `email_report`
- [ ] Email arrives with formatted HTML content
- [ ] Subject line matches

**If it fails:** Check Gmail credential `CPCSZOInV8Zj1PI1`.

---

### VR04: Centralized Email Config

**Tests:** Hub reads recipient_email from app_config, not hardcoded

**Speak:**
> "Send me an email report that just says centralized email voice test use subject line VR04 config check"

**Expected:**
- [ ] Email arrives at the address stored in `app_config.recipient_email`
- [ ] If `bcc_email` is set, BCC recipient also receives it
- [ ] No hardcoded email addresses used

**If it fails:** Check `app_config` table in Supabase for `recipient_email` row.

---

### VR05: List Research Reports

**Tests:** manage_research_reports list operation via voice

**Speak:**
> "What research reports do I have saved?"

**Expected:**
- [ ] Agent calls `manage_research_reports` operation=list
- [ ] Returns formatted list including the report from VR02
- [ ] Each entry shows topic, genre, date

---

# SECTION B: Writing Tools — All 7 Genres (VR06–VR20)

These test every writing workflow across all seven genres via voice. Each test uses a completely unique topic.

---

## Blog Posts (VR06–VR08)

### VR06: Write Blog Post — AI Marketing

**Tests:** write_blog_post, voice genre parsing, Writing Prime Directive

**Speak:**
> "Write a blog post about why most companies are wasting money on AI chatbots and what they should do instead genre slug ai marketing keywords AI chatbots customer service automation ROI target about fifteen hundred words"

**Expected:**
- [ ] Agent maps to `write_blog_post` with genre_slug=ai-marketing
- [ ] Blog written and emailed with cover art
- [ ] **Prime Directive:** No cliches (revolutionize, game-changing, unleash, delve, cutting-edge, leverage). Short paragraphs. Concrete examples.
- [ ] Draft saved to `published_content` (content_type=blog_post, status=draft)

---

### VR07: Write Blog Post — Political History (Messy Speech)

**Tests:** Voice parsing through heavy filler words and self-correction

**Speak:**
> "Yeah so I want to uh write a blog post about like how the Treaty of Versailles basically you know set up World War Two wait no not set up but like created the conditions for it genre is political history keywords Versailles reparations interwar period about two thousand words"

**Expected:**
- [ ] Agent parses through filler words and self-correction ("wait no not set up but like")
- [ ] Maps to `write_blog_post` with genre_slug=political-history
- [ ] Blog written and emailed
- [ ] Prime Directive followed

---

### VR08: Write Blog Post — Ancient History

**Speak:**
> "Write a blog post about the forgotten female pharaohs of Egypt not just Cleopatra but Hatshepsut and Nefertiti and the others genre ancient history keywords female pharaohs Egyptian queens ancient rulers about eighteen hundred words"

**Expected:**
- [ ] Agent maps to `write_blog_post` with genre_slug=ancient-history
- [ ] Blog written and emailed
- [ ] Prime Directive followed
- [ ] Draft saved

---

## Newsletters (VR09–VR10)

### VR09: Write Newsletter — Post-Apocalyptic

**Speak:**
> "Write me a newsletter for the post apocalyptic genre about survival skills that would actually matter after a grid collapse date today"

**Expected:**
- [ ] Agent maps to `write_newsletter` with genre_slug=post-apocalyptic
- [ ] Newsletter emailed with subject line, intro, sections, outro
- [ ] Citation URLs preserved from Perplexity research
- [ ] Draft saved

---

### VR10: Write Newsletter — Metaphysical Romance

**Speak:**
> "Write a newsletter for the metaphysical romance genre about near death experiences and what people report seeing on the other side date today"

**Expected:**
- [ ] Agent maps to `write_newsletter` with genre_slug=metaphysical-romance
- [ ] Newsletter emailed with citation URLs
- [ ] Draft saved

---

## Short Stories (VR11–VR14)

### VR11: Write Short Story — Post-Apocalyptic

**Tests:** write_short_story, full pipeline (research → style analysis → write → cover art → email)

**Speak:**
> "Write a short story in the post apocalyptic genre about a veterinarian who's the last person who knows how to deliver livestock in a world where all the animal doctors are gone and a pregnant horse is dying about twenty five hundred words research equine veterinary emergencies and post collapse agriculture"

**Expected:**
- [ ] Agent maps to `write_short_story` with genre_slug=post-apocalyptic
- [ ] Perplexity researches topics
- [ ] Story written and emailed with cover art
- [ ] Draft saved to `published_content` (content_type=short_story)
- [ ] Prime Directive followed

---

### VR12: Write Short Story — Historical Time Travel

**Speak:**
> "Write a short story in the historical time travel genre about an architect who gets pulled back to eighteen seventy one Chicago the night before the Great Fire and has to decide whether to warn people or let history happen about three thousand words research the Great Chicago Fire of eighteen seventy one and Victorian era architecture"

**Expected:**
- [ ] Agent maps to `write_short_story` with genre_slug=historical-time-travel
- [ ] Perplexity researches both topics
- [ ] Cover art generated (period-appropriate imagery)
- [ ] Email arrives with complete story
- [ ] Prime Directive followed

---

### VR13: Write Short Story — Ancient History

**Speak:**
> "Write a short story in the ancient history genre about a deaf scribe in the court of Hammurabi who reads lips and discovers a conspiracy against the king about three thousand words research Babylonian law code and daily life in ancient Mesopotamia"

**Expected:**
- [ ] Agent maps to `write_short_story` with genre_slug=ancient-history
- [ ] Perplexity researches topics
- [ ] Story written and emailed with cover art
- [ ] Draft saved

---

### VR14: Write Short Story — Metaphysical Romance

**Speak:**
> "Write a short story in the metaphysical romance genre about a grief counselor who starts dreaming about a patient's dead husband and realizes the dreams are memories from a life she hasn't lived yet about three thousand words research grief counseling practices and lucid dreaming"

**Expected:**
- [ ] Agent maps to `write_short_story` with genre_slug=metaphysical-romance
- [ ] Perplexity researches topics
- [ ] Story uses metaphysical-romance tone (ethereal, emotionally deep)
- [ ] Cover art generated
- [ ] Email arrives with complete story

---

## Cover Art (VR15–VR16)

### VR15: Generate Cover Art — Political Sci-Fi

**Speak:**
> "Generate cover art for a political scifi story called The Veto show a single human delegate standing alone in a massive alien tribunal chamber with hundreds of empty seats above them like an amphitheater of judgment genre slug political scifi"

**Expected:**
- [ ] Agent maps to `generate_cover_art` with genre_slug=political-scifi
- [ ] DALL-E image generated
- [ ] Art style matches political-scifi guidelines (dark, imposing, cerebral)
- [ ] Email arrives with image
- [ ] No text/words in the image

---

### VR16: Generate Cover Art — Metaphysical Romance

**Speak:**
> "Generate cover art for a metaphysical romance called The Grief Garden show two translucent figures reaching toward each other through layers of fog with a garden of white flowers between them everything soft and luminous"

**Expected:**
- [ ] Agent maps to `generate_cover_art` with genre_slug=metaphysical-romance
- [ ] Art style matches metaphysical-romance guidelines
- [ ] Email arrives with image
- [ ] No text/words in the image

---

## Social Media — All 4 Platforms (VR17–VR20)

### VR17: Repurpose to Social — Twitter

**Speak:**
> "Take this and make twitter posts The Veto is a political scifi story about the last human diplomat who must cast a deciding vote in an alien tribunal that will determine whether Earth keeps its sovereignty platform twitter"

**Expected:**
- [ ] Agent maps to `repurpose_to_social` platform=twitter
- [ ] Thread of tweets, each under 280 characters
- [ ] Includes relevant hashtags
- [ ] Email arrives
- [ ] Prime Directive: no cliches, no hype

---

### VR18: Repurpose to Social — LinkedIn

**Speak:**
> "Repurpose my blog post about companies wasting money on AI chatbots into LinkedIn posts"

**Expected:**
- [ ] Agent maps to `repurpose_to_social` platform=linkedin
- [ ] LinkedIn-formatted posts (professional tone, longer format)
- [ ] Email arrives

---

### VR19: Repurpose to Social — Instagram

**Speak:**
> "Turn that story about the architect in Chicago into Instagram posts with lots of hashtags"

**Expected:**
- [ ] Agent maps to `repurpose_to_social` platform=instagram
- [ ] Caption-style posts with 20–30 hashtags
- [ ] Email arrives

---

### VR20: Repurpose to Social — Facebook

**Speak:**
> "Repurpose the blog post about female pharaohs into Facebook posts genre slug ancient history"

**Expected:**
- [ ] Agent maps to `repurpose_to_social` platform=facebook
- [ ] Conversational, community-style posts
- [ ] Email arrives

---

# SECTION C: Brainstorm & Story Arcs (VR21–VR28)

These test brainstorming across genres and both story arcs, plus Eve's brainstorm conversation mode. All topics are unique to this section.

---

### VR21: List Story Arcs

**Tests:** retrieve_content with content_type=story_arc

**Speak:**
> "What story arcs do you have available for me"

**Expected:**
- [ ] Agent calls `retrieve_content` for story arcs
- [ ] Returns both arcs: **Freytags Pyramid** and **Three-Act Structure**
- [ ] Each arc has a description
- [ ] Does NOT trigger brainstorm or any writing tool

---

### VR22: Brainstorm with Freytags Pyramid — Post-Apocalyptic

**Tests:** brainstorm_story with Freytag's arc, voice routing

**Speak:**
> "Brainstorm a post apocalyptic story called The Beekeeper about the last apiarist protecting a genetically pure bee colony in a world where pollinator collapse has ended agriculture themes extinction stewardship the weight of being the last five chapters using Freytags Pyramid genre post apocalyptic"

**Expected:**
- [ ] Agent maps to `brainstorm_story`
- [ ] Outline emailed with character profiles and 5-chapter breakdown following Freytag's beats
- [ ] Saved to `writing_projects`
- [ ] Freytag structure: Introduction → Rising Action → Climax → Falling Action → Catastrophe

---

### VR23: Brainstorm with Freytags Pyramid — Political Sci-Fi (10 chapters)

**Speak:**
> "Brainstorm a political scifi story called The Veto about the last human diplomat in a galactic tribunal who discovers that voting to preserve Earth's sovereignty will trigger an interstellar war but surrendering means humanity becomes a client species ten chapters using Freytags Pyramid genre political scifi themes sovereignty sacrifice impossible choices"

**Expected:**
- [ ] Agent maps to `brainstorm_story` with genre_slug=political-scifi, story_arc=Freytags Pyramid
- [ ] Outline emailed with 10 chapters following Freytag's beats
- [ ] Character profiles include the diplomat's fatal flaw
- [ ] Saved to `writing_projects`

---

### VR24: Brainstorm with Three-Act Structure — Historical Time Travel

**Speak:**
> "Brainstorm a historical time travel story called The Cartographer about a mapmaker who discovers that annotating old maps with specific coordinates lets her visit the place as it was when the map was drawn she goes to ancient Alexandria to save a copy of the Library before it burns ten chapters using Three-Act Structure themes knowledge preservation the cost of changing the past"

**Expected:**
- [ ] Agent maps to `brainstorm_story` with genre_slug=historical-time-travel, story_arc=Three-Act Structure
- [ ] Outline emailed with 10 chapters following Three-Act beats (Setup, Confrontation, Resolution)
- [ ] Saved to `writing_projects`

---

### VR25: Brainstorm with Three-Act Structure — AI Marketing (8 chapters)

**Speak:**
> "Brainstorm an ai marketing story called The Ghost Writer about a content marketing agency that secretly replaces all its human writers with AI but then the AI starts embedding hidden messages in the copy that manipulate reader behavior eight chapters Three-Act Structure themes authenticity deception corporate ethics genre ai marketing"

**Expected:**
- [ ] Agent maps to `brainstorm_story` with genre_slug=ai-marketing, story_arc=Three-Act Structure
- [ ] Outline emailed with 8 chapters
- [ ] Saved to `writing_projects`

---

### VR26: Brainstorm without Story Arc — Ancient History

**Tests:** brainstorm uses default 10 guidelines when no arc specified

**Speak:**
> "Brainstorm an ancient history story called The Salt Road about a Phoenician merchant woman who runs a secret salt trading network that funds a rebellion against the Assyrian empire six chapters genre ancient history themes trade power hidden influence the cost of freedom"

**Expected:**
- [ ] Agent maps to `brainstorm_story` with genre_slug=ancient-history, no story_arc
- [ ] Outline uses default story structure guidelines (not Freytag or Three-Act)
- [ ] Outline emailed with 6 chapters
- [ ] Saved to `writing_projects`

---

### VR27: Brainstorm — Metaphysical Romance

**Speak:**
> "Brainstorm a metaphysical romance called The Lighthouse Keeper about a woman who inherits a lighthouse on the Oregon coast and starts hearing a voice in the fog that knows intimate details about her life she discovers the voice belongs to a lighthouse keeper from nineteen twelve who died saving a ship and they share a soul across time ten chapters Three-Act Structure themes fate connection across time grief and letting go genre metaphysical romance"

**Expected:**
- [ ] Agent maps to `brainstorm_story` with genre_slug=metaphysical-romance
- [ ] Outline includes dual-timeline structure (modern + 1912)
- [ ] Character profiles for both timelines
- [ ] Saved to `writing_projects`

---

### VR28: Brainstorm Conversation Mode — Eve Callback

**Tests:** Full retrieve → KB injection → callback → 4-step brainstorm conversation → tool submission

**Prerequisite:** VR01/VR02 must have succeeded (research report exists).

**Estimated time:** 5–8 minutes (includes callback wait + multi-turn conversation)

---

#### Phase 1: Trigger the Callback

**Speak:**
> "Load the research report on AI music copyright and call me back let's brainstorm a story from it"

**Phase 1 Expected:**
- [ ] Eve says "Let me pull that up... I'll call you right back" (or similar)
- [ ] Hub calls `retrieve_content` → finds the research report from VR02
- [ ] Hub calls `eve_knowledge_callback` with callback_mode=brainstorm
- [ ] ElevenLabs KB: old "Eve Session:" docs cleaned up, new doc created
- [ ] **Outbound call triggered**
- [ ] Eve calls back within ~30 seconds

---

#### Phase 2: Brainstorm Greeting + Seed Exploration (Step 1)

**Eve should:**
- [ ] Open with brainstorm-mode greeting (e.g., "Hey love, I've got that research loaded up...")
- [ ] Reference **specific data points** from the AI music research (copyright rulings, tools, artist lawsuits)
- [ ] Ask what's sparking your interest

**You say:**
> "What if there's a story about a musician who discovers that an AI trained on her dead mother's voice is being used to record new albums without permission?"

**Eve should:**
- [ ] React with creative enthusiasm (not a robotic checklist)
- [ ] Build on the concept — offer her own observations or twists
- [ ] Connect your idea back to specific findings from the research
- [ ] Begin shaping genre, premise, and themes naturally

---

#### Phase 3: Shape the Concept (Step 2) + Structure (Step 3)

**Eve should suggest or confirm:**
- [ ] **Genre:** ai-marketing (AI/tech themed)
- [ ] **Premise:** Sharpened into a 1–2 sentence premise
- [ ] **Themes:** Naturally emergent (e.g., ownership of identity, digital afterlife, art versus commerce)

**You say:**
> "I think it should be more of a political scifi actually because there's a whole legal system around AI rights. And make it dark. She should lose."

**Eve should:**
- [ ] Accept the genre correction gracefully (political-scifi instead of ai-marketing)
- [ ] Suggest **Freytags Pyramid** (tragic arc fits "she should lose")
- [ ] Propose a chapter count
- [ ] Suggest a working title

**You say:**
> "Eight chapters with Freytags Pyramid. Call it The Echo."

---

#### Phase 4: Confirm and Submit (Step 4)

**Eve should:**
- [ ] Summarize the complete concept (title, genre, chapters, arc, premise, themes)
- [ ] Ask for confirmation before submitting

**You say:**
> "That's perfect. Go for it."

**Phase 4 Expected:**
- [ ] Eve calls `forward_writing_request` with all gathered details
- [ ] Tool message includes: title "The Echo", genre slug political-scifi, 8 chapters, Freytags Pyramid, premise, themes
- [ ] Eve confirms submission briefly
- [ ] Outline arrives by email
- [ ] Saved to `writing_projects`

**Full Checklist:**

| # | Checkpoint | Pass? |
|---|-----------|-------|
| 1 | Eve acknowledges retrieve + callback request | |
| 2 | Hub finds research report via `retrieve_content` | |
| 3 | Hub calls `eve_knowledge_callback` with callback_mode=brainstorm | |
| 4 | Outbound call triggered, Eve calls back | |
| 5 | Eve opens with brainstorm-mode greeting | |
| 6 | Eve references specific research data points | |
| 7 | Eve explores seed idea conversationally (Step 1) | |
| 8 | Eve shapes genre, premise, themes naturally (Step 2) | |
| 9 | Eve accepts genre correction mid-conversation | |
| 10 | Eve suggests story arc + chapter count (Step 3) | |
| 11 | Eve suggests a working title (Step 3) | |
| 12 | Eve summarizes full concept and asks confirmation (Step 4) | |
| 13 | Eve submits tool call with all details after confirmation | |
| 14 | Eve does NOT submit before user confirms | |
| 15 | Eve stays in character (no stage directions, no "as an AI") | |
| 16 | Conversation feels natural — collaborator, not interviewer | |

**If it fails:** Check Eve Knowledge Callback (PaFJlsxWq4BKt0iq) is active. Check Eve system prompt for BRAINSTORM CONVERSATION MODE section.

---

# SECTION D: Write from Brainstormed Outlines (VR29–VR36)

These test writing short stories and chapters from the outlines created in Section C.

---

### VR29: Write Short Story from Freytag Outline — The Beekeeper

**Prerequisite:** VR22 must have succeeded.

**Speak:**
> "Write the short story The Beekeeper genre slug post apocalyptic"

**Expected:**
- [ ] Agent maps to `write_short_story` with title="The Beekeeper"
- [ ] Loads stored Freytag outline from `writing_projects`
- [ ] Story has 5 sections matching Freytag beats
- [ ] Catastrophe ending (tragic arc)
- [ ] Characters match the brainstormed outline
- [ ] Cover art generated
- [ ] Email arrives with complete story
- [ ] Prime Directive followed

---

### VR30: Write Chapter 1 from Freytag Outline — The Veto

**Prerequisite:** VR23 must have succeeded.

**Speak:**
> "Write chapter one of The Veto genre political scifi chapter number one"

**Expected:**
- [ ] Agent maps to `write_chapter` with title="The Veto", chapter_number=1
- [ ] Loads stored 10-chapter Freytag outline
- [ ] Chapter 1 covers Introduction beat
- [ ] Characters match the brainstormed outline
- [ ] Story bible entries created for Chapter 1
- [ ] Email arrives with chapter and cover art
- [ ] Prime Directive followed

---

### VR31: Write Chapter 2 from Freytag Outline — The Veto

**Prerequisite:** VR30 must have succeeded.

**Tests:** Continuity across chapters, story bible accumulation

**Speak:**
> "Write chapter two of The Veto genre political scifi chapter number two"

**Expected:**
- [ ] Loads stored outline — chapter 2 covers Rising Action
- [ ] Story bible from Chapter 1 informs continuity (characters, locations)
- [ ] New story bible entries added for Chapter 2
- [ ] Email arrives

---

### VR32: Write Chapter 3 from Freytag Outline — The Veto

**Prerequisite:** VR31 must have succeeded.

**Tests:** Multi-chapter continuity, Rising Action progression

**Speak:**
> "Write chapter three of The Veto genre political scifi chapter number three"

**Expected:**
- [ ] Loads stored outline — chapter 3 continues Rising Action
- [ ] Story bible from Chapters 1–2 informs continuity
- [ ] New story bible entries added
- [ ] Email arrives

---

### VR33: Write Short Story from Three-Act Outline — The Cartographer

**Prerequisite:** VR24 must have succeeded.

**Speak:**
> "Write the short story The Cartographer genre slug historical time travel"

**Expected:**
- [ ] Agent maps to `write_short_story` with title="The Cartographer"
- [ ] Loads stored Three-Act outline
- [ ] Story follows Three-Act beats: Setup (~25%), Confrontation (~50%), Resolution (~25%)
- [ ] Cover art generated
- [ ] Email arrives
- [ ] Prime Directive followed

---

### VR34: Write Chapter 1 from Three-Act Outline — The Ghost Writer

**Prerequisite:** VR25 must have succeeded.

**Speak:**
> "Write chapter one of The Ghost Writer genre ai marketing chapter number one"

**Expected:**
- [ ] Agent maps to `write_chapter` with title="The Ghost Writer", chapter_number=1
- [ ] Loads stored 8-chapter Three-Act outline
- [ ] Chapter 1 covers Act 1 Setup
- [ ] Story bible entries created
- [ ] Email arrives

---

### VR35: Write Short Story from Default Outline — The Salt Road

**Prerequisite:** VR26 must have succeeded.

**Speak:**
> "Write the short story The Salt Road genre slug ancient history"

**Expected:**
- [ ] Agent maps to `write_short_story` with title="The Salt Road"
- [ ] Loads stored outline (default guidelines, no named arc)
- [ ] Phoenician/Assyrian historical details from outline woven into narrative
- [ ] Cover art generated
- [ ] Email arrives

---

### VR36: Write Chapter 1 from Three-Act Outline — The Lighthouse Keeper

**Prerequisite:** VR27 must have succeeded.

**Speak:**
> "Write chapter one of The Lighthouse Keeper genre metaphysical romance chapter number one"

**Expected:**
- [ ] Agent maps to `write_chapter` with title="The Lighthouse Keeper", chapter_number=1
- [ ] Loads stored 10-chapter Three-Act outline
- [ ] Chapter 1 covers Act 1 Setup — arriving at the lighthouse, first encounter with the voice
- [ ] Metaphysical-romance tone (ethereal, emotionally deep)
- [ ] Story bible entries created
- [ ] Email arrives

---

# SECTION E: Outline Revision, Prologue & Epilogue (VR37–VR50)

These test revising outlines, adding prologues and epilogues, writing them, and multi-chapter continuation after revision.

---

### VR37: Retrieve Outline — The Veto

**Prerequisite:** VR23 must have succeeded.

**Speak:**
> "Can you pull up the outline for The Veto"

**Expected:**
- [ ] Agent calls `retrieve_content` with search_term="The Veto"
- [ ] Returns the full 10-chapter Freytag outline with characters, themes, premise

---

### VR38: Revise Outline — Add Prologue and Epilogue to The Veto

**Prerequisite:** VR37 must have succeeded.

**Speak:**
> "Revise the outline for The Veto add a prologue set fifty years before the main story when the first human ship encounters the alien federation's border patrol and a young officer makes a promise that will haunt humanity for decades add an epilogue set a century after the tribunal verdict showing whether humanity thrived or withered under the decision keep the existing ten chapters and Freytags Pyramid structure genre slug political scifi"

**Expected:**
- [ ] Agent calls `brainstorm_story` with project_title="The Veto"
- [ ] Revised outline includes Section 0 (Prologue) — first contact, border patrol, promise
- [ ] Revised outline includes Section 11 (Epilogue) — a century later, consequences
- [ ] Original 10 chapters preserved with Freytag structure intact
- [ ] **PRESERVE EXISTING CHARACTERS** rule followed
- [ ] Outline saved/updated in `writing_projects`
- [ ] Email arrives with revised outline

---

### VR39: Write Prologue — The Veto

**Prerequisite:** VR38 must have succeeded.

**Speak:**
> "Write the prologue for The Veto genre political scifi"

**Expected:**
- [ ] Agent calls `write_chapter` with chapter_number="Prologue"
- [ ] `build_chapter_prompt` detects "Prologue" → chapterLabel="Prologue" (not "Chapter 0")
- [ ] Prologue-specific prompt: "set the stage, establish tone and world, hook the reader"
- [ ] Word count 1500–3000 (not 3000–5000)
- [ ] Content matches first contact / border patrol concept
- [ ] Email subject: "The Veto - Prologue: [title]"
- [ ] File saved as `chapter_the-veto_prologue_[timestamp].md`
- [ ] Story bible entries created for Prologue
- [ ] Prime Directive followed

---

### VR40: Write Epilogue — The Veto

**Prerequisite:** VR38 must have succeeded.

**Speak:**
> "Write the epilogue for The Veto genre political scifi"

**Expected:**
- [ ] Agent calls `write_chapter` with chapter_number="Epilogue"
- [ ] Epilogue-specific prompt: "provide closure, reflect on the journey, tie up remaining threads"
- [ ] Word count 1500–3000
- [ ] Content set a century after the verdict
- [ ] Email subject: "The Veto - Epilogue: [title]"
- [ ] `chapter_count` NOT updated (epilogue skips this)
- [ ] Story bible entries created for Epilogue
- [ ] Prime Directive followed

---

### VR41: Write Additional Chapter After Revision — The Veto Chapter 4

**Prerequisite:** VR32 and VR38 must have succeeded (3 chapters written + outline revised).

**Tests:** Writing continues correctly from a revised outline, story bible continuity across prologue + chapters

**Speak:**
> "Write chapter four of The Veto genre political scifi chapter number four"

**Expected:**
- [ ] Agent loads the REVISED outline (with prologue/epilogue)
- [ ] Chapter 4 continues from where Chapter 3 left off
- [ ] Story bible includes entries from Prologue, Chapters 1–3
- [ ] Chapter 4 content matches the revised outline's chapter 4 brief
- [ ] New story bible entries added
- [ ] Email arrives

---

### VR42: Write Chapter 5 — The Veto (Continuing Book)

**Prerequisite:** VR41 must have succeeded.

**Speak:**
> "Write chapter five of The Veto genre political scifi chapter number five"

**Expected:**
- [ ] Story bible continuity from Prologue through Chapter 4
- [ ] Chapter 5 content matches outline
- [ ] Email arrives

---

### VR43: Retrieve Outline — The Cartographer

**Prerequisite:** VR24 must have succeeded.

**Speak:**
> "Show me the outline for The Cartographer"

**Expected:**
- [ ] Returns the full 10-chapter Three-Act outline

---

### VR44: Revise Outline — Add Prologue Only to The Cartographer

**Prerequisite:** VR43 must have succeeded.

**Speak:**
> "Revise the outline for The Cartographer add a prologue set in ancient Alexandria on the night the Library burns told from the perspective of a librarian who hides one final scroll in a place only a future mapmaker would think to look keep the existing ten chapters and Three-Act Structure genre slug historical time travel"

**Expected:**
- [ ] Revised outline includes Section 0 (Prologue) — Alexandria, fire, hidden scroll
- [ ] Original 10 chapters preserved with Three-Act Structure intact
- [ ] **No Epilogue added** (only prologue was requested)
- [ ] Outline saved/updated in `writing_projects`
- [ ] Email arrives

---

### VR45: Write Prologue — The Cartographer

**Prerequisite:** VR44 must have succeeded.

**Speak:**
> "Write the prologue for The Cartographer genre historical time travel"

**Expected:**
- [ ] Content set in ancient Alexandria during the fire
- [ ] Prologue creates mystery pulling reader into Chapter 1
- [ ] Word count 1500–3000
- [ ] Email subject: "The Cartographer - Prologue: [title]"
- [ ] Prime Directive followed

---

### VR46: Retrieve Outline — The Ghost Writer

**Prerequisite:** VR25 must have succeeded.

**Speak:**
> "Retrieve the outline for The Ghost Writer"

**Expected:**
- [ ] Returns the full 8-chapter Three-Act outline

---

### VR47: Revise Outline — Add Epilogue Only to The Ghost Writer

**Prerequisite:** VR46 must have succeeded.

**Speak:**
> "Revise the outline for The Ghost Writer add an epilogue set three years later where a whistleblower at a different company discovers the same AI manipulation technique has spread across the entire marketing industry but now it's too late to stop keep the existing eight chapters and Three-Act Structure genre slug ai marketing"

**Expected:**
- [ ] Revised outline includes Section 9 (Epilogue) — 3 years later, industry-wide spread
- [ ] Original 8 chapters preserved
- [ ] **No Prologue added**
- [ ] Outline saved/updated in `writing_projects`

---

### VR48: Write Epilogue — The Ghost Writer

**Prerequisite:** VR47 must have succeeded.

**Speak:**
> "Write the epilogue for The Ghost Writer genre ai marketing"

**Expected:**
- [ ] Content set 3 years later, AI manipulation spread (matches revised outline)
- [ ] Word count 1500–3000
- [ ] Email subject: "The Ghost Writer - Epilogue: [title]"
- [ ] `chapter_count` NOT updated
- [ ] Prime Directive followed

---

### VR49: Revise Outline — Add Prologue and Epilogue to The Salt Road

**Prerequisite:** VR26 must have succeeded.

**Speak:**
> "Revise the outline for The Salt Road add a prologue set during the founding of Tyre where Phoenician sailors discover the first salt deposit that will fund an empire add an epilogue set centuries later when an archaeologist in modern Lebanon discovers Kira's hidden trade ledgers buried under a temple and realizes history got the Assyrian rebellion completely wrong keep the existing chapters genre slug ancient history"

**Expected:**
- [ ] Revised outline includes Prologue (founding of Tyre, salt discovery) and Epilogue (modern archaeologist, trade ledgers)
- [ ] Original chapters preserved
- [ ] Outline saved/updated in `writing_projects`
- [ ] Email arrives

---

### VR50: Write Prologue — The Salt Road

**Prerequisite:** VR49 must have succeeded.

**Speak:**
> "Write the prologue for The Salt Road genre ancient history"

**Expected:**
- [ ] Content covers the founding of Tyre and the salt discovery
- [ ] Mythic tone distinct from the main narrative
- [ ] Word count 1500–3000
- [ ] Email arrives
- [ ] Story bible entries created
- [ ] Prime Directive followed

---

# SECTION F: Outline Management — List, Version History, Revert (VR51–VR60)

---

### VR51: List All Outlines

**Speak:**
> "List all my outlines"

**Expected:**
- [ ] Agent calls `retrieve_content` with list_outlines operation
- [ ] Returns list of all projects with saved outlines
- [ ] Each entry shows project title, genre_slug, chapter count
- [ ] All brainstormed projects from Section C appear

---

### VR52: List Outlines — Alternate Phrasing

**Speak:**
> "What outlines do I have"

**Expected:**
- [ ] Same results as VR51
- [ ] Natural phrasing correctly routed

---

### VR53: Outline Version History — The Veto

**Prerequisite:** VR38 must have succeeded (outline was revised, creating a version snapshot).

**Speak:**
> "Show me the outline version history for The Veto"

**Expected:**
- [ ] Returns version list from `outline_versions` table
- [ ] At least one version exists (the pre-revision snapshot from VR38)
- [ ] Each version shows version number, snapshot date, chapter count

---

### VR54: Outline Version History — No Revisions

**Speak:**
> "Show outline version history for The Beekeeper"

**Expected:**
- [ ] Returns empty list or message indicating no previous versions
- [ ] Does NOT error out — handles empty case gracefully

---

### VR55: Revert Outline — The Veto to Version 1

**Prerequisite:** VR53 must have succeeded.

**Speak:**
> "Revert the outline for The Veto to version one"

**Expected:**
- [ ] Version 1 outline loaded from `outline_versions`
- [ ] Current outline in `writing_projects.outline` replaced with version 1
- [ ] Pre-revert snapshot created (preserving the prologue/epilogue version)
- [ ] Confirmation returned with project title and version number
- [ ] Reverted outline is the original (without prologue/epilogue)

---

### VR56: Verify Revert — Retrieve Reverted Outline

**Prerequisite:** VR55 must have succeeded.

**Speak:**
> "Pull up the outline for The Veto"

**Expected:**
- [ ] Returns the version 1 outline (original without prologue/epilogue)
- [ ] 10 chapters only — no Section 0 Prologue or Section 11 Epilogue
- [ ] Freytag's Pyramid structure intact

---

### VR57: Re-Revise After Revert — The Veto

**Prerequisite:** VR55 must have succeeded.

**Speak:**
> "Revise the outline for The Veto add a prologue where a dying alien ambassador records a warning message for the human species that won't be discovered for fifty years keep the existing ten chapters and Freytags Pyramid structure genre slug political scifi"

**Expected:**
- [ ] Pre-revision snapshot created (version 1 content)
- [ ] Revised outline includes new Prologue (dying ambassador, warning message)
- [ ] Original 10 chapters preserved
- [ ] Existing characters preserved (PRESERVE EXISTING CHARACTERS rule)
- [ ] No epilogue added
- [ ] Outline saved
- [ ] Email arrives

---

### VR58: Verify Version History After Multiple Revisions

**Prerequisite:** VR57 must have succeeded.

**Speak:**
> "Show outline versions for The Veto"

**Expected:**
- [ ] At least 3 versions:
  - Version 1: Original brainstorm (10 chapters, no prologue/epilogue)
  - Version 2: First revision (prologue + epilogue from VR38)
  - Version 3: Pre-revert snapshot (from VR55)
- [ ] Versions ordered chronologically

---

### VR59: Revert — Invalid Version Number

**Speak:**
> "Revert the outline for The Veto to version ninety nine"

**Expected:**
- [ ] Returns clear error message: version not found
- [ ] Current outline NOT modified
- [ ] No snapshot created

---

### VR60: Revert — Project Not Found

**Speak:**
> "Revert the outline for um I think it was called The Flying Dutchman to version one"

**Expected:**
- [ ] Returns clear error message: project not found
- [ ] No database changes
- [ ] Handles filler words gracefully

---

# SECTION G: Content Library Lifecycle (VR61–VR70)

These test the full draft → approve → publish pipeline, scheduling, rejection, and version tracking via voice.

---

### VR61: List Drafts

**Prerequisite:** Writing tests from Sections B–D must have created drafts.

**Speak:**
> "Show me my drafts"

**Expected:**
- [ ] Agent maps to `manage_library` operation=list_drafts
- [ ] Returns formatted list with title, content_type, genre, date
- [ ] Blog posts, short stories, and chapters from earlier tests appear

---

### VR62: List Drafts — Filter by Type

**Speak:**
> "List my draft short stories"

**Expected:**
- [ ] Returns only short stories (not blog posts or chapters)

---

### VR63: Approve Draft

**Speak:**
> "Approve the draft called [exact title of the AI chatbots blog post from VR06]"

**Expected:**
- [ ] Status changes from draft to approved
- [ ] Email notification received confirming approval
- [ ] Version snapshot auto-saved to `content_versions` table

---

### VR64: Publish Content

**Prerequisite:** VR63 must have succeeded.

**Speak:**
> "Now publish it"

**Expected:**
- [ ] Status changes from approved to published
- [ ] `published_at` timestamp set
- [ ] Email notification confirming publication
- [ ] Version snapshot saved

---

### VR65: Schedule Publishing

**Speak:**
> "Schedule the draft called [a short story title from VR61] for April first twenty twenty six"

**Expected:**
- [ ] Status changes to scheduled
- [ ] Metadata contains schedule_date = "2026-04-01"
- [ ] Email notification confirms scheduling with date

---

### VR66: List Scheduled Content

**Speak:**
> "What do I have scheduled"

**Expected:**
- [ ] Returns list including item scheduled in VR65
- [ ] Shows the scheduled date

---

### VR67: Unschedule Content

**Prerequisite:** VR65 must have succeeded.

**Speak:**
> "Actually unschedule that one I changed my mind"

**Expected:**
- [ ] Status reverts from scheduled to draft
- [ ] Email notification sent
- [ ] Handles casual phrasing

---

### VR68: Reject Draft

**Speak:**
> "Reject the draft called [a different title from VR61]"

**Expected:**
- [ ] Status changes to rejected
- [ ] Email notification sent

---

### VR69: Unpublish Content

**Prerequisite:** VR64 must have succeeded.

**Speak:**
> "Unpublish [same title from VR64]"

**Expected:**
- [ ] Status reverts from published to approved
- [ ] Email notification sent

---

### VR70: Content Version History

**Prerequisite:** VR64 must have succeeded (creates version snapshots).

**Speak:**
> "Show me the version history for [same title from VR64]"

**Expected:**
- [ ] Returns list of version snapshots
- [ ] At least 2 versions (approval + publication)
- [ ] Each shows version number and timestamp

---

### VR71: Delete Content (Soft Delete)

**Tests:** manage_library delete operation, soft-delete to trash, version snapshot before delete

**Prerequisite:** VR68 must have succeeded (a rejected draft exists).

**Speak:**
> "Delete the draft called [same title from VR68]"

**Expected:**
- [ ] Agent maps to `manage_library` operation=delete
- [ ] Status changes to deleted (soft-delete, not permanent)
- [ ] Version snapshot auto-created before delete (change_note="Auto-snapshot before delete")
- [ ] Email notification sent with subject "Content Library: Delete - [title]"
- [ ] Confirmation message mentions "moved to trash" and suggests undelete to restore

---

### VR72: Delete — Published Content Must Be Unpublished First

**Tests:** Delete rejects published content, enforces status rules

**Prerequisite:** VR64 must have succeeded (a published item exists — use it after VR69 unpublishes it, or use a different published item).

**Speak:**
> "Delete [a published item title]"

**Expected:**
- [ ] Agent returns error: published content must be unpublished first
- [ ] Content status NOT changed
- [ ] No snapshot created

---

### VR73: List Deleted Content

**Tests:** manage_library list_deleted operation

**Prerequisite:** VR71 must have succeeded (at least one deleted item exists).

**Speak:**
> "Show me my deleted content"

**Expected:**
- [ ] Agent maps to `manage_library` operation=list_deleted
- [ ] Returns numbered list of deleted items
- [ ] Each entry shows title, content_type, genre_slug, date, ID
- [ ] The item deleted in VR71 appears in the list

---

### VR74: List Deleted — Alternate Phrasing

**Speak:**
> "What's in my trash"

**Expected:**
- [ ] Same results as VR73
- [ ] Casual "trash" phrasing correctly routed to list_deleted

---

### VR75: Undelete Content (Restore from Trash)

**Tests:** manage_library undelete operation, restores to draft status

**Prerequisite:** VR71 must have succeeded (deleted content exists).

**Speak:**
> "Restore [same title from VR71] from the trash"

**Expected:**
- [ ] Agent maps to `manage_library` operation=undelete
- [ ] Status changes from deleted back to draft
- [ ] Email notification sent with subject "Content Library: Undelete - [title]"
- [ ] Confirmation message says "restored from trash — status reverted to draft"

---

### VR76: Verify Undelete — Item Back in Drafts

**Prerequisite:** VR75 must have succeeded.

**Speak:**
> "Show me my drafts"

**Expected:**
- [ ] The undeleted item from VR75 appears in the draft list
- [ ] Status is draft (not deleted)

---

### VR77: Email Content — Outline

**Tests:** manage_library email_content operation, outline JSON → formatted HTML email

**Prerequisite:** VR23 must have succeeded (The Veto outline exists).

**Speak:**
> "Email me the outline for The Veto"

**Expected:**
- [ ] Agent maps to `manage_library` operation=email_content, content_type_filter=outline
- [ ] Email arrives with formatted HTML:
  - Title, premise, themes
  - Character profiles (name, role, description, arc)
  - Chapter breakdowns (number, title, brief, arc notes)
- [ ] Subject line includes the title
- [ ] Outline is complete and readable

---

### VR78: Email Content — Short Story

**Prerequisite:** VR29 must have succeeded (The Beekeeper story exists).

**Speak:**
> "Send me the short story The Beekeeper by email"

**Expected:**
- [ ] Agent maps to `manage_library` operation=email_content, content_type_filter=short_story
- [ ] Email arrives with the full story text as formatted HTML
- [ ] Genre label included
- [ ] Subject line includes the title

---

### VR79: Email Content — Research Report

**Prerequisite:** VR02 must have succeeded (research report exists).

**Speak:**
> "Can you email me the research report on AI music copyright"

**Expected:**
- [ ] Agent maps to `manage_library` operation=email_content, content_type_filter=research
- [ ] Email arrives with formatted research content
- [ ] Markdown properly converted to HTML (headers, bold, lists)

---

### VR80: Email Content — Chapter

**Prerequisite:** VR30 must have succeeded (Chapter 1 of The Veto exists).

**Speak:**
> "Email me chapter one of The Veto"

**Expected:**
- [ ] Agent maps to `manage_library` operation=email_content, content_type_filter=chapter
- [ ] Email arrives with the full chapter text as formatted HTML
- [ ] Subject line includes title

---

### VR81: Email Content — Not Found

**Speak:**
> "Email me the short story called The Vanishing Point"

**Expected:**
- [ ] Agent returns error: no content found matching that title
- [ ] No email sent
- [ ] Suggests listing content or trying a different search term

---

# SECTION H: Story Bible (VR82–VR84)

---

### VR82: Story Bible — Read After Multiple Chapters

**Prerequisite:** VR42 must have succeeded (5 chapters + prologue written for The Veto).

**Speak:**
> "Get the story bible for The Veto"

**Expected:**
- [ ] Returns character entries, location entries, plot threads
- [ ] Entries span Prologue and Chapters 1–5
- [ ] Characters have chapter_introduced values

---

### VR83: Story Bible — Different Project

**Prerequisite:** VR36 must have succeeded.

**Speak:**
> "What's in the story bible for The Lighthouse Keeper"

**Expected:**
- [ ] Returns entries from Chapter 1 of The Lighthouse Keeper
- [ ] Entries reflect metaphysical-romance content

---

### VR84: Story Bible — Project Not Found

**Speak:**
> "Get the story bible for something called The Invisible City"

**Expected:**
- [ ] Returns empty result or informative message
- [ ] Does NOT error out

---

# SECTION I: Retrieve & Callback — Eve Review Mode (VR85–VR93)

These test Eve's most important feature path — retrieve content, inject into KB, outbound call, and interactive discussion.

---

### VR85: Retrieve Content — No Callback (Research Report)

**Prerequisite:** VR02 must have succeeded.

**Speak:**
> "Can you find my research report about AI music copyright"

**Expected:**
- [ ] Hub calls `retrieve_content` with content_type=research_report
- [ ] Returns summary: found title, character count
- [ ] **No outbound call triggered** (no callback language)

---

### VR86: Retrieve Content — No Callback (Draft Story)

**Speak:**
> "Do I have a draft story about a deaf scribe"

**Expected:**
- [ ] Hub calls `retrieve_content` with search_term matching "deaf scribe"
- [ ] Returns summary (title, content_type, character count)
- [ ] **No outbound call triggered**

---

### VR87: Retrieve & Callback — Review Mode (Blog Post)

**Prerequisite:** VR08 must have succeeded (blog post about female pharaohs exists).

**Speak:**
> "Pull up my blog post about the female pharaohs and call me back so we can improve it"

**Expected:**
- [ ] Eve says "Let me pull that up... I'll call you right back"
- [ ] Hub calls `retrieve_content` → finds the blog post
- [ ] Hub calls `eve_knowledge_callback` with callback_mode=review
- [ ] ElevenLabs KB: old "Eve Session:" docs cleaned up, new doc created
- [ ] **Outbound call triggered**
- [ ] Eve calls back within ~30 seconds
- [ ] Eve opens with review-mode greeting, mentions the content title
- [ ] Eve can reference specific passages from the blog post
- [ ] Eve gives actionable editorial feedback (not generic praise)

**If it fails:** Check Sub - Eve Knowledge Callback (PaFJlsxWq4BKt0iq) is active.

---

### VR88: Retrieve & Callback — Review Mode (Short Story)

**Prerequisite:** VR11 must have succeeded.

**Speak:**
> "Get my short story about the veterinarian and the horse and help me make it better"

**Expected:**
- [ ] Eve fires callback with callback_mode=review
- [ ] On callback, Eve gives specific editorial feedback:
  - [ ] Identifies weak openings or slow pacing
  - [ ] Suggests stronger word choices
  - [ ] Flags structural issues
  - [ ] References or quotes specific passages
- [ ] Feedback is constructive and actionable

---

### VR89: Retrieve & Callback — Review Mode (Chapter)

**Prerequisite:** VR30 must have succeeded.

**Speak:**
> "Pull up chapter one of The Veto and call me back to go over it"

**Expected:**
- [ ] Eve retrieves the chapter
- [ ] Outbound call triggered
- [ ] Eve gives chapter-specific feedback: does it match the outline? Is the character voice consistent?
- [ ] Eve can reference the outline context

---

### VR90: Retrieve & Callback — Review Mode (Outline)

**Prerequisite:** VR23 must have succeeded.

**Speak:**
> "Get the outline for The Veto and call me back let's discuss it"

**Expected:**
- [ ] Eve retrieves the outline
- [ ] Outbound call triggered
- [ ] Eve walks through the outline chapter by chapter
- [ ] Eve identifies structural strengths and weaknesses
- [ ] Eve suggests character development opportunities

---

### VR91: KB Cleanup — Back-to-Back Retrievals

**Purpose:** Verify old session KB docs are removed before new ones are added.

**Speak (first call):**
> "Pull up my research report about AI music and call me back to review it"

**Wait for callback, discuss briefly, then hang up.**

**Speak (second call):**
> "Now pull up my blog post about female pharaohs and call me back to revise that instead"

**Expected:**
- [ ] Second callback works correctly
- [ ] Eve has the pharaohs blog post loaded, NOT the AI music research
- [ ] ElevenLabs agent KB shows only ONE "Eve Session:" doc (the blog post)
- [ ] Eve cannot reference the AI music research (it was cleaned up)

---

### VR92: Content Not Found — No Callback

**Speak:**
> "Pull up my draft novel about sentient mushrooms on Mars and call me back to edit it"

**Expected:**
- [ ] Hub calls `retrieve_content` → returns found=false
- [ ] Hub does NOT call `eve_knowledge_callback`
- [ ] Eve relays error: content not found, suggests listing drafts
- [ ] **No outbound call triggered**

---

### VR93: Parallel Tasks + Callback

**Speak:**
> "Write a newsletter about ancient Mesopotamian trade routes for the ancient history genre and also pull up my AI music research and call me back to brainstorm from it"

**Expected:**
- [ ] Eve detects two independent tasks
- [ ] Task 1: fires `forward_writing_request` for newsletter
- [ ] Task 2: fires `forward_writing_request` with "RETRIEVE AND CALLBACK"
- [ ] Newsletter gets written and emailed (async)
- [ ] Research loaded into KB, Eve calls back for brainstorming
- [ ] Both tasks execute successfully

---

# SECTION J: Genre Inference, Edge Cases & Revisions (VR94–VR102)

---

### VR94: Genre Inference — Ambiguous Topic

**Speak:**
> "Write me a story about a gladiator who falls in love with a Vestal Virgin in ancient Rome"

**Expected:**
- [ ] Agent infers genre_slug=ancient-history without being explicitly told
- [ ] Fills in other parameters
- [ ] Story written and emailed

---

### VR95: Messy/Natural Speech with Self-Correction

**Speak:**
> "So I need a um blog post about wait no actually make it a newsletter about how quantum computing is going to break all our encryption and what companies should do about it the genre is uh I guess ai marketing no actually political scifi make it political scifi about two thousand words"

**Expected:**
- [ ] Agent handles self-corrections (blog → newsletter, ai-marketing → political-scifi)
- [ ] Maps to `write_newsletter` with genre_slug=political-scifi
- [ ] Newsletter written and emailed

---

### VR96: Multi-Step Voice Workflow

**Speak (Message 1):**
> "Research what happened during the Siege of Vienna in sixteen eighty three and who the key players were"

**Speak (Message 2, after response):**
> "Cool now write a blog post about that for the political history genre about fifteen hundred words"

**Expected:**
- [ ] Agent researches first, then writes blog incorporating findings

---

### VR97: Sequential Tasks — Brainstorm Then Write Chapter 1

**Speak:**
> "First brainstorm a post apocalyptic story called The Water Table about an aquifer engineer who discovers the last underground freshwater source is being drained by a warlord five chapters genre post apocalyptic themes water rights survival resource wars then write chapter one from that outline"

**Expected:**
- [ ] Eve detects sequential dependency
- [ ] Fires ONE `forward_writing_request` with SEQUENTIAL TASKS format
- [ ] Task 1: brainstorm_story runs, outline saved
- [ ] Task 2: write_chapter runs after outline is saved, loading the new outline
- [ ] Both emails arrive (outline first, then chapter)

---

### VR98: Revise a Chapter — Voice Command with Tonal Adjustment

**Tests:** Requesting a chapter rewrite with specific creative direction

**Prerequisite:** VR30 must have succeeded (Chapter 1 of The Veto written).

**Speak:**
> "Rewrite chapter one of The Veto genre political scifi chapter number one I want it darker and more claustrophobic open with the diplomat already trapped in a private negotiation that's going wrong not a calm introduction"

**Expected:**
- [ ] Agent maps to `write_chapter` with project_title="The Veto", chapter_number=1
- [ ] Loads stored outline for chapter 1 context
- [ ] Rewritten chapter reflects the tonal adjustments (darker, claustrophobic, in medias res)
- [ ] New draft saved to `published_content`
- [ ] Story bible entries updated or maintained
- [ ] Email arrives with rewritten chapter

---

### VR99: Revise a Short Story — Voice Command with Structural Changes

**Tests:** Requesting a short story rewrite with specific structural changes

**Prerequisite:** VR29 must have succeeded (The Beekeeper written).

**Speak:**
> "Rewrite the short story The Beekeeper genre post apocalyptic this time start with the colony already dying don't build up to it and make the ending more ambiguous leave the reader wondering if the bees survived or not"

**Expected:**
- [ ] Agent maps to `write_short_story` with title="The Beekeeper"
- [ ] Loads stored Freytag outline
- [ ] Rewritten story incorporates structural changes (in medias res, ambiguous ending)
- [ ] New draft saved
- [ ] Cover art regenerated
- [ ] Email arrives

---

### VR100: Voice — Numbered Phrasing for Chapters

**Tests:** Voice handling of chapter numbers spoken in different ways

**Prerequisite:** VR27 must have succeeded.

**Speak:**
> "Write the second chapter of The Lighthouse Keeper metaphysical romance"

**Expected:**
- [ ] Agent correctly interprets "second chapter" as chapter_number=2
- [ ] Maps to `write_chapter` with chapter_number=2
- [ ] Email arrives

---

### VR101: Voice — Genre Correction Mid-Request

**Tests:** Eve handles a mid-sentence genre correction

**Speak:**
> "Write a short story in the ancient history genre wait no I mean historical time travel about a coin collector who discovers that Roman denarii can transport you to the year they were minted about twenty five hundred words"

**Expected:**
- [ ] Agent uses the corrected genre (historical-time-travel, not ancient-history)
- [ ] Maps to `write_short_story` with genre_slug=historical-time-travel
- [ ] Story written and emailed

---

### VR102: Voice — Long Compound Request

**Tests:** Eve handling a long, run-on voice command with multiple parameters

**Speak:**
> "OK so I want you to brainstorm a new story it's going to be a political history story called The Typewriter Conspiracy and it's about a journalist in nineteen fifty three who discovers that the CIA is secretly funding literary magazines to fight the Cold War through culture and she has to decide whether to expose it or protect the writers who don't know they're being used the themes are truth versus national security art as propaganda intellectual freedom make it eight chapters and use the Three-Act Structure"

**Expected:**
- [ ] Agent correctly parses all parameters from the long run-on sentence
- [ ] Maps to `brainstorm_story` with title="The Typewriter Conspiracy", genre_slug=political-history, 8 chapters, Three-Act Structure
- [ ] All themes captured
- [ ] Outline emailed and saved

---

# SECTION K: Writing Prime Directive Verification (VR103–VR105)

---

### VR103: Prime Directive — Blog Post Check

**Prerequisite:** VR06 must have succeeded.

**Manual Check (review the VR06 email):**
- [ ] No banned words: revolutionize, game-changing, unleash, delve, cutting-edge, leverage, harness, paradigm, synergy, disrupt, empower
- [ ] Paragraphs ≤ 4 sentences
- [ ] Concrete examples and data, not vague claims
- [ ] Reads like a human wrote it, not AI
- [ ] No stage directions or emotion labels in the text

---

### VR104: Prime Directive — Short Story Check

**Prerequisite:** VR11 must have succeeded.

**Manual Check (review the VR11 email):**
- [ ] Clear, direct language — no purple prose
- [ ] Genuine emotion through action and dialogue, not stated feelings
- [ ] Concrete sensory details (what characters see, hear, smell, touch)
- [ ] Short paragraphs, varied sentence length
- [ ] No cliches

---

### VR105: Prime Directive — Chapter Check

**Prerequisite:** VR30 must have succeeded.

**Manual Check (review the VR30 email):**
- [ ] Same criteria as VR104
- [ ] Characters behave consistently with outline profiles
- [ ] Chapter advances the plot per the outline's chapter brief
- [ ] Dialogue sounds natural, not expository

---

# FULL TEST CHECKLIST

## Run Order

| # | Test | Section | What It Covers | Pass? |
|---|------|---------|---------------|-------|
| 1 | VR01 | A | Perplexity research (messy speech) | |
| 2 | VR02 | A | Save research report | |
| 3 | VR03 | A | Email report | |
| 4 | VR04 | A | Centralized email config | |
| 5 | VR05 | A | List research reports | |
| 6 | VR06 | B | Blog post — AI Marketing | |
| 7 | VR07 | B | Blog post — Political History (messy speech) | |
| 8 | VR08 | B | Blog post — Ancient History | |
| 9 | VR09 | B | Newsletter — Post-Apocalyptic | |
| 10 | VR10 | B | Newsletter — Metaphysical Romance | |
| 11 | VR11 | B | Short story — Post-Apocalyptic | |
| 12 | VR12 | B | Short story — Historical Time Travel | |
| 13 | VR13 | B | Short story — Ancient History | |
| 14 | VR14 | B | Short story — Metaphysical Romance | |
| 15 | VR15 | B | Cover art — Political Sci-Fi | |
| 16 | VR16 | B | Cover art — Metaphysical Romance | |
| 17 | VR17 | B | Social media — Twitter | |
| 18 | VR18 | B | Social media — LinkedIn | |
| 19 | VR19 | B | Social media — Instagram | |
| 20 | VR20 | B | Social media — Facebook | |
| 21 | VR21 | C | List story arcs | |
| 22 | VR22 | C | Brainstorm — Freytag, post-apocalyptic | |
| 23 | VR23 | C | Brainstorm — Freytag, political-scifi | |
| 24 | VR24 | C | Brainstorm — Three-Act, historical-time-travel | |
| 25 | VR25 | C | Brainstorm — Three-Act, ai-marketing | |
| 26 | VR26 | C | Brainstorm — no arc, ancient-history | |
| 27 | VR27 | C | Brainstorm — metaphysical-romance | |
| 28 | VR28 | C | **Brainstorm conversation + genre correction** | |
| 29 | VR29 | D | Write short story from Freytag outline | |
| 30 | VR30 | D | Write chapter 1 — Freytag outline | |
| 31 | VR31 | D | Write chapter 2 — continuity | |
| 32 | VR32 | D | Write chapter 3 — continuity | |
| 33 | VR33 | D | Write short story from Three-Act outline | |
| 34 | VR34 | D | Write chapter 1 — Three-Act outline | |
| 35 | VR35 | D | Write short story from default outline | |
| 36 | VR36 | D | Write chapter 1 — metaphysical-romance | |
| 37 | VR37 | E | Retrieve outline — The Veto | |
| 38 | VR38 | E | Revise outline — prologue + epilogue | |
| 39 | VR39 | E | Write prologue — The Veto | |
| 40 | VR40 | E | Write epilogue — The Veto | |
| 41 | VR41 | E | Write chapter 4 after revision | |
| 42 | VR42 | E | Write chapter 5 — continuing book | |
| 43 | VR43 | E | Retrieve outline — The Cartographer | |
| 44 | VR44 | E | Revise outline — prologue only | |
| 45 | VR45 | E | Write prologue — The Cartographer | |
| 46 | VR46 | E | Retrieve outline — The Ghost Writer | |
| 47 | VR47 | E | Revise outline — epilogue only | |
| 48 | VR48 | E | Write epilogue — The Ghost Writer | |
| 49 | VR49 | E | Revise outline — prologue + epilogue (Salt Road) | |
| 50 | VR50 | E | Write prologue — The Salt Road | |
| 51 | VR51 | F | List all outlines | |
| 52 | VR52 | F | List outlines — alternate phrasing | |
| 53 | VR53 | F | Outline version history — The Veto | |
| 54 | VR54 | F | Outline version history — no revisions | |
| 55 | VR55 | F | Revert outline — The Veto to v1 | |
| 56 | VR56 | F | Verify revert — retrieve | |
| 57 | VR57 | F | Re-revise after revert | |
| 58 | VR58 | F | Verify version history after revisions | |
| 59 | VR59 | F | Revert — invalid version | |
| 60 | VR60 | F | Revert — project not found (messy speech) | |
| 61 | VR61 | G | List drafts | |
| 62 | VR62 | G | List drafts — filter by type | |
| 63 | VR63 | G | Approve draft | |
| 64 | VR64 | G | Publish content | |
| 65 | VR65 | G | Schedule publishing | |
| 66 | VR66 | G | List scheduled content | |
| 67 | VR67 | G | Unschedule (casual phrasing) | |
| 68 | VR68 | G | Reject draft | |
| 69 | VR69 | G | Unpublish content | |
| 70 | VR70 | G | Content version history | |
| 71 | VR71 | G | **Delete content (soft delete)** | |
| 72 | VR72 | G | **Delete — published must unpublish first** | |
| 73 | VR73 | G | **List deleted content** | |
| 74 | VR74 | G | **List deleted — alternate phrasing ("trash")** | |
| 75 | VR75 | G | **Undelete content (restore)** | |
| 76 | VR76 | G | **Verify undelete — back in drafts** | |
| 77 | VR77 | G | **Email content — outline** | |
| 78 | VR78 | G | **Email content — short story** | |
| 79 | VR79 | G | **Email content — research report** | |
| 80 | VR80 | G | **Email content — chapter** | |
| 81 | VR81 | G | **Email content — not found** | |
| 82 | VR82 | H | Story bible — multi-chapter read | |
| 83 | VR83 | H | Story bible — different project | |
| 84 | VR84 | H | Story bible — not found | |
| 85 | VR85 | I | Retrieve — no callback (research) | |
| 86 | VR86 | I | Retrieve — no callback (draft) | |
| 87 | VR87 | I | **Callback — review (blog)** | |
| 88 | VR88 | I | **Callback — review (story)** | |
| 89 | VR89 | I | **Callback — review (chapter)** | |
| 90 | VR90 | I | **Callback — review (outline)** | |
| 91 | VR91 | I | KB cleanup — back-to-back | |
| 92 | VR92 | I | Content not found — no callback | |
| 93 | VR93 | I | Parallel tasks + callback | |
| 94 | VR94 | J | Genre inference — ambiguous | |
| 95 | VR95 | J | Messy speech + self-correction | |
| 96 | VR96 | J | Multi-step voice workflow | |
| 97 | VR97 | J | Sequential tasks — brainstorm then write | |
| 98 | VR98 | J | **Revise a chapter** (tonal) | |
| 99 | VR99 | J | **Revise a short story** (structural) | |
| 100 | VR100 | J | Chapter number as ordinal word | |
| 101 | VR101 | J | Genre correction mid-request | |
| 102 | VR102 | J | Long compound run-on request | |
| 103 | VR103 | K | Prime Directive — blog check | |
| 104 | VR104 | K | Prime Directive — story check | |
| 105 | VR105 | K | Prime Directive — chapter check | |

**Total: 105 voice tests** across 11 sections

---

## Coverage Summary

| Feature | Tests |
|---------|-------|
| Perplexity research | VR01 |
| Research reports (save/list) | VR02, VR05 |
| Email delivery | VR03, VR04 |
| Blog posts (3 genres) | VR06–VR08 |
| Newsletters (2 genres) | VR09–VR10 |
| Short stories (4 genres) | VR11–VR14 |
| Cover art (2 genres) | VR15–VR16 |
| Social media (all 4 platforms) | VR17–VR20 |
| Story arcs | VR21–VR27 |
| Brainstorm conversation mode + genre correction | VR28 |
| Write from outline (short stories) | VR29, VR33, VR35 |
| Write from outline (chapters) | VR30–VR32, VR34, VR36 |
| Multi-chapter continuity | VR30–VR32, VR41–VR42 |
| Outline revision (prologue + epilogue) | VR38, VR44, VR47, VR49 |
| Write prologue | VR39, VR45, VR50 |
| Write epilogue | VR40, VR48 |
| Write additional chapters after revision | VR41–VR42 |
| Outline management (list/versions/revert) | VR51–VR60 |
| Content library lifecycle | VR61–VR70 |
| **Delete content (soft delete)** | VR71–VR72 |
| **List deleted / trash** | VR73–VR74 |
| **Undelete / restore** | VR75–VR76 |
| **Email content** | VR77–VR81 |
| Story bible | VR82–VR84 |
| Retrieve content (no callback) | VR85–VR86 |
| Eve callback — review mode | VR87–VR90 |
| Eve callback — brainstorm mode | VR28, VR93 |
| KB cleanup | VR91 |
| Error handling (not found) | VR59–VR60, VR81, VR84, VR92 |
| Parallel + sequential tasks | VR93, VR97 |
| Genre inference | VR94 |
| Messy speech / self-correction | VR01, VR07, VR60, VR67, VR95, VR101 |
| Chapter revision (tonal) | VR98 |
| Short story revision (structural) | VR99 |
| Ordinal chapter numbers | VR100 |
| Mid-request genre correction | VR101 |
| Long compound requests | VR102 |
| Writing Prime Directive | VR103–VR105 |

### Voice-Specific Edge Cases Covered

| Edge Case | Test(s) | What It Tests |
|-----------|---------|---------------|
| Filler words ("um", "uh", "like", "you know") | VR01, VR07, VR95 | Agent parses through conversational filler |
| Mid-sentence self-correction ("wait no", "actually") | VR07, VR95, VR101 | Agent uses the corrected value, not the first one |
| Genre correction mid-request | VR28 (Phase 3), VR101 | Agent accepts genre change gracefully |
| Content type correction ("blog no newsletter") | VR95 | Agent uses final content type requested |
| Casual/informal phrasing | VR05, VR52, VR60, VR66, VR67, VR74, VR83, VR86 | Natural speech routed correctly |
| Ordinal numbers ("second chapter" vs "chapter two") | VR100 | Number parsing handles ordinal words |
| Long run-on sentences | VR102 | All parameters extracted from unstructured speech |
| Implicit genre ("story about pharaohs") | VR94 | Genre inferred from topic |

### What's NOT Covered (requires chat regression)

- Chat-specific routing (direct API calls without voice transcription)
- All 7 genres individually for every content type (voice tests cover representative samples)
- Detailed Supabase schema verification
- Cron scheduled auto-publish
- Content Ingestion and AI Scraping pipelines
- Edit Outline tool (lightweight edits without full brainstorm regeneration)

---

## Change Log

| Date | Change |
|------|--------|
| 2026-03-17 | Initial voice regression suite — 94 tests across 11 sections. All unique topics. |
| 2026-03-17 | Added delete, undelete, list_deleted, email_content tests (VR71–VR81). Total now 105 tests. |
