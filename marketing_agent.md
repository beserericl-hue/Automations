# The Recap AI - Marketing Team Agent: Complete System Documentation

## System Architecture Overview

The marketing agent system follows a **hub-and-spoke architecture** where a central orchestrator agent receives requests (via webhook from ElevenLabs voice agent "Jarvis" or via n8n chat) and routes them to specialized sub-workflows (tools).

```
                        ElevenLabs Voice Agent (Jarvis)
                                    |
                            POST /webhook
                                    |
                                    v
+-----------------------------------------------------------------------+
|                  THE RECAP AI - MARKETING TEAM AGENT (Hub)            |
|                         ID: sYFuDciMUonqrkqh                         |
|                         17 nodes | Inactive                           |
|                                                                       |
|  Triggers: webhook_trigger (POST) + chat_trigger (n8n UI)            |
|  LLM: Gemini 2.5 Pro (orchestration)                                |
|  Memory: Buffer Window (50 messages, daily session key)              |
|                                                                       |
|  Tools (Spokes):                                                     |
|  +------------------+  +------------------+  +---------------------+ |
|  | write_newsletter |  | generate_image   |  | repurpose_twitter   | |
|  | (sub-workflow)   |  | (sub-workflow)   |  | (sub-workflow)      | |
|  +------------------+  +------------------+  +---------------------+ |
|  +------------------+  +------------------+  +---------------------+ |
|  | short_form_script|  | talking_avatar   |  | deep_research_topic | |
|  | (sub-workflow)   |  | (sub-workflow)   |  | (Perplexity inline) | |
|  +------------------+  +------------------+  +---------------------+ |
|  +------------------+  +------------------+                          |
|  | email_report     |  | think            |                          |
|  | (sub-workflow)   |  | (built-in)       |                          |
|  +------------------+  +------------------+                          |
+-----------------------------------------------------------------------+
```

## Workflow Inventory

| # | Workflow Name | ID | Nodes | Status | Role |
|---|--------------|-----|-------|--------|------|
| 1 | The Recap AI - Marketing Team Agent | sYFuDciMUonqrkqh | 17 | Inactive | Hub orchestrator |
| 2 | Content - Newsletter Agent | 9bRL84mzVsLwZlCa | 91 | Inactive | Newsletter generation |
| 3 | Content - Short Form News Script Generator | QkuWs2z2CaDYlMpH | 45 | Inactive | Video script generation |
| 4 | Tool - Repurpose Newsletter Into Twitter Daily News Thread | WM5AolpG5wHROgEF | 8 | Inactive | Content repurposing |
| 5 | Tool - Generate Image | DUrS3tXJA46Ov4sr | 6 | Inactive | Image generation |
| 6 | Tool - Email Research Report | rhOHJp1zd1rABXiZ | 3 | Inactive | Email delivery |
| 7 | Tool - Generate Talking Avatar | dQFTLbGuORQIXWzh | 6 | Inactive | Avatar video generation |

**Total nodes across all workflows: 176**

---

## Workflow 1: The Recap AI - Marketing Team Agent (Hub)

**ID:** sYFuDciMUonqrkqh | **Nodes:** 17 | **Status:** Inactive

### Purpose
Central orchestrator that receives user requests and routes them to the appropriate tool workflow. Acts as the "brain" that decides what action to take based on the user's message.

### Nodes

