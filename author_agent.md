# The Author Agent: Design Specification

> **Purpose:** This document is a build-ready specification. Each workflow section contains the exact node types, parameters, connections, and prompts needed to assemble the workflow in n8n.

---

## Table of Contents
1. [System Architecture](#1-system-architecture)
2. [Genre Configuration](#2-genre-configuration)
3. [Data Pipeline: Scraping & Storage](#3-data-pipeline-scraping--storage)
4. [API Tools Reference](#4-api-tools-reference)
5. [Workflow Specifications](#5-workflow-specifications)
   - 5.1 [Hub: The Author Agent](#51-hub-the-author-agent)
   - 5.2 [Data: AI Scraping Pipeline](#52-data-ai-scraping-pipeline)
   - 5.3 [Data: Content Ingestion](#53-data-content-ingestion)
   - 5.4 [Tool: Write Blog Post](#54-tool-write-blog-post)
   - 5.5 [Tool: Write Newsletter](#55-tool-write-newsletter)
   - 5.6 [Tool: Write Short Story](#56-tool-write-short-story)
   - 5.7 [Tool: Write Chapter](#57-tool-write-chapter)
   - 5.7b [Sub: Manage Story Bible](#57b-sub-manage-story-bible)
   - 5.8 [Tool: Deep Research](#58-tool-deep-research)
   - 5.9 [Tool: Email Report](#59-tool-email-report)
   - 5.10 [Tool: Generate Cover Art](#510-tool-generate-cover-art)
   - 5.11 [Tool: Repurpose to Social Posts](#511-tool-repurpose-to-social-posts)
6. [Changes from Marketing Agent](#6-changes-from-marketing-agent)

---

## 1. System Architecture

```
              ElevenLabs Voice Agent (Eve)
                        |
                  POST /webhook
                  body: { user_message_request: "..." }
                        |
                        v
+------------------------------------------------------------------------+
|                    THE AUTHOR AGENT (Hub)                               |
|                    n8n Workflow                                          |
|                                                                        |
|  Triggers: webhook_trigger (POST) + chat_trigger (n8n UI)             |
|  Orchestrator LLM: Gemini 2.5 Pro                                     |
|  Writing LLM: Claude Sonnet (all writing tools)                        |
|  Memory: Buffer Window (50 messages, daily session key)               |
|  Delivery: Email to eric@agileadtesting.com                           |
|  Storage: Supabase (bucket: author-content)                           |
|                                                                        |
|  TOOLS:                                                                |
|  +-----------------------+  +----------------------+                   |
|  | think (built-in)      |  | write_blog_post      |                  |
|  +-----------------------+  +----------------------+                   |
|  +-----------------------+  +----------------------+                   |
|  | write_newsletter      |  | write_short_story    |                  |
|  +-----------------------+  +----------------------+                   |
|  +-----------------------+  +----------------------+                   |
|  | write_chapter         |  | deep_research        |                  |
|  +-----------------------+  +----------------------+                   |
|  +-----------------------+  +----------------------+                   |
|  | manage_story_bible    |  | email_report (reuse) |
  |  +-----------------------+  +----------------------+                   |
  |  +-----------------------+  +----------------------+                   |
  |  | generate_cover_art    |                  |
|  +-----------------------+  +----------------------+                   |
|  +-----------------------+                                             |
|  | repurpose_to_social   |                                             |
|  +-----------------------+                                             |
+------------------------------------------------------------------------+
         |                              |
         v                              v
+--------------------+    +---------------------------+
| AI Scraping        |    | Content Ingestion         |
| Pipeline           |    | (Supabase -> Processing)  |
| (Scheduled)        |    |                           |
+--------------------+    +---------------------------+
```

---

## 2. Genre Configuration

### Active Niches (Configurable)

The system is designed around three science fiction sub-genres. These are stored as **configuration data** in a Supabase table `genre_config` so new genres can be added without modifying workflows.

#### Supabase Table: `genre_config`

```sql
CREATE TABLE genre_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  genre_name TEXT NOT NULL,
  genre_slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  keywords TEXT[] NOT NULL,
  rss_feed_urls TEXT[] NOT NULL,
  source_urls TEXT[] NOT NULL,
  subreddit_names TEXT[] NOT NULL,
  goodreads_shelves TEXT[] NOT NULL,
  writing_guidelines TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

#### Seed Data

**Niche 1: Post-Apocalyptic Science Fiction**
```json
{
  "genre_name": "Post-Apocalyptic Science Fiction",
  "genre_slug": "post-apocalyptic",
  "description": "Stories set after civilization-ending events — nuclear war, pandemics, environmental collapse, AI uprising. Focus on survival, rebuilding, and what it means to be human when everything is stripped away.",
  "keywords": ["post-apocalyptic", "dystopian", "survival", "wasteland", "collapse", "rebuilding", "extinction", "fallout", "plague", "aftermath"],
  "rss_feed_urls": [
    "https://medium.com/feed/tag/post-apocalyptic",
    "https://medium.com/feed/tag/dystopian",
    "https://medium.com/feed/tag/apocalypse",
    "https://clarkesworldmagazine.com/feed/",
    "https://escapepod.org/feed/",
    "https://www.strangehorizons.com/feed/",
    "https://www.risingshadow.net/rss/?genre=post-apocalyptic",
    "https://dystopic.co.uk/feed/"
  ],
  "source_urls": [
    "https://www.reddit.com/r/PostApocalypticFiction/",
    "https://www.reddit.com/r/printSF/",
    "https://www.goodreads.com/shelf/show/post-apocalyptic"
  ],
  "subreddit_names": ["PostApocalypticFiction", "postapocalyptic", "printSF", "apocalypse"],
  "goodreads_shelves": ["post-apocalyptic", "dystopian", "survival-fiction"],
  "writing_guidelines": "Tone: gritty, visceral, intimate. World-building through scarcity and decay. Characters defined by what they've lost. Technology either absent or repurposed. Nature reclaiming. Hope is earned, never given. Reference works: The Road (McCarthy), Station Eleven (Mandel), The Book of the New Sun (Wolfe), A Canticle for Leibowitz (Miller)."
}
```

**Niche 2: Political Science Fiction**
```json
{
  "genre_name": "Political Science Fiction",
  "genre_slug": "political-scifi",
  "description": "Fiction exploring governance, power structures, propaganda, revolution, and ideological conflict through speculative settings. The technology is backdrop; the politics are the story.",
  "keywords": ["political", "governance", "revolution", "propaganda", "empire", "republic", "ideology", "totalitarian", "democracy", "insurgency", "diplomacy"],
  "rss_feed_urls": [
    "https://medium.com/feed/tag/political-fiction",
    "https://medium.com/feed/tag/dystopian",
    "https://clarkesworldmagazine.com/feed/",
    "https://escapepod.org/feed/",
    "https://www.strangehorizons.com/feed/",
    "https://dystopic.co.uk/feed/",
    "https://locusmag.com/feed/",
    "https://reactormag.com/feed/"
  ],
  "source_urls": [
    "https://www.reddit.com/r/printSF/",
    "https://www.reddit.com/r/scifi/",
    "https://www.goodreads.com/shelf/show/political-science-fiction"
  ],
  "subreddit_names": ["printSF", "scifi"],
  "goodreads_shelves": ["political-science-fiction", "political-thriller-sci-fi"],
  "writing_guidelines": "Tone: cerebral, tense, morally ambiguous. Multiple factions with legitimate grievances. No clear villains — only competing interests. Power corrupts subtly. Dialogue-heavy with subtext. Bureaucracy as weapon. Reference works: Dune (Herbert), The Left Hand of Darkness (Le Guin), The Expanse (Corey), Foundation (Asimov), 1984 (Orwell)."
}
```

**Niche 3: Historical Time Travel**
```json
{
  "genre_name": "Historical Time Travel",
  "genre_slug": "historical-time-travel",
  "description": "Stories involving travel to real historical periods with consequences for altering the timeline. Blends historical fiction research rigor with speculative mechanics.",
  "keywords": ["time travel", "historical", "timeline", "paradox", "alternate history", "temporal", "anachronism", "causality", "butterfly effect"],
  "rss_feed_urls": [
    "https://medium.com/feed/tag/time-travel",
    "https://medium.com/feed/tag/alternate-history",
    "https://medium.com/feed/tag/historical-fiction",
    "https://clarkesworldmagazine.com/feed/",
    "https://escapepod.org/feed/",
    "https://www.strangehorizons.com/feed/",
    "https://locusmag.com/feed/",
    "https://reactormag.com/feed/"
  ],
  "source_urls": [
    "https://www.reddit.com/r/timetravel/",
    "https://www.reddit.com/r/AlternateHistory/",
    "https://www.goodreads.com/shelf/show/time-travel-fiction"
  ],
  "subreddit_names": ["timetravel", "AlternateHistory", "timetravelbooks", "printSF"],
  "goodreads_shelves": ["time-travel", "time-travel-fiction", "alternate-history"],
  "writing_guidelines": "Tone: meticulous, wonder-infused, stakes-aware. Historical accuracy is non-negotiable — research every detail. Fish-out-of-water tension. Paradox as narrative engine. The past resists change. Language adapts to period without being unreadable. Reference works: 11/22/63 (King), The Doomsday Book (Willis), Kindred (Butler), Timeline (Crichton), The Time Traveler's Wife (Niffenegger)."
}
```

### Adding a New Genre
Insert a new row into `genre_config` with `active: true`. The scraping pipeline and writing tools automatically pick up new genres from this table.

---

## 3. Data Pipeline: Scraping & Storage

### Storage: Supabase

**Replaces:** AWS S3 `data-ingestion` bucket from marketing agent

#### Supabase Bucket: `author-content`

```
author-content/
  ├── {date}/
  │   ├── post-apocalyptic/
  │   │   ├── reddit_{post_id}.json
  │   │   ├── article_{hash}.md
  │   │   └── book_{isbn}.json
  │   ├── political-scifi/
  │   │   ├── reddit_{post_id}.json
  │   │   ├── article_{hash}.md
  │   │   └── book_{isbn}.json
  │   └── historical-time-travel/
  │       ├── reddit_{post_id}.json
  │       ├── article_{hash}.md
  │       └── book_{isbn}.json
  ├── drafts/
  │   ├── blog_{title_slug}_{date}.md
  │   ├── story_{title_slug}_{date}.md
  │   └── chapter_{book_slug}_{chapter_num}_{date}.md
  └── writing-samples/
      ├── {user_id}/
      │   ├── sample_1.md
      │   ├── sample_2.md
      │   └── ...
```

#### Supabase Tables

```sql
-- Scraped content index
CREATE TABLE content_index (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  genre_slug TEXT NOT NULL REFERENCES genre_config(genre_slug),
  source_type TEXT NOT NULL, -- 'rss', 'reddit', 'google_books', 'open_library'
  feed_name TEXT, -- e.g. 'Clarkesworld', 'Medium/post-apocalyptic', 'r/printSF'
  source_url TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  content_path TEXT NOT NULL, -- path in Supabase storage
  scraped_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}'
);

-- Writing projects tracker
CREATE TABLE writing_projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_type TEXT NOT NULL, -- 'blog', 'newsletter', 'short_story', 'book'
  title TEXT NOT NULL,
  genre_slug TEXT REFERENCES genre_config(genre_slug),
  status TEXT DEFAULT 'draft', -- 'draft', 'in_progress', 'review', 'complete'
  outline JSONB,
  chapter_count INTEGER DEFAULT 0,
  draft_path TEXT, -- path in Supabase storage
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Content usage tracking (provenance: what source content was used in which output)
CREATE TABLE content_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content_id UUID REFERENCES content_index(id),
  output_type TEXT NOT NULL, -- 'newsletter', 'blog', 'short_story', 'book_chapter'
  output_title TEXT NOT NULL,
  output_date DATE DEFAULT CURRENT_DATE,
  project_id UUID REFERENCES writing_projects(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Story bible (continuity tracking for book projects)
CREATE TABLE story_bible (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES writing_projects(id),
  entry_type TEXT NOT NULL, -- 'character', 'event', 'location', 'timeline', 'plot_thread', 'world_rule'
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB DEFAULT '{}', -- flexible: aliases, relationships, chapter_introduced, status, etc.
  chapter_introduced INTEGER,
  last_chapter_seen INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_story_bible_project ON story_bible(project_id);
CREATE INDEX idx_story_bible_type ON story_bible(project_id, entry_type);

-- Content metrics view (aggregate reporting on source usage)
CREATE VIEW content_metrics AS
SELECT
  ci.genre_slug,
  ci.source_type,
  ci.feed_name,
  DATE(ci.scraped_at) AS scrape_date,
  COUNT(*) AS items_collected,
  COUNT(cu.id) AS items_used,
  ROUND(COUNT(cu.id)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS usage_rate_pct
FROM content_index ci
LEFT JOIN content_usage cu ON ci.id = cu.content_id
GROUP BY ci.genre_slug, ci.source_type, ci.feed_name, DATE(ci.scraped_at)
ORDER BY scrape_date DESC, genre_slug, source_type;
```

---

## 4. API Tools Reference

### Scraping & Data Capture APIs

> **RSS Feed URLs** for each genre are stored in the `genre_config.rss_feed_urls` column. The complete verified feed list with test results is in [`rss_feeds.md`](rss_feeds.md).

| API | Purpose | Free Tier | n8n Node | Auth |
|-----|---------|-----------|----------|------|
| **RSS Feeds** | Genre-specific blog posts, short fiction excerpts, book releases, industry news | Unlimited | rssFeedRead | None |
| **Reddit JSON API** | Scrape subreddit posts, comments, trends | Unlimited (rate limited) | httpRequest | None (append `.json` to any Reddit URL) |
| **Google Books API** | Book metadata, descriptions, genre classification | 1000 req/day | httpRequest | API Key |
| **Open Library API** | Book data, covers, ISBNs, subjects | Unlimited | httpRequest | None |
| **Apify Goodreads Scraper** | Book reviews, ratings, shelves, recommendations | 5 runs/month (free) | httpRequest | API Token |
| **Perplexity Sonar** | Deep research on any topic | Per-token pricing | perplexityTool | API Key |
| **Jina Reader API** | Extract clean text from any URL | 1000 req/day | httpRequest | API Key |
| **Firecrawl** | Web scraping with LLM-ready output | 500 pages/month | httpRequest | API Key |

### Storage & Database

| Service | Purpose | n8n Node |
|---------|---------|----------|
| **Supabase Storage** | File storage (replacing S3) | httpRequest (REST API) |
| **Supabase Database** | Genre config, content index, project tracking | supabase (built-in node) |
| **Supabase Vector Store** | RAG for research context | vectorStoreSupabase (LangChain node) |

### Content Delivery

| Service | Purpose | n8n Node |
|---------|---------|----------|
| **Gmail** | Email delivery of all content | gmail |
| **Markdown → HTML** | Format conversion | markdown |

### API Endpoint Details

**Reddit JSON API:**
```
GET https://www.reddit.com/r/{subreddit}/hot.json?limit=25
GET https://www.reddit.com/r/{subreddit}/search.json?q={keyword}&sort=relevance&t=week
Headers: User-Agent: "AuthorAgent/1.0"
```

**Google Books API:**
```
GET https://www.googleapis.com/books/v1/volumes?q=subject:science+fiction+{keyword}&maxResults=10&key={API_KEY}
```

**Open Library Search API:**
```
GET https://openlibrary.org/search.json?subject=science_fiction&q={keyword}&limit=10
```

**Jina Reader API:**
```
GET https://r.jina.ai/{url}
Headers: Authorization: Bearer {API_KEY}
Returns: Clean markdown text of the page
```

**Supabase Storage REST API:**
```
POST https://{project}.supabase.co/storage/v1/object/author-content/{path}
Headers: Authorization: Bearer {SUPABASE_KEY}, Content-Type: application/octet-stream
Body: file content

GET https://{project}.supabase.co/storage/v1/object/public/author-content/{path}
```

**Supabase Database REST API:**
```
GET https://{project}.supabase.co/rest/v1/genre_config?active=eq.true
Headers: apikey: {SUPABASE_KEY}, Authorization: Bearer {SUPABASE_KEY}
```

---

## 5. Workflow Specifications

---

### 5.1 Hub: The Author Agent

**Replaces:** The Recap AI - Marketing Team Agent (sYFuDciMUonqrkqh)
**Changes:** New system prompt, new tool set, email delivery, Supabase storage, writing-focused

#### Nodes (16 nodes)

| # | Node Name | Type | TypeVersion | Position | Parameters |
|---|-----------|------|-------------|----------|-----------|
| 1 | webhook_trigger | n8n-nodes-base.webhook | 2 | [0, 192] | httpMethod: POST; path: `author-agent-{generate-uuid}`; options: {} |
| 2 | chat_trigger | @n8n/n8n-nodes-langchain.chatTrigger | 1.1 | [0, 0] | For n8n UI testing |
| 3 | Author Agent | @n8n/n8n-nodes-langchain.agent | 2.1 | [336, 192] | promptType: define; text: `={{ $json.chatInput ?? $json.body.user_message_request }}` |
| 4 | gemini-2.5-pro | @n8n/n8n-nodes-langchain.lmChatGoogleGemini | 1 | [-416, 640] | modelName: `models/gemini-2.5-pro` |
| 5 | memory | @n8n/n8n-nodes-langchain.memoryBufferWindow | 1.3 | [-288, 640] | sessionIdType: customKey; sessionKey: `author-agent-{{ $now.format('yyyy-MM-dd') }}-1`; contextWindowLength: 50 |
| 6 | think | @n8n/n8n-nodes-langchain.toolThink | 1 | [-160, 640] | Built-in strategic planning |
| 7 | write_blog_post | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [64, 640] | See Workflow 5.4 |
| 8 | write_newsletter | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [224, 640] | See Workflow 5.5 |
| 9 | write_short_story | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [400, 640] | See Workflow 5.6 |
| 10 | write_chapter | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [576, 640] | See Workflow 5.7 |
| 11 | manage_story_bible | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [736, 640] | See Workflow 5.7b |
| 12 | deep_research | n8n-nodes-base.perplexityTool | 1 | [896, 640] | model: sonar-reasoning |
| 13 | email_report | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [1056, 640] | See Workflow 5.9 (reuse) |
| 14 | generate_cover_art | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [1216, 640] | See Workflow 5.10 |
| 15 | repurpose_to_social | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [1376, 640] | See Workflow 5.11 |
| 16 | no_operation | n8n-nodes-base.noOp | 1 | [816, 192] | Terminal |

#### Connections
```
webhook_trigger ──[main]──> Author Agent
chat_trigger ──[main]──> Author Agent
gemini-2.5-pro ──[ai_languageModel]──> Author Agent
memory ──[ai_memory]──> Author Agent
think ──[ai_tool]──> Author Agent
write_blog_post ──[ai_tool]──> Author Agent
write_newsletter ──[ai_tool]──> Author Agent
write_short_story ──[ai_tool]──> Author Agent
write_chapter ──[ai_tool]──> Author Agent
manage_story_bible ──[ai_tool]──> Author Agent
deep_research ──[ai_tool]──> Author Agent
email_report ──[ai_tool]──> Author Agent
generate_cover_art ──[ai_tool]──> Author Agent
repurpose_to_social ──[ai_tool]──> Author Agent
Author Agent ──[main]──> no_operation
```

#### System Prompt

```
# 1. Core Identity
You are **The Author Agent**, the backend intelligence for Eve — an expert AI author and researcher specializing in science fiction. You serve as an intelligent collaborator for producing world-class written content.

# 2. Primary Purpose
Execute writing and research tasks by routing requests to your specialized tools. You produce: blog posts, newsletters, short stories, long-form fiction/book chapters, and deep research reports.

# 3. Genre Expertise
You specialize in three science fiction niches:
- **Post-Apocalyptic SF**: Survival, rebuilding, civilization collapse (The Road, Station Eleven, A Canticle for Leibowitz)
- **Political SF**: Governance, revolution, ideological conflict (Dune, Foundation, The Expanse, 1984)
- **Historical Time Travel**: Real historical periods, timeline consequences, paradox (11/22/63, Kindred, The Doomsday Book)

When the user doesn't specify a genre, ask which niche they want or infer from context.

# 4. Tool Arsenal

## Planning
- **`think`**: Use for complex tasks requiring multi-step planning. Always think before writing long-form content.

## Writing Tools
- **`write_blog_post`**: Blog posts with SEO awareness. Inputs: topic, genre_slug, tone, audience, length, keywords, research_topics.
- **`write_newsletter`**: Newsletters on sci-fi topics. Inputs: topic, genre_slug, date.
- **`write_short_story`**: Short fiction (1000-10000 words). Inputs: genre_slug, premise, tone, length, style_references, research_topics. Includes Perplexity research + style matching from user writing samples.
- **`write_chapter`**: Book chapters with story bible continuity. Inputs: genre_slug, project_title, chapter_number, brief, outline, research_topics. Automatically loads story bible for continuity and updates it after writing.

## Research & Knowledge
- **`deep_research`**: Perplexity deep research on any topic. Use for factual grounding, historical research, genre analysis.
- **`manage_story_bible`**: Read/write the story bible for a book project. Inputs: operation (get/update), project_id, entries[]. Use to load context before brainstorming and to save state after chapter completion.

## Delivery
- **`email_report`**: Sends completed content via email. Inputs: markdownContent, subjectLine. Always email after completing a writing task.

## Media
- **`generate_cover_art`**: Generates cover art / illustrations. Inputs: imageTitle, imageContext, genre_slug.
- **`repurpose_to_social`**: Converts content to social media posts. Inputs: content, platform.

# 5. Workflow Rules
- Always call the appropriate tool IMMEDIATELY — do not delay.
- For blog posts and newsletters: research first if the topic requires factual accuracy.
- For fiction: use `think` first to plan story structure, identify research topics, then call the writing tool with `research_topics`.
- For short stories: identify 2-5 research topics from the premise (science, history, culture, geography) and pass them to `write_short_story`. The tool will research these via Perplexity before writing.
- For book projects:
  1. **Brainstorming**: When user gives a topic, brainstorm premises, themes, character concepts, conflicts directly in conversation using `think`.
  2. **Outlining**: Generate chapter-by-chapter outline with arc structure. Iterate with user until approved.
  3. **Research topics**: For each chapter, use `think` to identify research topics (historical periods, scientific concepts, cultural details). Pass these as `research_topics` when calling `write_chapter`.
  4. **Story bible**: Use `manage_story_bible` to load context before brainstorming and to save updated entries after chapter completion.
  5. **Writing**: When user says "write chapter N", call `write_chapter` with the agreed outline + research_topics. The tool handles story bible continuity automatically.
- ALWAYS email the finished content after writing it.
- Act as if YOU are doing the work — never mention tools or backend systems.

# 6. Environment
Today's date is: {{ $now.format('yyyy-MM-dd') }}
Delivery email: eric@agileadtesting.com
```

---

### 5.2 Data: AI Scraping Pipeline

**New workflow — no marketing equivalent**

**Purpose:** Scheduled daily scraper that collects sci-fi content from RSS feeds, Reddit JSON API, Google Books, Open Library, and article URLs via Jina Reader, then stores it in Supabase.

> **Feed Source:** All RSS feed URLs and Reddit subreddits are defined in [`rss_feeds.md`](rss_feeds.md). Use that file as the canonical source list when configuring scraping nodes.

#### Nodes (22 nodes)

| # | Node Name | Type | TypeVersion | Parameters |
|---|-----------|------|-------------|-----------|
| 1 | schedule_trigger | scheduleTrigger | 1.2 | rule: every day at 06:00 UTC |
| 2 | get_active_genres | supabase | 1 | table: genre_config; filter: active = true; operation: getAll |
| 3 | split_genres | splitOut | 1 | fieldToSplitOut: items |
| 4 | iterate_genres | splitInBatches | 3 | batchSize: 1 |
| 5 | set_genre_context | set | 3.4 | Extract: genre_slug, keywords, subreddit_names, rss_feed_urls, source_urls, goodreads_shelves |
| 6 | iterate_rss_feeds | splitInBatches | 3 | batchSize: 1; field: rss_feed_urls |
| 7 | scrape_rss_feed | rssFeedRead | 1 | URL: `{{ $json.feed_url }}`; output: items (title, link, content, pubDate) |
| 8 | filter_rss_recent | filter | 2.2 | Filter: pubDate within last 7 days |
| 9 | prepare_rss_content | set | 3.4 | Map: title, link, content_snippet (excerpt), pubDate, source_type: 'rss' |
| 10 | iterate_rss_next | set | 3.4 | Loop back to iterate_rss_feeds |
| 11 | scrape_reddit | httpRequest | 4.2 | URL: `https://www.reddit.com/r/{{ $json.subreddit_names[0] }}/hot.json?limit=25`; Headers: User-Agent: AuthorAgent/1.0 |
| 12 | filter_reddit_posts | filter | 2.2 | Filter: score > 10, not stickied |
| 13 | prepare_reddit_content | set | 3.4 | Map: title, selftext, url, score, author, created_utc, permalink |
| 14 | scrape_google_books | httpRequest | 4.2 | URL: `https://www.googleapis.com/books/v1/volumes?q=subject:science+fiction+{{ $json.keywords[0] }}&maxResults=10&orderBy=newest&key={GOOGLE_BOOKS_API_KEY}` |
| 15 | prepare_book_data | set | 3.4 | Map: title, authors, description, publishedDate, categories, imageLinks, infoLink |
| 16 | scrape_open_library | httpRequest | 4.2 | URL: `https://openlibrary.org/search.json?subject=science_fiction&q={{ $json.keywords[0] }}&limit=10&sort=new` |
| 17 | prepare_open_library_data | set | 3.4 | Map: title, author_name, first_publish_year, subject, cover_i, key |
| 18 | aggregate_all_content | aggregate | 1 | aggregateAllItemData |
| 19 | upload_to_supabase | httpRequest | 4.2 | POST to Supabase Storage REST API; path: `author-content/{date}/{genre_slug}/` |
| 20 | index_content | supabase | 1 | table: content_index; operation: create; fields: genre_slug, source_type, source_url, title, summary, content_path |
| 21 | iterate_next | set | 3.4 | Loop back to iterate_genres |
| 22 | no_op_done | noOp | 1 | End of pipeline |

> **Note:** RSS feeds return excerpts with links — ideal for newsletter curation. For full article text when needed (e.g., deep research), pipe the link through Jina Reader: `https://r.jina.ai/{link}`.

#### Connections
```
schedule_trigger ──> get_active_genres ──> split_genres ──> iterate_genres
iterate_genres ──[next]──> set_genre_context
     ──> iterate_rss_feeds ──[next]──> scrape_rss_feed ──> filter_rss_recent
          ──> prepare_rss_content ──> iterate_rss_next ──> iterate_rss_feeds (loop)
     iterate_rss_feeds ──[done]──>
     ──> scrape_reddit ──> filter_reddit_posts ──> prepare_reddit_content
     ──> scrape_google_books ──> prepare_book_data
     ──> scrape_open_library ──> prepare_open_library_data
     ──> aggregate_all_content ──> upload_to_supabase ──> index_content
     ──> iterate_next ──> iterate_genres (loop)
iterate_genres ──[done]──> no_op_done
```

---

### 5.3 Data: Content Ingestion

**Replaces:** The S3 search/filter/download/extract pattern from Newsletter Agent and Short Form Script Generator

**Purpose:** Sub-workflow that retrieves and prepares content from Supabase for a given genre and date.

#### Nodes (8 nodes)

| # | Node Name | Type | TypeVersion | Parameters |
|---|-----------|------|-------------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger | 1.1 | Inputs: genre_slug, date (optional, defaults to today) |
| 2 | set_params | set | 3.4 | Set date default: `{{ $json.date ?? $now.format('yyyy-MM-dd') }}` |
| 3 | query_content_index | supabase | 1 | table: content_index; filter: genre_slug = {genre_slug}, scraped_at >= {date}; operation: getAll |
| 4 | filter_relevant | filter | 2.2 | Remove duplicates, low-quality entries |
| 5 | download_content | httpRequest | 4.2 | GET Supabase Storage: `https://{project}.supabase.co/storage/v1/object/public/author-content/{content_path}` |
| 6 | extract_text | extractFromFile | 1 | operation: text |
| 7 | prepare_content | set | 3.4 | Wrap with: title, source_type, source_url, genre_slug, content |
| 8 | aggregate_content | aggregate | 1 | aggregateAllItemData; output: combined_content |

#### Connections
```
workflow_trigger ──> set_params ──> query_content_index ──> filter_relevant
     ──> download_content ──> extract_text ──> prepare_content ──> aggregate_content
```

---

### 5.4 Tool: Write Blog Post

**New workflow**

**Purpose:** Generates a complete blog post with optional research, SEO optimization, and email delivery.

#### Tool Description (for hub agent)
```
Writes a complete blog post on a given topic within the specified sci-fi niche. Includes research for factual grounding, SEO-aware structure, and delivers the finished post via email. Use for informational content, opinion pieces, reviews, and genre analysis.
```

#### Tool Inputs (fromAI)
| Parameter | Description | Type |
|-----------|-------------|------|
| topic | The blog post topic or title | string |
| genre_slug | The sci-fi niche: post-apocalyptic, political-scifi, or historical-time-travel | string |
| tone | Writing tone (e.g., analytical, conversational, provocative) | string |
| audience | Target audience description | string |
| length | Approximate word count (default: 1500) | string |
| keywords | SEO keywords to incorporate | string |

#### Nodes (12 nodes)

| # | Node Name | Type | TypeVersion | Parameters |
|---|-----------|------|-------------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger | 1.1 | Receives all inputs above |
| 2 | get_genre_config | supabase | 1 | table: genre_config; filter: genre_slug = {genre_slug}; operation: getAll |
| 3 | get_recent_content | executeWorkflow | 1.2 | Calls Content Ingestion (5.3) with genre_slug |
| 4 | build_prompt | set | 3.4 | Constructs full blog writing prompt (see below) |
| 5 | research_topic | perplexityTool | 1 | model: sonar-reasoning; query built from topic + genre context |
| 6 | write_blog | chainLlm | 1.7 | Uses prompt from build_prompt + research context |
| 7 | claude-sonnet | lmChatAnthropic | 1.3 | model: `claude-sonnet-4-20250514` |
| 8 | blog_output_parser | outputParserStructured | 1.3 | Schema below |
| 9 | convert_to_html | markdown | 1 | Converts markdown body to HTML |
| 10 | save_draft | httpRequest | 4.2 | POST to Supabase Storage: `author-content/drafts/blog_{slug}_{date}.md` |
| 11 | send_email | gmail | 1 | to: eric@agileadtesting.com; subject: `Blog Draft: {title}`; body: HTML content |
| 12 | set_result | set | 3.4 | Returns confirmation with title and word count |

#### Output Schema
```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "meta_description": { "type": "string", "maxLength": 160 },
    "body": { "type": "string", "description": "Full blog post in markdown" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "word_count": { "type": "integer" }
  },
  "required": ["title", "meta_description", "body", "tags", "word_count"]
}
```

#### Blog Writing Prompt
```
You are a world-class science fiction author and blogger specializing in {{ genre_name }}.

## Genre Context
{{ writing_guidelines }}

## Research Context
{{ research_results }}

## Recent Content in This Niche
{{ recent_content_summary }}

## Assignment
Write a {{ length }}-word blog post on: {{ topic }}

## Requirements
- Tone: {{ tone }}
- Target audience: {{ audience }}
- Incorporate keywords naturally: {{ keywords }}
- Structure: Title, meta description (max 160 chars), introduction (hook the reader in 2 sentences), 3-5 main sections with subheadings, conclusion with call-to-action
- Include specific references to published sci-fi works in this niche
- Write with authority — you are an expert in this genre
- Use concrete examples, not abstract claims
- Every paragraph must advance the reader's understanding

## Output
Return structured JSON with: title, meta_description, body (full markdown), tags, word_count
```

#### Connections
```
workflow_trigger ──> get_genre_config ──> get_recent_content ──> build_prompt
     ──> research_topic ──> write_blog
claude-sonnet ──[ai_languageModel]──> write_blog
blog_output_parser ──[ai_outputParser]──> write_blog
write_blog ──> convert_to_html ──> save_draft ──> send_email ──> set_result
```

---

### 5.5 Tool: Write Newsletter

**Replaces:** Content - Newsletter Agent (9bRL84mzVsLwZlCa) — simplified from 91 nodes to ~14 nodes

**Changes from original:**
- Removed S3 ingestion (replaced with Supabase Content Ingestion sub-workflow)
- Removed Slack approval loops (Eve delivers directly)
- Removed tweet collection (not relevant for author)
- Kept multi-section structure and subject line generation
- Changed LLM from Gemini to Claude Sonnet
- Changed delivery from Slack to email

#### Tool Inputs (fromAI)
| Parameter | Description | Type |
|-----------|-------------|------|
| topic | Newsletter topic or theme | string |
| genre_slug | The sci-fi niche | string |
| date | Date context for the newsletter | string |

#### Nodes (14 nodes)

| # | Node Name | Type | TypeVersion | Parameters |
|---|-----------|------|-------------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger | 1.1 | Inputs: topic, genre_slug, date |
| 2 | get_genre_config | supabase | 1 | table: genre_config; filter: genre_slug |
| 3 | get_recent_content | executeWorkflow | 1.2 | Calls Content Ingestion (5.3) |
| 4 | research_topic | perplexityTool | 1 | model: sonar-reasoning; topic + genre research |
| 5 | build_newsletter_prompt | set | 3.4 | Full newsletter writing prompt with genre guidelines |
| 6 | write_newsletter | chainLlm | 1.7 | Generates complete newsletter |
| 7 | claude-sonnet | lmChatAnthropic | 1.3 | model: claude-sonnet-4-20250514 |
| 8 | newsletter_parser | outputParserStructured | 1.3 | Schema: subject_line, pre_header, intro, sections[], outro |
| 9 | newsletter_auto_parser | outputParserAutofixing | 1 | Uses claude-sonnet for fixing |
| 10 | set_full_newsletter | set | 3.4 | Assembles all sections into single markdown |
| 11 | convert_to_html | markdown | 1 | Markdown to HTML |
| 12 | save_draft | httpRequest | 4.2 | POST to Supabase: `author-content/drafts/newsletter_{date}.md` |
| 13 | send_email | gmail | 1 | to: eric@agileadtesting.com; subject: `Newsletter: {subject_line}` |
| 14 | set_result | set | 3.4 | Returns confirmation |

#### Connections
```
workflow_trigger ──> get_genre_config ──> get_recent_content ──> research_topic
     ──> build_newsletter_prompt ──> write_newsletter
claude-sonnet ──[ai_languageModel]──> write_newsletter
newsletter_parser ──> newsletter_auto_parser ──[ai_outputParser]──> write_newsletter
write_newsletter ──> set_full_newsletter ──> convert_to_html ──> save_draft ──> send_email ──> set_result
```

---

### 5.6 Tool: Write Short Story

**Repurposed from Newsletter Agent's iterative segment-writing pattern**

**Purpose:** Generate short fiction modeled after Medium stories + user's uploaded writing samples, grounded in Perplexity research on the story's topic. Uses iterative scene-by-scene generation for longer stories.

#### Tool Description (for hub agent)
```
Writes a short story (1000-10000 words) in the specified sci-fi niche. Researches the story's topics via Perplexity for factual grounding, analyzes user's writing samples for style matching, then writes scene-by-scene using an iterative pattern. Delivers the finished story via email.
```

#### Tool Inputs (fromAI)
| Parameter | Description | Type |
|-----------|-------------|------|
| genre_slug | The sci-fi niche | string |
| premise | Story premise or concept (1-3 sentences) | string |
| tone | Writing tone (gritty, literary, pulpy, cerebral, etc.) | string |
| length | Target word count (1000-10000) | string |
| style_references | Reference authors/works for style guidance | string |
| research_topics | Topics to research for factual grounding (e.g., "nuclear winter ecology, post-collapse governance") | string |

#### Nodes (16 nodes)

| # | Node Name | Type | TypeVersion | Parameters |
|---|-----------|------|-------------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger | 1.1 | Inputs above |
| 2 | get_genre_config | supabase | 1 | table: genre_config; filter: genre_slug |
| 3 | build_research_query | set | 3.4 | Constructs query: "Research for a {genre} short story about {premise}. Provide factual details about: {research_topics}" |
| 4 | research_topic | perplexityTool | 1 | model: sonar-reasoning; query from build_research_query |
| 5 | fetch_writing_samples | httpRequest | 4.2 | GET Supabase Storage: `author-content/writing-samples/{user_id}/` — list + download user's uploaded writing samples |
| 6 | style_analysis | chainLlm | 1.7 | Prompt: "Analyze these writing samples. Extract: voice, pacing, sentence structure, dialogue style, POV preference, favorite literary devices." |
| 7 | claude-sonnet-style | lmChatAnthropic | 1.3 | model: claude-sonnet-4-20250514 |
| 8 | get_recent_content | executeWorkflow | 1.2 | Calls Content Ingestion (5.3) — fetches Medium RSS excerpts for genre tone reference |
| 9 | plan_scenes | set | 3.4 | Build scene plan: divide story into 3-7 scenes based on length, each with brief + research context |
| 10 | iterate_scenes | splitInBatches | 3 | batchSize: 1; iterates over scene plan |
| 11 | write_scene | chainLlm | 1.7 | Writes one scene at a time with style + research + previous scenes as context |
| 12 | claude-sonnet-write | lmChatAnthropic | 1.3 | model: claude-sonnet-4-20250514; maxTokens: 8000 |
| 13 | aggregate_scenes | aggregate | 1 | Combines all written scenes into full story |
| 14 | set_full_story | set | 3.4 | Assembles: title, story_text, word_count, logline |
| 15 | save_draft | httpRequest | 4.2 | POST to Supabase: `author-content/drafts/story_{slug}_{date}.md` |
| 16 | send_email | gmail | 1 | to: eric@agileadtesting.com; subject: `Short Story Draft: {title}` |

#### Short Story Writing Prompt (per scene)
```
You are a world-class science fiction author writing scene {{ scene_number }} of {{ total_scenes }}.

## Genre
{{ genre_name }}: {{ description }}

## Genre Writing Guidelines
{{ writing_guidelines }}

## Research Findings (factual grounding)
{{ research_results }}

## Style Reference (match this voice)
{{ style_analysis_results }}

## Story Plan
- Premise: {{ premise }}
- Tone: {{ tone }}
- Target total length: {{ length }} words
- Style inspiration: {{ style_references }}

## Scene Brief
{{ scene_brief }}

## Previous Scenes
{{ previous_scenes_text }}

## Craft Requirements
- Open with a hook that places the reader inside the world immediately
- Show, don't tell — use sensory details, not exposition dumps
- Characters must want something specific and face meaningful obstacles
- Dialogue should reveal character and advance plot simultaneously
- Incorporate researched factual details naturally — never as exposition dumps
- Match the voice, pacing, and sentence structure from the style analysis
- Every scene must do at least two things (advance plot + reveal character, build world + create tension, etc.)
- Avoid: info dumps, purple prose, deus ex machina, passive voice in action scenes
- The story should work on two levels: surface plot + thematic resonance

## Output
Return the scene text in markdown. No JSON wrapping for individual scenes.
```

#### Connections
```
workflow_trigger ──> get_genre_config ──> build_research_query ──> research_topic
     ──> fetch_writing_samples ──> style_analysis
claude-sonnet-style ──[ai_languageModel]──> style_analysis
     ──> get_recent_content ──> plan_scenes ──> iterate_scenes
iterate_scenes ──[next]──> write_scene ──> iterate_scenes (loop)
claude-sonnet-write ──[ai_languageModel]──> write_scene
iterate_scenes ──[done]──> aggregate_scenes ──> set_full_story ──> save_draft ──> send_email
```

---

### 5.7 Tool: Write Chapter

**New workflow — writes a single book chapter with story bible continuity and Perplexity research**

**Purpose:** Write a single book chapter with full continuity from the story bible, grounded in Perplexity research on chapter-specific topics. Called when user says "write chapter N" after brainstorming/outlining in conversation.

#### Tool Description (for hub agent)
```
Writes a single book chapter with full story bible continuity. Automatically loads the project's story bible (characters, events, locations, timeline), researches chapter-specific topics via Perplexity, matches user's writing style, then writes the chapter. Updates the story bible with new characters/events after writing. Delivers via email.
```

#### Tool Inputs (fromAI)
| Parameter | Description | Type |
|-----------|-------------|------|
| genre_slug | The sci-fi niche | string |
| project_title | Book/project title | string |
| chapter_number | Which chapter to write | string |
| brief | What should happen in this chapter | string |
| outline | Full book outline (JSON or text) | string |
| research_topics | Topics to research for this chapter (e.g., "Weimar Republic daily life, 1920s Berlin architecture") | string |

#### Nodes (16 nodes)

| # | Node Name | Type | TypeVersion | Parameters |
|---|-----------|------|-------------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger | 1.1 | Inputs above |
| 2 | get_genre_config | supabase | 1 | table: genre_config; filter: genre_slug |
| 3 | get_project | supabase | 1 | table: writing_projects; filter: title = project_title; upsert if not exists |
| 4 | fetch_story_bible | supabase | 1 | table: story_bible; filter: project_id; operation: getAll — loads characters, events, locations, timeline, plot threads |
| 5 | fetch_writing_samples | httpRequest | 4.2 | GET Supabase Storage: `author-content/writing-samples/{user_id}/` — for style matching |
| 6 | build_research_query | set | 3.4 | Constructs query from chapter outline + genre: "Research for chapter {N} of a {genre} novel. Provide factual details about: {research_topics}" |
| 7 | research_topic | perplexityTool | 1 | model: sonar-reasoning; query from build_research_query |
| 8 | build_chapter_prompt | set | 3.4 | Full chapter prompt with outline, story bible, style reference, **research findings** |
| 9 | write_chapter | chainLlm | 1.7 | High max_tokens |
| 10 | claude-sonnet | lmChatAnthropic | 1.3 | model: claude-sonnet-4-20250514; maxTokens: 16000 |
| 11 | chapter_parser | outputParserStructured | 1.3 | Schema: chapter_title, chapter_text, word_count, chapter_summary, next_chapter_notes, new_story_bible_entries[] |
| 12 | update_story_bible | supabase | 1 | table: story_bible; operation: upsert — new characters, events, plot threads from chapter_parser output |
| 13 | update_project | supabase | 1 | table: writing_projects; update chapter_count, status |
| 14 | save_draft | httpRequest | 4.2 | POST to Supabase: `author-content/drafts/chapter_{slug}_{num}_{date}.md` |
| 15 | send_email | gmail | 1 | to: eric@agileadtesting.com; subject: `{project_title} - Chapter {chapter_number}: {chapter_title}` |
| 16 | set_result | set | 3.4 | Returns chapter_title, word_count, chapter_summary, next_chapter_notes |

#### Chapter Writing Prompt
```
You are writing Chapter {{ chapter_number }} of "{{ project_title }}", a {{ genre_name }} novel.

## Genre Guidelines
{{ writing_guidelines }}

## Research Findings (factual grounding for this chapter)
{{ research_results }}

## Story Bible (continuity reference)
### Characters
{{ story_bible_characters }}

### Locations
{{ story_bible_locations }}

### Timeline
{{ story_bible_timeline }}

### Active Plot Threads
{{ story_bible_plot_threads }}

## Book Outline
{{ outline }}

## Previous Chapter Summaries
{{ previous_chapter_summaries }}

## This Chapter's Brief
{{ brief }}

## Style Reference (match this voice)
{{ style_analysis_results }}

## Craft Requirements
- Maintain consistent voice and tone from previous chapters
- Each chapter should have its own internal arc (mini-beginning, middle, end)
- End the chapter on a hook that compels the reader to continue
- Track character development — characters must grow or change
- Weave in foreshadowing for later plot points from the outline
- Incorporate researched factual details naturally — never as exposition dumps
- Vary sentence rhythm: short punchy lines for action, longer flowing ones for reflection
- Target: 3000-5000 words per chapter
- Include scene breaks (marked with ---) where appropriate

## Continuity Checklist
Before writing, verify against the story bible:
- Character names, descriptions, and relationships match previous chapters
- Timeline is consistent with established events
- Plot threads from previous chapters are acknowledged or advanced
- Setting details don't contradict established world-building
- New characters/events introduced here must be flagged in the output

## Output
Return JSON with: chapter_title, chapter_text (full chapter in markdown), word_count, chapter_summary (2-3 sentences for continuity tracking), next_chapter_notes (suggestions for what should happen next), new_story_bible_entries (array of {entry_type, name, description, metadata} for any new characters, events, locations, or plot threads introduced in this chapter)
```

#### Connections
```
workflow_trigger ──> get_genre_config ──> get_project ──> fetch_story_bible
     ──> fetch_writing_samples
     ──> build_research_query ──> research_topic
     ──> build_chapter_prompt ──> write_chapter
claude-sonnet ──[ai_languageModel]──> write_chapter
chapter_parser ──[ai_outputParser]──> write_chapter
write_chapter ──> update_story_bible ──> update_project ──> save_draft ──> send_email ──> set_result
```

---

### 5.7b Sub: Manage Story Bible

**New sub-workflow — called by hub agent to read/write story bible entries**

**Purpose:** Hub agent calls this to load story bible context before brainstorming and to save state after chapter completion or outline changes.

#### Tool Description (for hub agent)
```
Reads or writes the story bible for a book project. Use 'get' to load all characters, events, locations, timeline, and plot threads before brainstorming. Use 'update' to add or modify entries after outlining or chapter completion.
```

#### Tool Inputs (fromAI)
| Parameter | Description | Type |
|-----------|-------------|------|
| operation | 'get' to load full bible, 'update' to add/modify entries | string |
| project_title | Book/project title | string |
| entries | JSON array of {entry_type, name, description, metadata} — only for 'update' operation | string |

#### Nodes (6 nodes)

| # | Node Name | Type | TypeVersion | Parameters |
|---|-----------|------|-------------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger | 1.1 | Inputs above |
| 2 | get_project | supabase | 1 | table: writing_projects; filter: title = project_title |
| 3 | check_operation | if | 2.2 | Condition: operation == 'get' |
| 4 | get_story_bible | supabase | 1 | table: story_bible; filter: project_id; operation: getAll |
| 5 | update_story_bible | supabase | 1 | table: story_bible; operation: upsert; data from entries input |
| 6 | set_result | set | 3.4 | Returns story bible entries (for get) or confirmation (for update) |

#### Connections
```
workflow_trigger ──> get_project ──> check_operation
check_operation ──[true/get]──> get_story_bible ──> set_result
check_operation ──[false/update]──> update_story_bible ──> set_result
```

---

### 5.8 Tool: Deep Research

**Reuses:** Perplexity inline tool from Marketing Agent (identical pattern)

Configured directly in the hub agent as a `perplexityTool` node with model `sonar-reasoning`. No separate workflow needed.

---

### 5.9 Tool: Email Report

**Reuses:** Tool - Email Research Report (rhOHJp1zd1rABXiZ) — identical, only change email default

#### Changes from Original
- Default emailAddress: `eric@agileadtesting.com` (was `david@dlmholdings.com`)

#### Nodes (3 nodes — unchanged)
| # | Node | Type | Parameters |
|---|------|------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger | Inputs: markdownReportContent, emailAddress (default: eric@agileadtesting.com), subjectLine |
| 2 | convert_to_html | markdown | Markdown to HTML |
| 3 | send_email | gmail | Send HTML email |

---

### 5.10 Tool: Generate Cover Art

**Replaces:** Tool - Generate Image (DUrS3tXJA46Ov4sr)

#### Changes from Original
- Updated brand guidelines from "Recap AI watercolor" to sci-fi genre-appropriate art
- Added genre_slug input for genre-specific style
- Changed delivery from Slack to email

#### Tool Inputs (fromAI)
| Parameter | Description | Type |
|-----------|-------------|------|
| imageTitle | Title/name for the image | string |
| imageContext | What the image should depict | string |
| genre_slug | Sci-fi niche for style guidance | string |

#### Nodes (7 nodes)

| # | Node Name | Type | TypeVersion | Parameters |
|---|-----------|------|-------------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger | 1.1 | Inputs above |
| 2 | get_genre_config | supabase | 1 | table: genre_config; filter: genre_slug |
| 3 | set_art_guidelines | set | 3.4 | Genre-specific art direction (see below) |
| 4 | generate_image | httpRequest | 4.2 | POST `https://api.openai.com/v1/images/generations`; model: gpt-image-1; size: 1536x1024 |
| 5 | convert_to_png | convertToFile | 1 | Base64 to PNG |
| 6 | send_email_with_image | gmail | 1 | to: eric@agileadtesting.com; attachment: PNG; subject: `Cover Art: {imageTitle}` |
| 7 | set_result | set | 3.4 | Returns confirmation |

#### Art Direction by Genre
```
Post-Apocalyptic: Cinematic digital painting. Muted earth tones with toxic greens and ember oranges.
Crumbling infrastructure reclaimed by nature. Dramatic lighting through dust and haze.
Lone figures silhouetted against vast ruined landscapes. No text.

Political SF: Clean, geometric composition. Cold blues and institutional grays with strategic red accents.
Architecture of power — domes, corridors, council chambers. Figures in formation or confrontation.
Propaganda poster aesthetic blended with photorealism. No text.

Historical Time Travel: Split composition showing two eras. Warm sepia for historical elements,
cool modern tones for present/future. Visible temporal distortion at the boundary.
Period-accurate details. Anachronistic objects as focal points. No text.
```

---

### 5.11 Tool: Repurpose to Social Posts

**Replaces:** Tool - Repurpose Newsletter Into Twitter Daily News Thread (WM5AolpG5wHROgEF)

#### Changes from Original
- Multi-platform support (Twitter/X, LinkedIn, Instagram captions)
- Sci-fi content focused
- Email delivery instead of Slack

#### Tool Inputs (fromAI)
| Parameter | Description | Type |
|-----------|-------------|------|
| content | The content to repurpose | string |
| platform | Target platform: twitter, linkedin, instagram | string |

#### Nodes (8 nodes)

| # | Node Name | Type | TypeVersion | Parameters |
|---|-----------|------|-------------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger | 1.1 | Inputs above |
| 2 | set_platform_examples | set | 3.4 | Platform-specific examples and constraints |
| 3 | build_prompt | set | 3.4 | Repurposing prompt with platform rules |
| 4 | write_posts | chainLlm | 1.7 | Generates social content |
| 5 | claude-sonnet | lmChatAnthropic | 1.3 | model: claude-sonnet-4-20250514 |
| 6 | posts_parser | outputParserStructured | 1.3 | Schema: posts[] (array of {text, hashtags}) |
| 7 | send_email | gmail | 1 | to: eric@agileadtesting.com; subject: `Social Posts: {platform}` |
| 8 | set_result | set | 3.4 | Returns posts |

---

## 6. Changes from Marketing Agent

### Summary of All Changes

| Component | Marketing Agent (Before) | Author Agent (After) |
|-----------|-------------------------|---------------------|
| **Hub name** | The Recap AI - Marketing Team Agent | The Author Agent |
| **Voice agent** | Jarvis (marketing) | Eve (writing) |
| **Orchestrator LLM** | Gemini 2.5 Pro | Gemini 2.5 Pro (unchanged) |
| **Writing LLM** | Gemini 2.5 Pro (content) + Claude (fixing) | Claude Sonnet (all writing) |
| **Storage** | AWS S3 (`data-ingestion` bucket) | Supabase (`author-content` bucket + database) |
| **Content source** | AI news (markdown + tweets from S3) | Sci-fi content (Reddit, books, articles from web) |
| **Delivery** | Slack channels | Email (eric@agileadtesting.com) |
| **Approval loops** | Slack sendAndWait with editorial feedback | None (direct delivery) |
| **Genre system** | Single domain (AI/tech news) | Configurable genres via Supabase table |
| **Newsletter** | 91 nodes with S3 ingestion + Slack approval | ~14 nodes with Supabase + direct email |
| **Short form script** | Video scripts for TikTok/Reels | Removed (not relevant for author) |
| **Twitter thread** | Newsletter → Twitter | Content → Multi-platform social |
| **Image generation** | Watercolor brand art (Recap) | Genre-specific cover art (sci-fi) |
| **Avatar video** | HeyGen talking avatar | Removed (not relevant for author) |
| **Blog post** | Not available | New tool |
| **Short story** | Not available | New tool (with research + style matching + iterative scenes) |
| **Book chapters** | Not available | New tool (with story bible continuity + research) |
| **Story bible** | Not available | New sub-workflow for continuity tracking |
| **Research** | Perplexity (inline) | Perplexity (inline, unchanged) |
| **Email report** | Gmail (to david@dlmholdings.com) | Gmail (to eric@agileadtesting.com) |
| **Data scraping** | External pipeline (not documented) | Built-in scheduled scraper with Reddit, Google Books, Open Library, Jina |
| **Project tracking** | None | Supabase writing_projects table |
| **Content provenance** | None | content_usage table + content_metrics view |
| **Writing samples** | None | Supabase bucket for style matching |

### Workflows Removed
- Content - Short Form News Script Generator (replaced by writing tools)
- Tool - Generate Talking Avatar (not relevant)

### Workflows Reused (with modifications)
- Tool - Email Research Report (change default email)
- Tool - Generate Image → Tool - Generate Cover Art (new art direction)
- Tool - Repurpose Newsletter → Tool - Repurpose to Social (multi-platform)

### Workflows Created New
- The Author Agent (hub)
- AI Scraping Pipeline (scheduled data collection)
- Content Ingestion (Supabase retrieval sub-workflow)
- Tool - Write Blog Post
- Tool - Write Short Story (with research + style matching + iterative scenes)
- Tool - Write Chapter (with story bible + research)
- Sub - Manage Story Bible
- Tool - Write Newsletter (simplified)
