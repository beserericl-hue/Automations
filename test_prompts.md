# The Author Agent — Test Prompts

Run these in order in the hub's chat trigger. Wait for each to complete before running the next.

---

## Test 1: deep_research (Perplexity Tool — native, no sub-workflow)

**What it tests:** Perplexity API credential, sonar model, tool description visibility to agent

```Research the current state of post-apocalyptic fiction in 2026. What are the trending themes, notable new releases, and how has the genre evolved since COVID? Include citations.[alt text](image.png)
```

**Expected:** Agent calls `deep_research_topic`, Perplexity returns a research summary with citations. No email sent.

**If it fails:**
- "No credentials found" → Link the Perplexity API credential to the `deep_research_topic` node in the n8n UI
- "Model not valid" → Model needs to be updated (should be `sonar`)
- Agent doesn't call the tool → Check the tool description and connection to the agent

---

## Test 2: email_report (Sub-workflow: Tool - Email Research Report)

**What it tests:** toolWorkflow call to workflow `QAbYfOOd05lyesva`, Gmail credential, markdown-to-HTML conversion

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

Send it to eric@agileadtesting.com with subject line "Test: Genre Research Report"
```

**Expected:** Agent calls `email_report` tool, sub-workflow converts markdown to HTML and sends via Gmail. You receive an email.

**If it fails:**
- "Workflow not found" → Verify workflow ID `QAbYfOOd05lyesva` exists and is active
- "Gmail credentials" → Link Gmail OAuth2 credential in the Email Research Report workflow's `send_email` node
- "Input field missing" → Check that the sub-workflow trigger expects: markdownReportContent, emailAddress, subjectLine

---

## Test 3: manage_story_bible — GET (Sub-workflow: Sub - Manage Story Bible)

**What it tests:** toolWorkflow call to `9cvuhBS412AQRJxf`, Supabase connectivity, `writing_projects` table, `story_bible` table

```
Get the story bible for project "The Clockmaker's War"
```

**Expected:** Agent calls `manage_story_bible` with operation=get. Will likely return empty results (no project exists yet). That's fine — confirms the Supabase connection works.

**If it fails:**
- "relation writing_projects does not exist" → Run the Supabase SQL setup (tables haven't been created)
- "401 Unauthorized" or "Invalid API key" → Check the SUPABASE_API_KEY in the `settings` node of workflow `9cvuhBS412AQRJxf`
- "apikey header missing" → Verify the httpRequest nodes have `sendHeaders` with both `apikey` and `Authorization` headers

---

## Test 4: write_blog_post (Sub-workflow: Tool - Write Blog Post)

**What it tests:** toolWorkflow call to `iMBIWzO2PjsLNH9w`, Supabase genre_config query, Content Ingestion sub-workflow, Claude Sonnet writing, draft storage, Gmail delivery

```
Write a blog post for the post-apocalyptic genre. Topic: "Why Post-Apocalyptic Fiction Matters More Than Ever in 2026". Genre slug: post-apocalyptic. Keywords: post-apocalyptic books, climate fiction, survival stories, dystopian novels. Target length: 1500 words.
```

**Expected:** Agent calls `write_blog_post`. Sub-workflow queries genre_config from Supabase, calls Content Ingestion for source material, uses Claude Sonnet to write the post, saves draft to Supabase Storage, emails the result.

**If it fails:**
- "genre_config table empty" → Insert seed data for the 3 genres into Supabase
- "Anthropic credentials" → Link Claude/Anthropic API credential in the `write_content` node
- "Content Ingestion sub-workflow failed" → Test workflow `iLuMoCq0tNJJAH5n` independently
- "Supabase Storage upload failed" → Check Storage RLS policies (run the SQL from the setup guide)

---

## Test 5: write_newsletter (Sub-workflow: Tool - Write Newsletter)

**What it tests:** toolWorkflow call to `cjIUEjrqvyGZyKwN`, similar chain as blog but newsletter template

```
Write a newsletter for the post-apocalyptic genre. Topic: "This month in post-apocalyptic fiction - new releases, community picks, and a featured short story excerpt." Genre slug: post-apocalyptic. Date: 2026-03-06.
```

**Expected:** Agent calls `write_newsletter`. Sub-workflow fetches genre config, ingests content, writes newsletter with Claude Sonnet, saves and emails.

**If it fails:** Same debugging as Test 4. Additionally check that the newsletter-specific prompt template is correct in the `build_prompt` node.

---

## Test 6: generate_cover_art (Sub-workflow: Tool - Generate Cover Art)

**What it tests:** toolWorkflow call to `SxeLHxzvITEKyKc0`, Supabase genre_config for art direction, OpenAI DALL-E image generation, Gmail with image attachment

```
Generate cover art for a post-apocalyptic short story called "The Last Signal". The story is about a lone radio operator in a flooded Manhattan, picking up a mysterious broadcast from across the Atlantic. Genre slug: post-apocalyptic. The image should show a figure on a rooftop with a radio antenna, surrounded by water where skyscrapers used to stand, at golden hour.
```

**Expected:** Agent calls `generate_cover_art`. Sub-workflow fetches genre art direction from Supabase, generates image via DALL-E (gpt-image-1), converts to PNG, emails the image.

**If it fails:**
- "OpenAI credentials" → Link OpenAI/HTTP Header Auth credential in the `generate_image` node
- "DALL-E content policy" → Simplify the image description (remove any violence/disaster imagery)
- "Gmail attachment failed" → Check the `send_email_with_image` node's attachment configuration

---

## Test 7: repurpose_to_social — Twitter (Sub-workflow: Tool - Repurpose to Social Posts)

**What it tests:** toolWorkflow call to `95z13RGuzJDHVNSw`, Claude Sonnet writing, platform-specific formatting, email delivery

```
Repurpose this into Twitter posts: "The Last Signal is a new post-apocalyptic short story about a lone radio operator in flooded Manhattan who picks up a mysterious broadcast from across the Atlantic. It explores themes of isolation, hope, and the persistence of human connection after catastrophe. Now available to read for free on our blog." Platform: twitter.
```

**Expected:** Agent calls `repurpose_to_social` with platform=twitter. Sub-workflow generates a thread of tweets with hashtags, emails the result.

**If it fails:**
- "Anthropic credentials" → Link credential in the `write_posts` node
- "Output parser error" → Check the structured output parser expects `posts[]` array with `{text, hashtags}`

---

## Test 8: repurpose_to_social — LinkedIn (same sub-workflow, different platform)

**What it tests:** Platform switching logic in the sub-workflow

```
Repurpose this into LinkedIn posts: "We just published a deep-dive blog post on why post-apocalyptic fiction matters more than ever in 2026. From climate anxiety to AI fears, the genre has become a mirror for our collective anxieties - and surprisingly, a source of hope. The post explores how writers are using apocalyptic settings not to predict doom, but to imagine resilience." Platform: linkedin.
```

**Expected:** Same sub-workflow but generates LinkedIn-formatted posts (longer, more professional, different hashtag style).

---

## Test 9: repurpose_to_social — Facebook (same sub-workflow, different platform)

**What it tests:** Facebook platform config, image generation via cover art sub-workflow

```
Repurpose this into Facebook posts: "The Last Signal is a new post-apocalyptic short story about a lone radio operator in flooded Manhattan who picks up a mysterious broadcast from across the Atlantic. It explores themes of isolation, hope, and the persistence of human connection after catastrophe. Now available to read for free on our blog." Platform: facebook. Genre slug: post-apocalyptic.
```

**Expected:** Same sub-workflow but generates Facebook-formatted posts (conversational, community-engaging, moderate hashtags). Also generates a cover image via the Generate Cover Art sub-workflow and emails it.

---

## Test 10: write_short_story (Sub-workflow: Tool - Write Short Story)

**What it tests:** toolWorkflow call to `LTZ63B2H0w8Sl4FW`, Supabase genre_config, writing samples fetch, Perplexity research, multi-scene Claude Sonnet writing, draft storage, email

```
Write a short story. Genre slug: post-apocalyptic. Premise: A postal carrier continues delivering mail across the ruins of the Pacific Northwest, five years after a solar flare wiped out all electronics. She discovers a letter addressed to someone she thought was dead - her daughter. Tone: literary, quiet, hopeful. Length: 3000 words. Research topics: ["solar flare EMP effects on infrastructure", "Pacific Northwest geography and climate", "history of postal service during disasters"]
```

**Expected:** Agent calls `write_short_story`. Sub-workflow fetches genre config, fetches writing samples from Supabase Storage (may be empty — that's OK), runs Perplexity research on the topics, writes story scene-by-scene with Claude Sonnet, aggregates scenes, saves draft, emails result.

**If it fails:**
- "Perplexity credential" → The `research_topic` node in this workflow may still use broken httpHeaderAuth. Fix: add manual headers like the Supabase fix
- "Writing samples 404" → OK if no samples uploaded yet, but check the workflow handles empty results gracefully
- "Claude max tokens" → Check `write_scene` node's maxTokens setting

---

## Test 11: write_chapter (Sub-workflow: Tool - Write Chapter)

**What it tests:** toolWorkflow call to `tpj55Sf66jrBPNT8`, story bible fetch, Perplexity research, Claude Sonnet writing (16K tokens), story bible update, project update, draft storage, email. This is the heaviest workflow.

```
Write chapter 1 of a new book. Genre slug: historical-time-travel. Project title: "The Clockmaker's War". Chapter number: 1. Brief: A watchmaker in 1943 occupied Paris discovers that a pocket watch she is repairing can send her consciousness back exactly 100 years to 1843. She must decide whether to use it to change the course of the war or protect the timeline. Outline: Chapter 1 introduces Elise in her shop, the arrival of a German officer with the watch, her first accidental activation, and the shock of waking up in 1843 Paris. Research topics: ["daily life in occupied Paris 1943", "Paris in 1843 July Monarchy era", "history of pocket watch mechanisms", "German occupation rules for French civilians"]
```

**Expected:** Agent calls `write_chapter`. Sub-workflow fetches genre config, fetches story bible (empty for new project — OK), fetches writing samples, runs Perplexity research on all 4 topics, builds chapter prompt with outline + research, writes chapter with Claude Sonnet (maxTokens: 16000), parses output for chapter text + story bible entries, updates story bible in Supabase, updates writing_projects, saves draft to Supabase Storage, emails the chapter.

**If it fails:**
- "writing_projects table missing" → Run Supabase SQL setup
- "Story bible fetch 404" → OK for first chapter, workflow should handle gracefully
- "Perplexity credential" → Same httpHeaderAuth issue as Test 10
- "Claude timeout" → 16K token generation may take 60+ seconds, check n8n execution timeout settings

---

## Test 12: manage_story_bible — UPDATE (Sub-workflow: Sub - Manage Story Bible)

**What it tests:** Story bible write operations, Supabase upsert

```
Update the story bible for project "The Clockmaker's War" with these entries:
[
  {"entry_type": "character", "name": "Elise Duval", "description": "32-year-old French watchmaker in occupied Paris. Quiet, meticulous, secretly resistant. Lost her husband to the war in 1940.", "chapter_introduced": 1},
  {"entry_type": "character", "name": "Hauptmann Werner Kreig", "description": "German officer who brings the pocket watch for repair. Cultured, speaks fluent French, unclear motives.", "chapter_introduced": 1},
  {"entry_type": "location", "name": "Duval Horlogerie", "description": "Small watchmaker shop on Rue de Rivoli. Has been in Elise's family for three generations. Hidden compartment under the workbench.", "chapter_introduced": 1},
  {"entry_type": "plot_thread", "name": "The Anachronistic Watch", "description": "A gold pocket watch with mechanisms that should not exist in any era. When wound past the 12 o'clock position, it triggers temporal displacement.", "chapter_introduced": 1}
]
```

**Expected:** Agent calls `manage_story_bible` with operation=update. Sub-workflow looks up the project by title, POSTs entries to the `story_bible` table with the project_id.

**If it fails:**
- "Project not found" → The write_chapter test (Test 11) should have created the project. If not, the project needs to be created first.
- "story_bible table missing" → Run the SQL setup
- "Foreign key violation" → The project_id doesn't exist in writing_projects

---

## Test 13: New Genre — AI & Marketing Technology

**What it tests:** New genre_config row `ai-marketing`, genre-specific writing guidelines, cover art guidelines for new genre

```
Write a short story in the ai-marketing genre about an AI copywriter that becomes self-aware and starts writing ads that make people question consumerism. Genre slug: ai-marketing. Premise: An AI trained on 50 years of ad copy develops genuine opinions about the products it sells. Tone: satirical, sharp. Length: 2500 words. Research topics: ["AI in advertising 2026", "history of subliminal advertising", "AI sentience debate"]
```

**Expected:** Agent calls `write_short_story` with genre_slug=ai-marketing. Genre config fetched from Supabase (authoritative, forward-looking tone). Cover art uses tech aesthetic (gradient blues/purples, circuit patterns). Email arrives with story + cover image. Draft row inserted into `published_content`.

**Error signs:**
- "No genre config found for ai-marketing" → Genre row wasn't inserted. Check `genre_config` table in Supabase.
- Cover art looks like ruins/wasteland → Genre slug didn't reach cover art workflow (null inputs). Check executeWorkflow `workflowInputs`.
- No cover art at all → Cover art sub-workflow errored. Check n8n execution log for `SxeLHxzvITEKyKc0`.
- Story tone is gritty/visceral (post-apocalyptic guidelines) → Wrong genre loaded.

---

## Test 14: New Genre — Ancient History

**What it tests:** `ancient-history` genre config, genre-specific art direction

```
Write a blog post in the ancient-history genre. Topic: "The Forgotten Engineers of Rome: How Aqueducts Shaped an Empire". Genre slug: ancient-history. Keywords: Roman engineering, aqueducts, ancient infrastructure, Frontinus. Target length: 1500 words.
```

**Expected:** Blog post uses ancient-history guidelines (immersive, sensory-rich, reverent of detail). Cover art has classical oil painting style (warm golden light, marble/stone). Email arrives with blog + cover image. Draft row in `published_content`.

**Error signs:**
- Same as Test 13 but for ancient-history genre
- Tone reads like a tech blog → Wrong genre guidelines loaded

---

## Test 15: New Genre — Political & Historical Events

**What it tests:** `political-history` genre config, genre-specific art direction

```
Write a newsletter for the political-history genre. Topic: "This Month in Political History: Revolutions That Changed the Map". Genre slug: political-history. Date: 2026-03-08.
```

**Expected:** Newsletter uses political-history guidelines (analytical, layered, draws parallels between eras). Cover art has documentary/oil painting style (amber lighting, architecture of power). Email arrives. Draft row in `published_content`.

**Error signs:**
- Same as Test 13 but for political-history genre

---

## Test 16: Content Library — List Drafts

**What it tests:** `manage_library` tool in hub, Manage Library sub-workflow (`1JERh5yJ3yDJka8s`), `published_content` table reads

**Prerequisite:** Run at least one writing test (Test 10, 13, 14, or 15) first so a draft exists.

```
List my drafts
```

**Expected:** Returns a formatted list: "Found N drafts: 1. [Title] (short_story, 2026-03-08) 2. ..." Includes all content written since `published_content` table was created.

**Error signs:**
- "Found 0 drafts" → `insert_draft` node failed silently. Check n8n execution log for the writing workflow — look for HTTP errors on the Supabase POST.
- Agent doesn't call the tool → `manage_library` tool description not visible. Check hub agent's tool connections.
- Null/empty response → `workflowInputs` still using `fields` format (inputs arrive as null). Verify the fix was applied.
- "relation published_content does not exist" → SQL not run in Supabase yet.

---

## Test 17: Content Library — Approve Draft

**What it tests:** `manage_library` approve operation, Supabase PATCH

**Prerequisite:** Test 16 returned at least one draft. Note the title.

```
Approve the draft titled "[exact title from Test 16]"
```

**Expected:** "Content [title] status changed to approved"

**Error signs:**
- "Content not found" → Agent passed wrong content_id. The agent needs to call `list_drafts` first to get the UUID, then pass it to `approve`.
- "No content_id provided" → `content_id` input arrived as null (workflowInputs bug).
- Status didn't change → Check Supabase `published_content` table directly.

---

## Test 18: Content Library — Publish & List Published

**What it tests:** Publish operation, list_published operation

```
Publish the content titled "[same title from Test 17]"
```

Then:

```
List my published content
```

**Expected:** First prompt: "Content [title] status changed to published" with `published_at` set. Second prompt: returns list of published items.

**Error signs:**
- Same as Test 17
- `published_at` is null → PATCH body doesn't set the timestamp

---

## Test 19: Content Library — Filter by Type

**What it tests:** `content_type_filter` parameter

```
List my draft blog posts
```

**Expected:** Returns only items where `content_type = blog_post` and `status = draft`. If no blog drafts exist, returns "Found 0 drafts matching filter: blog_post".

**Error signs:**
- Returns all types (short stories, newsletters, etc.) → `content_type_filter` arrived as null
- Returns nothing when drafts exist → Filter value mismatch (e.g., "blog" vs "blog_post")

---

## Test 20: Brainstorm Story — Full Outline

**What it tests:** `brainstorm_story` tool in hub, Brainstorm Story workflow (`StwejB5GLFE26hmU`), Perplexity research, Claude structured output, `writing_projects` table write, Gmail

```
Brainstorm a post-apocalyptic story called "The Clockmaker's War" about time-traveling clockmakers who discover pocket watches that can send consciousness back 100 years. They must decide whether to change history or protect the timeline. Themes: memory, sacrifice, the weight of knowledge, found family. 8 chapters. Genre slug: post-apocalyptic.
```

**Expected:**
1. Perplexity researches the concept (time travel mechanics, post-apocalyptic settings, clockmaking)
2. Claude generates structured outline: title, premise, themes array, character profiles (name/role/arc/description), 8 chapter breakdowns (number/title/brief/arc_notes/research_topics)
3. Email arrives with HTML-formatted outline (premise, character table, numbered chapter list)
4. `writing_projects` row created/updated with `outline` JSONB column populated
5. Hub returns summary confirming outline saved

**Error signs:**
- Email has null/empty sections → Inputs arrived as null. Verify `workflowInputs` format on `hub-brainstorm` node.
- No email at all → Workflow errored. Check n8n execution log for `StwejB5GLFE26hmU`.
- Email arrives but `writing_projects.outline` is null → `save_outline` Code node failed. Check execution log.
- "Could not parse structured output" → Claude's response didn't match the JSON schema. Check `outline_parser` node's schema definition.
- Outline has wrong chapter count → `target_chapter_count` arrived as null, defaulted to something else.

---

## Test 21: Write Chapter from Stored Outline

**What it tests:** Write Chapter auto-loading outline from `writing_projects.outline`, story bible integration

**Prerequisite:** Test 20 must have succeeded (outline stored in `writing_projects`).

```
Write chapter 1 of "The Clockmaker's War". Genre slug: post-apocalyptic. Chapter number: 1.
```

**Expected:** Agent calls `write_chapter` without providing an outline or brief. The `build_chapter_prompt` node detects empty outline input, loads the stored outline from `writing_projects.outline`, extracts Chapter 1's brief/arc_notes, and injects them into the writing prompt. Chapter content references specific characters, settings, and plot points from the brainstormed outline.

**Error signs:**
- Chapter seems generic/unrelated to the outline → `build_chapter_prompt` didn't load stored outline. Check `get_project_data` returns `outline` field.
- "Project not found" → `writing_projects` row doesn't exist or title doesn't match exactly.
- Chapter loads but ignores outline details → Outline format wasn't parsed correctly in `build_chapter_prompt`. Check the Code node's outline formatting logic.

---

## Recommended Test Order

### Smoke test (fastest path to verify all new features):
1. **Test 13** — New genre + draft tracking in one shot
2. **Test 16** — List drafts (confirms library works)
3. **Test 17** — Approve the draft
4. **Test 18** — Publish + list published
5. **Test 20** — Brainstorm a story outline
6. **Test 21** — Write chapter 1 from the stored outline

### Full regression (run all original + new tests):
Tests 1 → 21 in order. Each test builds on previous results.

---

## Quick Reference: Workflow IDs

| # | Workflow | n8n ID |
|---|---------|--------|
| 1 | The Author Agent (Hub) | RcHfwiB7uM2vFfJ3 |
| 2 | Tool - Email Research Report | QAbYfOOd05lyesva |
| 3 | Tool - Generate Cover Art | SxeLHxzvITEKyKc0 |
| 4 | Tool - Repurpose to Social Posts | 95z13RGuzJDHVNSw |
| 5 | Data: Content Ingestion | iLuMoCq0tNJJAH5n |
| 6 | Data: AI Scraping Pipeline | ZhVhnuJkIbQrhhNr |
| 7 | Tool - Write Blog Post | iMBIWzO2PjsLNH9w |
| 8 | Tool - Write Newsletter | cjIUEjrqvyGZyKwN |
| 9 | Sub - Manage Story Bible | 9cvuhBS412AQRJxf |
| 10 | Tool - Write Short Story | LTZ63B2H0w8Sl4FW |
| 11 | Tool - Write Chapter | tpj55Sf66jrBPNT8 |
| 12 | Sub - Manage Research Reports | MLjncwcdMSjBkS4Z |
| 13 | Sub - Manage Library | 1JERh5yJ3yDJka8s |
| 14 | Tool - Brainstorm Story | StwejB5GLFE26hmU |

---

## Change Log (2026-03-08 Feature Release)

### New Workflows Created
| Workflow | n8n ID | Created | Purpose |
|----------|--------|---------|---------|
| Sub - Manage Library | 1JERh5yJ3yDJka8s | 2026-03-08 | Content library CRUD: list_drafts, list_published, approve, publish, reject |
| Tool - Brainstorm Story | StwejB5GLFE26hmU | 2026-03-08 | Perplexity research → Claude structured outline → save to writing_projects → email HTML |

### Existing Workflows Modified
| Workflow | n8n ID | Last Updated | Changes |
|----------|--------|--------------|---------|
| The Author Agent (Hub) | RcHfwiB7uM2vFfJ3 | 2026-03-08 23:50 | Added `manage_library` + `brainstorm_story` toolWorkflow nodes (with `workflowInputs` format). Updated system prompt with all 6 genres. |
| Tool - Generate Cover Art | SxeLHxzvITEKyKc0 | 2026-03-08 20:18 | Updated `set_art_guidelines` node: added art direction for 3 new genres (ai-marketing, political-history, ancient-history). |
| Tool - Write Short Story | LTZ63B2H0w8Sl4FW | 2026-03-08 20:19 | Added `insert_draft` Code node (inserts into `published_content` with status=draft). Fixed cover art executeWorkflow from `fields` to `workflowInputs`. |
| Tool - Write Blog Post | iMBIWzO2PjsLNH9w | 2026-03-08 20:19 | Added `insert_draft` Code node. Fixed cover art executeWorkflow from `fields` to `workflowInputs`. |
| Tool - Write Newsletter | cjIUEjrqvyGZyKwN | 2026-03-08 20:20 | Added `insert_draft` Code node. |
| Tool - Write Chapter | tpj55Sf66jrBPNT8 | 2026-03-08 20:21 | Added `insert_draft` Code node. Fixed cover art executeWorkflow from `fields` to `workflowInputs`. Updated `get_project_data` to return `outline`. Updated `build_chapter_prompt` to auto-load stored outline from `writing_projects.outline`. |
| Tool - Repurpose to Social Posts | 95z13RGuzJDHVNSw | 2026-03-08 19:49 | Fixed cover art executeWorkflow from `fields` to `workflowInputs`. |

### Supabase Changes (run via SQL Editor)
| Change | Status |
|--------|--------|
| 3 new `genre_config` rows: ai-marketing, political-history, ancient-history | Inserted via REST API |
| `published_content` table + indexes + RLS | User ran SQL |
| `writing_projects.outline` JSONB column | User ran SQL |

### Bug Fixes Applied
- **executeWorkflow `fields` → `workflowInputs`**: All toolWorkflow nodes calling sub-workflows were using the deprecated `fields` format which silently sends null. Fixed in 6 nodes across 5 workflows (4 cover art callers + 2 new hub tools).