| # | Node Name | Type | TypeVersion | Position | Purpose |
|---|-----------|------|-------------|----------|---------|
| 1 | webhook_trigger | n8n-nodes-base.webhook | 2 | [0, 192] | Receives POST requests from ElevenLabs; path: `c5edb92a-61f8-4b3d-91c6-cec0be46d052` |
| 2 | When chat message received | @n8n/n8n-nodes-langchain.chatTrigger | 1.1 | [0, 0] | n8n UI chat interface for testing |
| 3 | Marketing Agent | @n8n/n8n-nodes-langchain.agent | 2.1 | [336, 192] | LangChain agent node; reads `$json.chatInput ?? $json.body.user_message_request` |
| 4 | gemini-2.5-pro | @n8n/n8n-nodes-langchain.lmChatGoogleGemini | 1 | [-416, 640] | Model: `models/gemini-2.5-pro` |
| 5 | memory | @n8n/n8n-nodes-langchain.memoryBufferWindow | 1.3 | [-288, 640] | Session key: `marketing-agent-{date}-1`; context window: 50 messages |
| 6 | think | @n8n/n8n-nodes-langchain.toolThink | 1 | [-160, 640] | Strategic planning tool |
| 7 | write_newsletter | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [64, 640] | Calls Newsletter Agent; inputs: Date, Previous Newsletter Content |
| 8 | generate_image | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [224, 640] | Calls Generate Image; inputs: imageTitle, imageContext |
| 9 | repurpose_to_twitter_thread | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [400, 640] | Calls Twitter Thread tool; input: newsletterContent |
| 10 | repurpose_to_short_form_script | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [576, 640] | Calls Short Form Script; input: date |
| 11 | generate_talking_avatar_video | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [752, 640] | Calls Talking Avatar; input: script |
| 12 | deep_research_topic | n8n-nodes-base.perplexityTool | 1 | [1008, 640] | Perplexity sonar-reasoning; inline research tool |
| 13 | email_research_report | @n8n/n8n-nodes-langchain.toolWorkflow | 2.2 | [1200, 640] | Calls Email Report; inputs: markdownReportContent, emailAddress (david@dlmholdings.com), subjectLine |
| 14 | no_operation | n8n-nodes-base.noOp | 1 | [816, 192] | Terminal node |
| 15-17 | Sticky Notes | n8n-nodes-base.stickyNote | 1 | Various | Documentation: "Shared", "Content Creation", "Content Research" |

### Connections
```
webhook_trigger ──[main]──> Marketing Agent
When chat message received ──[main]──> Marketing Agent
gemini-2.5-pro ──[ai_languageModel]──> Marketing Agent
memory ──[ai_memory]──> Marketing Agent
think ──[ai_tool]──> Marketing Agent
write_newsletter ──[ai_tool]──> Marketing Agent
generate_image ──[ai_tool]──> Marketing Agent
repurpose_to_twitter_thread ──[ai_tool]──> Marketing Agent
repurpose_to_short_form_script ──[ai_tool]──> Marketing Agent
generate_talking_avatar_video ──[ai_tool]──> Marketing Agent
deep_research_topic ──[ai_tool]──> Marketing Agent
email_research_report ──[ai_tool]──> Marketing Agent
Marketing Agent ──[main]──> no_operation
```

### System Prompt (Abridged)
The Marketing Agent system prompt defines:
- **Identity:** Marketing Team AI Assistant for The Recap AI
- **Core Capabilities:** Content creation, strategic repurposing, multi-format adaptation
- **Tool Arsenal:** Descriptions and usage rules for each tool
- **Memory System:** Daily work memory with cross-tool integration
- **Environment:** Current date injected via `{{ $now.format('yyyy-MM-dd') }}`

---

## Workflow 2: Content - Newsletter Agent

**ID:** 9bRL84mzVsLwZlCa | **Nodes:** 91 | **Status:** Inactive

### Purpose
Generates a complete daily AI newsletter by ingesting content from S3 (markdown articles + tweets), selecting top stories via AI, getting editorial approval via Slack, writing each story section, generating subject lines, and assembling the final newsletter.

