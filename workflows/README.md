# Author Agent - n8n Workflows

This directory contains the n8n workflow JSON files for The Author Agent system.

## Workflows

| # | File | Description | Nodes |
|---|------|-------------|-------|
| 1 | 01_hub_the_author_agent.json | Main hub agent (Gemini 2.5 Pro orchestrator) | 16 |
| 2 | 02_tool_generate_cover_art.json | Generate genre-specific cover art via DALL-E | 6 |
| 3 | 03_tool_repurpose_social_posts.json | Repurpose content to Twitter/LinkedIn/Instagram | 8 |
| 4 | 04_tool_email_research_report.json | Send research reports via email | 3 |
| 5 | 05_data_content_ingestion.json | Sub-workflow to fetch content from Supabase | 7 |
| 6 | 06_data_ai_scraping_pipeline.json | Daily scheduled scraper (RSS, Reddit, Books) | 21 |
| 7 | 07_tool_write_blog_post.json | Write SEO-optimized blog posts | 12 |
| 8 | 08_tool_write_newsletter.json | Write genre-focused newsletters | 15 |
| 9 | 09_sub_manage_story_bible.json | Read/write story bible for book projects | 6 |
| 10 | 10_tool_write_short_story.json | Write short fiction with style matching | 16 |
| 11 | 11_tool_write_chapter.json | Write book chapters with continuity tracking | 16 |

## Installation Order

Install sub-workflows first, then the hub last (it references sub-workflow IDs):

1. 04 (Email Report) → 02 (Cover Art) → 03 (Social Posts)
2. 05 (Content Ingestion) → 06 (Scraping Pipeline)
3. 07 (Blog) → 08 (Newsletter) → 09 (Story Bible)
4. 10 (Short Story) → 11 (Chapter)
5. 01 (Hub) — update all toolWorkflow IDs to point to the new sub-workflow IDs