### Architecture Diagram
```
PHASE 1: CONTENT RETRIEVAL
form_trigger ──> set_input ──> search_markdown_objects ──> filter_only_markdown
workflow_trigger ─┘              ──> get_markdown_object_info ──> exclude_newsletters
                                 ──> download_markdown_object ──> get_markdown_file_content
                                 ──> prepare_markdown_content ──> aggregate_markdown_content
                                 ──> combine_markdown_content ──> search_tweets
                                                                  ──> check_any_results
                                                                  ├─[yes]─> download_tweet_objects
                                                                  │         ──> extract_tweets
                                                                  │         ──> get_tweet_object_info
                                                                  │         ──> prepare_tweet_content
                                                                  │         ──> aggregate_tweet_content
                                                                  │         ──> combine_tweet_content
                                                                  └─[no]──────────────────────┐
                                                                                               v
PHASE 2: STORY SELECTION                                                              stories_prompt
    pick_top_stories <──[ai_languageModel]── gemini-2.5-pro
         |            <──[ai_outputParser]── top_stories_auto_parser <── top_stories_parser
         v                                   <──[ai_languageModel]── claude-4-sonnet
    set_current_stories ──> share_selected_stories (Slack)
         ──> share_stories_reasoning (Slack)
         ──> share_stories_approval_feedback (Slack: sendAndWait)
         ──> extract_stories_approval_feedback
         ──> check_stories_feedback
              ├─[approved]──> subject_examples
              └─[revise]───> edit_top_stories ──> set_current_stories (loop)

PHASE 3: SUBJECT LINE
    subject_examples ──> set_subject_line_prompt ──> write_subject_line
         ──> set_current_subject_line ──> share_subject_line (Slack)
         ──> share_subject_line_reasoning (Slack)
         ──> share_subject_line_approval_feedback (Slack: sendAndWait)
         ──> extract_subject_line_approval_feedback
         ──> check_subject_line_feedback
              ├─[approved]──> set_selected_stories
              └─[revise]───> edit_subject_line ──> set_current_subject_line (loop)

PHASE 4: STORY WRITING (Per-Story Loop)
    set_selected_stories ──> split_stories ──> iterate_stories
         ├─[done]──> set_story_segments ──> aggregate_story_sections
         │                                  ──> set_combined_sections_content
         └─[next]──> set_current_segment ──> split_content_ids
              ──> get_segment_content_info ──> download_segment_content
              ──> filter_errors ──> get_segment_content_text
              ──> prepare_segment_content_item ──> aggregate_segment_text_content
              ──> check_external_urls
                   ├─[has urls]──> set_segment_external_source_links
                   │               ──> split_segment_external_source_urls
                   │               ──> scrape_segment_external_source_url (sub-workflow)
                   │               ──> filter_segment_external_source_errors
                   │               ──> aggregate_segment_external_source_content
                   └───────────────────────────────────────────────────────────┐
                                                                               v
              write_segment_content <──[ai]── gemini-2.5-pro
              ──> extract_image_urls <──[ai]── gemini-2.5-pro
              ──> share_segment_msg (Slack) ──> set_story_segment ──> iterate_stories (loop)

PHASE 5: ASSEMBLY
    set_combined_sections_content ──> write_intro <──[ai]── gemini-2.5-pro
         ──> write_other_top_stories <──[ai]── gemini-2.5-pro
         ──> set_full_newsletter ──> create_newsletter_file
         ──> upload_newsletter_file (Slack) ──> share_newsletter_msg (Slack)
         ──> set_final_result
```

### Key Configuration
- **S3 Bucket:** `data-ingestion`
- **S3 Prefix Pattern:** `{Date}/` (markdown), `{Date}/tweet.` (tweets)
- **External API:** `https://api.aitools.inc/admin/files/info/data-ingestion/`
- **Slack Channel:** `C08PGU0CLKS` (ai-tools-newsletter)
- **Primary LLM:** Gemini 2.5 Pro (`models/gemini-2.5-pro`)
- **Auto-fix LLM:** Claude Sonnet 4 (`claude-sonnet-4-20250514`)
- **Sub-workflow Dependency:** External URL scraper workflow

### Node Detail (91 nodes)

#### Trigger & Input (3 nodes)
| Node | Type | Parameters |
|------|------|-----------|
| workflow_trigger | executeWorkflowTrigger v1.1 | Receives: Date, Previous Newsletter Content |
| form_trigger | formTrigger v2.2 | Form fields: Date (date, required), Previous Newsletter Content (text) |
| set_input | set v3.4 | Normalizes input from either trigger |

#### S3 Content Retrieval - Markdown (8 nodes)
| Node | Type | Parameters |
|------|------|-----------|
| search_markdown_objects | s3 v1 | bucket: `data-ingestion`, operation: search, prefix: `{Date}/`, limit: 500 |
| filter_only_markdown | filter v2.2 | Key endsWith `.md` |
| get_markdown_object_info | httpRequest v4.2 | URL: `https://api.aitools.inc/admin/files/info/data-ingestion/{Key}`, auth: httpHeaderAuth |
| exclude_newsletters | filter v2.2 | metadata.type !== "newsletter" |
| download_markdown_object | s3 v1 | bucket: `data-ingestion`, operation: download |
| get_markdown_file_content | extractFromFile v1 | operation: text |
| prepare_markdown_content | set v3.4 | Wraps content with identifier, URL, type, source, authors, external URLs |
| aggregate_markdown_content | aggregate v1 | aggregateAllItemData |

#### S3 Content Retrieval - Tweets (7 nodes)
| Node | Type | Parameters |
|------|------|-----------|
| combine_markdown_content | set v3.4 | Maps to content_result field |
| search_tweets | s3 v1 | bucket: `data-ingestion`, prefix: `{Date}/tweet.`, limit: 500 |
| check_any_results | if v2.2 | Checks if tweet search returned results |
| download_tweet_objects | s3 v1 | bucket: `data-ingestion` |
| extract_tweets | extractFromFile v1 | operation: fromJson |
| get_tweet_object_info | httpRequest v4.2 | URL: `https://api.aitools.inc/admin/files/info/data-ingestion/{Key}` |
| prepare_tweet_content | set v3.4 | Formats tweet data |
| aggregate_tweet_content | aggregate v1 | aggregateAllItemData |
| combine_tweet_content | set v3.4 | Maps to content_result |

#### Story Selection (6 nodes)
| Node | Type | Parameters |
|------|------|-----------|
| stories_prompt | set v3.4 | 2000+ word prompt: Select 4 stories, analyze all sources, chain-of-thought reasoning, extract identifiers |
| pick_top_stories | chainLlm v1.5 | Uses gemini-2.5-pro; references stories_prompt |
| top_stories_parser | outputParserStructured v1.2 | Schema: top_selected_stories_chain_of_thought, top_selected_stories[]{title, summary, reason_for_selecting, identifiers[], external_source_links[]} |
| top_stories_auto_parser | outputParserAutofixing v1 | Uses claude-4-sonnet for fixing |
| set_current_stories | set v3.4 | Sets stories for editorial review |
| edit_top_stories | chainLlm v1.5 | Re-selects stories based on editorial feedback |

#### Editorial Approval Loop (5 nodes)
| Node | Type | Parameters |
|------|------|-----------|
| share_selected_stories | slack v2.3 | Channel: C08PGU0CLKS; posts stories with identifiers |
| share_stories_reasoning | slack v2.3 | Channel: C08PGU0CLKS; posts chain-of-thought in thread |
| share_stories_approval_feedback | slack v2.3 | Channel: C08PGU0CLKS; sendAndWait mode |
| extract_stories_approval_feedback | informationExtractor v1 | Uses gemini-2.5-pro |
| check_stories_feedback | if v2.2 | Routes: approved -> subject line, revise -> edit loop |

#### Subject Line Generation (8 nodes)
| Node | Type | Parameters |
|------|------|-----------|
| subject_examples | set v3.4 | 24 example subject lines (e.g., "AI finds cancers with 99% accuracy", "Claude (finally) searches the web") |
| set_subject_line_prompt | set v3.4 | Expert copywriter prompt: 7-9 word subject, 15-20 word pre-header with "PLUS:" format |
| write_subject_line | chainLlm v1.5 | Uses gemini-2.5-pro |
| subject_line_parser | outputParserStructured v1.2 | Schema: subject_line, pre_header_text, reasoning, additional_subject_lines[] |
| set_current_subject_line | set v3.4 | Sets for review |
| edit_subject_line | chainLlm v1.5 | Revision based on feedback |
| share_subject_line | slack v2.3 | Channel: C08PGU0CLKS |
| share_subject_line_reasoning | slack v2.3 | Channel: C08PGU0CLKS; thread reply |
| share_subject_line_approval_feedback | slack v2.3 | sendAndWait |
| extract_subject_line_approval_feedback | informationExtractor v1 | Uses gemini-2.5-pro |
| check_subject_line_feedback | if v2.2 | Routes: approved or revise |

#### Story Writing Loop (17 nodes)
| Node | Type | Parameters |
|------|------|-----------|
| set_selected_stories | set v3.4 | Prepares stories for iteration |
| split_stories | splitOut v1 | fieldToSplitOut: top_selected_stories |
| iterate_stories | splitInBatches v3 | Per-story batch processing |
| set_current_segment | set v3.4 | Current story segment |
| split_content_ids | splitOut v1 | Splits identifiers |
| get_segment_content_info | httpRequest v4.2 | Fetches content metadata from aitools.inc API |
| download_segment_content | s3 v1 | Downloads from data-ingestion bucket |
| filter_errors | filter v2.2 | Removes download failures |
| get_segment_content_text | extractFromFile v1 | Extracts text |
| prepare_segment_content_item | set v3.4 | Formats for aggregation |
| aggregate_segment_text_content | aggregate v1 | Combines segment text |
| check_external_urls | if v2.2 | Routes based on external_source_links presence |
| set_segment_external_source_links | set v3.4 | Extracts URLs |
| split_segment_external_source_urls | splitOut v1 | Parallelizes URL processing |
| scrape_segment_external_source_url | executeWorkflow v1.2 | Calls external scraper workflow |
| filter_segment_external_source_errors | filter v2.2 | Removes scrape failures |
| aggregate_segment_external_source_content | aggregate v1 | Combines scraped content |

#### Story Content Generation (6 nodes)
| Node | Type | Parameters |
|------|------|-----------|
| write_segment_content | chainLlm v1.5 | Writes newsletter section; uses gemini-2.5-pro |
| story_segment_output_parser | outputParserStructured v1.2 | Schema: newsletter_section_content |
| story_segment_auto_parser | outputParserAutofixing v1 | Uses claude-4-sonnet |
| extract_image_urls | chainLlm v1.6 | Extracts image URLs; uses gemini-2.5-pro |
| extract_image_urls_parser | outputParserStructured v1.2 | Schema: image_urls[] |
| image_urls_auto_parser | outputParserAutofixing v1 | Uses claude-4-sonnet |

#### Newsletter Assembly (10 nodes)
| Node | Type | Parameters |
|------|------|-----------|
| share_segment_msg | slack v2.3 | Channel: C08PGU0CLKS; shares each segment |
| set_story_segment | set v3.4 | Prepares for next iteration |
| set_story_segments | set v3.4 | Collects all segments |
| aggregate_story_sections | aggregate v1 | Combines all story sections |
| set_combined_sections_content | set v3.4 | Final combined content |
| write_intro | chainLlm v1.6 | Writes newsletter intro; gemini-2.5-pro |
| intro_parser / intro_auto_parser | outputParser + autofixing | Parses intro_content |
| write_other_top_stories | chainLlm v1.6 | Writes "other stories" section; gemini-2.5-pro |
| other_top_stories_parser / other_top_stories_auto_parser | outputParser + autofixing | Parses other stories |
| set_full_newsletter | set v3.4 | Combines intro + stories + other stories |
| create_newsletter_file | convertToFile v1.1 | Creates markdown file: `{date}.md` |
| upload_newsletter_file | slack v2.3 | Uploads file to Slack |
| share_newsletter_msg | slack v2.3 | Posts completion message |
| set_final_result | set v3.4 | Sets workflow output |

#### LLM Models (2 nodes)
| Node | Type | Model |
|------|------|-------|
| gemini-2.5-pro | lmChatGoogleGemini v1 | `models/gemini-2.5-pro` |
| claude-4-sonnet | lmChatAnthropic v1.2 | `claude-sonnet-4-20250514` |

---

## Workflow 3: Content - Short Form News Script Generator

**ID:** QkuWs2z2CaDYlMpH | **Nodes:** 45 | **Status:** Inactive

### Purpose
Generates short-form video scripts (50-60 seconds, 140-160 words) for AI news stories. Ingests content from S3, selects stories with hook angles optimized for virality, scrapes source URLs, and generates two scripts per story.

### Architecture Diagram
```
PHASE 1: CONTENT RETRIEVAL (Same pattern as Newsletter)
schedule_trigger ──> set_date ──> search_markdown_objects ──> filter_only_markdown
workflow_trigger ─┘              ──> get_markdown_object_info ──> exclude_newsletters
                                 ──> download_markdown_objects ──> get_markdown_file_content
                                 ──> prepare_markdown_content ──> aggregate_markdown_content
                                 ──> combine_markdown_content ──> search_tweets
                                 ──> download_tweet_objects ──> extract_tweets
                                 ──> get_tweet_object_info ──> prepare_tweet_content
                                 ──> aggregate_tweet_content ──> combine_tweet_content

PHASE 2: STORY CURATION
    combine_tweet_content ──> build_prompt ──> pick_stories (Claude Sonnet)
         ──> set_slack_channel_id ──> share_initial_msg (Slack)
         ──> set_stories ──> split_stories ──> iterate_stories

PHASE 3: PER-STORY SCRIPT GENERATION
    iterate_stories
         ├─[done]──> set_top_story_script
         └─[next]──> set_current_story ──> share_story (Slack)
              ──> set_source_urls ──> split_urls
              ──> scrape_url (sub-workflow) ──> filter_errors
              ──> aggregate_scrape_results ──> write_scripts (Claude Sonnet)
              ──> split_scripts ──> share_scripts (Slack)
              ──> aggregate_msgs ──> share_context (Slack)
              ──> iterate_stories (loop)
```

### Key Configuration
- **S3 Bucket:** `data-ingestion`
- **External API:** `https://api.aitools.inc/admin/files/info/data-ingestion/`
- **Slack Channel:** `C092UFCD8GL`
- **LLM:** Claude Sonnet 4 (`claude-sonnet-4-20250514`) for both story curation and script writing
- **Sub-workflow Dependency:** External URL scraper

### Hook Angle Framework
Stories are selected with typed hook angles:
- **Question** - Intriguing questions
- **Shock/Surprise** - Counterintuitive elements
- **Problem/Solution** - Common problem + AI solution
- **Before/After** - Transformation/comparison
- **Breaking News** - Urgency emphasis
- **Challenge/Test** - Try/challenge positioning
- **Conspiracy/Secret** - Insider knowledge framing
- **Personal Impact** - Direct viewer relevance

### Script Structure
Each script follows: Hook -> One-sentence explainer -> 5-7 wow-facts -> 2-3 importance sentences -> CTA

### Output Schema
```json
{
  "hook_options": ["string x5"],
  "top_scripts": [
    { "hook": "string", "script": "string (140-160 words)" },
    { "hook": "string", "script": "string (140-160 words)" }
  ]
}
```

---

## Workflow 4: Tool - Repurpose Newsletter Into Twitter Daily News Thread

**ID:** WM5AolpG5wHROgEF | **Nodes:** 8 | **Status:** Inactive

### Purpose
Converts daily newsletter content into a multi-tweet Twitter thread.

### Nodes
| # | Node | Type | Parameters |
|---|------|------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger v1.1 | Input: newsletterContent (string) |
| 2 | set_examples | set v3.4 | Three example Twitter threads for style reference |
| 3 | build_prompt | set v3.4 | Constructs prompt with newsletter + examples |
| 4 | write_twitter_thread | chainLlm v1.5 | Generates thread |
| 5 | claude-sonnet-4 | lmChatAnthropic v1.2 | Model: `claude-sonnet-4-20250514` |
| 6 | twitter_parser | outputParserStructured v1.2 | Schema: twitter_thread (JSON) |
| 7 | set_result | set v3.4 | Extracts result |
| 8 | share_twitter_thread | slack v2.3 | Channel: C08KC39K8DR |

### Connections
```
workflow_trigger ──> set_examples ──> build_prompt ──> write_twitter_thread ──> set_result ──> share_twitter_thread
claude-sonnet-4 ──[ai_languageModel]──> write_twitter_thread
twitter_parser ──[ai_outputParser]──> write_twitter_thread
```

---

## Workflow 5: Tool - Generate Image

**ID:** DUrS3tXJA46Ov4sr | **Nodes:** 6 | **Status:** Inactive

### Purpose
Generates watercolor-style images for newsletter content using OpenAI DALL-E with strict brand guidelines.

### Nodes
| # | Node | Type | Parameters |
|---|------|------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger v1.1 | Inputs: imageContext, imageTitle |
| 2 | set_brand_guidelines | set v3.4 | Detailed watercolor painting style: cold-press paper texture, layered transparent glazes, muted palette with strategic red accents, no text |
| 3 | generate_image | httpRequest v4.2 | POST `https://api.openai.com/v1/images/generations`, model: gpt-image-1, size: 1536x1024 |
| 4 | convert_to_png | convertToFile | Converts base64 to PNG |
| 5 | share_image | slack v2.3 | Posts to channel C08KC39K8DR with title |
| 6 | upload_image | slack v2.3 | Uploads PNG file to Slack |

### Connections
```
workflow_trigger ──> set_brand_guidelines ──> generate_image ──> convert_to_png ──> share_image ──> upload_image
```

---

## Workflow 6: Tool - Email Research Report

**ID:** rhOHJp1zd1rABXiZ | **Nodes:** 3 | **Status:** Inactive

### Purpose
Converts markdown research reports to HTML and sends via Gmail.

### Nodes
| # | Node | Type | Parameters |
|---|------|------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger v1.1 | Inputs: markdownReportContent, emailAddress, subjectLine |
| 2 | convert_to_html | markdown v1 | Converts markdown to HTML |
| 3 | send_email | gmail | Sends HTML email to specified address |

### Connections
```
workflow_trigger ──> convert_to_html ──> send_email
```

---

## Workflow 7: Tool - Generate Talking Avatar

**ID:** dQFTLbGuORQIXWzh | **Nodes:** 6 | **Status:** Inactive

### Purpose
Creates talking avatar videos using HeyGen API from text scripts.

### Nodes
| # | Node | Type | Parameters |
|---|------|------|-----------|
| 1 | workflow_trigger | executeWorkflowTrigger v1.1 | Input: script (string) |
| 2 | generate_avatar_video | httpRequest v4.2 | POST `https://api.heygen.com/v2/video/generate`; avatar: `2fcfd565e6c04285b970284703a06e2c`; voice: `0de91825d8ff42ab8e18a2e5778b9ad4`; dimension: 1080x1920; bg: green screen #008000 |
| 3 | wait | wait | Polling interval for video completion |
| 4 | get_video_status | httpRequest v4.2 | GET HeyGen API for video status |
| 5 | check_status | if v2.2 | Checks status === "completed" |
| 6 | share_avatar_video | slack v2.3 | Posts video URL to channel C08KC39K8DR |

### Connections
```
workflow_trigger ──> generate_avatar_video ──> wait ──> get_video_status ──> check_status
     ├─[completed]──> share_avatar_video
     └─[pending]───> wait (retry loop)
```

---

## Shared Infrastructure

### External Services
| Service | Purpose | Endpoint/Config |
|---------|---------|----------------|
| AWS S3 | Content storage | Bucket: `data-ingestion` |
| AITools API | File metadata | `https://api.aitools.inc/admin/files/info/` |
| Slack | Notifications & delivery | Channels: C08PGU0CLKS, C08KC39K8DR, C092UFCD8GL |
| OpenAI | Image generation | `https://api.openai.com/v1/images/generations` |
| HeyGen | Avatar video | `https://api.heygen.com/v2/video/generate` |
| Perplexity | Deep research | Model: sonar-reasoning |
| Gmail | Email delivery | OAuth2 |

### LLM Models Used
| Model | Provider | Used For |
|-------|----------|----------|
| Gemini 2.5 Pro | Google | Hub orchestration, newsletter content generation, story selection, subject lines |
| Claude Sonnet 4 | Anthropic | Output auto-fixing, short form scripts, Twitter threads |
| Perplexity Sonar Reasoning | Perplexity | Deep research |

### Common Patterns
1. **LangChain Chain + Output Parser + Auto-fixer**: Used throughout for structured LLM output with Claude as the fallback fixer
2. **S3 Search -> Filter -> Download -> Extract**: Standard content ingestion pattern
3. **Slack sendAndWait**: Human-in-the-loop approval pattern
4. **SplitInBatches iteration**: Per-item processing with loop-back
5. **Sub-workflow tools**: Specialized workflows called as LangChain tools from the hub agent
