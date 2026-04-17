# The Writers Workbench — Architectural Review & Improvement Plan

**Date:** 2026-04-11
**Role:** Independent Architect hired by customer
**Scope:** AI workflow model coverage, feature completeness, data architecture, image/asset management, UI functionality, and consolidated remediation task list

---

## Executive Summary

The Writers Workbench web UI covers approximately **40% of the capabilities** exposed by the underlying n8n AI workflow system. The architecture is sound but the implementation is incomplete. Critical subsystems — image management, token/cost tracking, content provenance, scheduled publishing, version history, and research report editing — exist in the backend but have no UI representation. The image generation pipeline produces cover art and social media images but treats them as ephemeral email attachments with zero persistence or retrieval capability. The application lacks a proper user roles system, has no content creation capabilities from the UI (all creation happens externally), and is missing delete operations across most entities.

This review identifies **43 architectural improvements** and consolidates them with the **127 deficiencies** from the quality audit into a prioritized **master task list of 89 discrete work items**.

---

## Part 1: AI Workflow Feature Coverage Gap Analysis

The n8n system exposes 18 tools through the hub agent. The web UI's coverage:

| AI Tool/Capability | Web UI Status | Gap |
|---|---|---|
| write_blog_post | Can trigger via chat only | No dedicated UI form |
| write_newsletter | Can trigger via chat only | No dedicated UI form |
| write_short_story | Can trigger via chat only | No dedicated UI form |
| write_chapter | Can trigger via chat only | No dedicated UI form |
| brainstorm_story | Can trigger via chat only | No brainstorm wizard UI |
| brainstorm_chapter | Can trigger via chat only | No chapter outline UI |
| deep_research | Can trigger via chat only | No research request form |
| generate_cover_art | Can trigger via chat only | **No image gallery, no persistence, no retrieval** |
| repurpose_to_social | Can trigger via chat only | **Placeholder page — zero functionality** |
| manage_story_bible | Read-only display | **No create/edit/delete** |
| manage_library | Partial (status changes only) | **No delete, no scheduled publishing date picker** |
| retrieve_content | Partial (list views) | Research reports not clickable |
| edit_outline | Not exposed | No outline editing UI |
| format_kindle_book | Export dialog exists | Doesn't use S3 template as specified |
| manage_research_reports | List-only | **No detail view, no edit, no delete** |
| eve_knowledge_callback | Eve orb exists | **Non-functional — no visible feedback** |
| email_report | Not exposed | No manual email trigger from UI |
| think | N/A (internal agent tool) | N/A |

### Recommendation: Content Creation Forms

The web UI should not require users to use the chat or Eve for every operation. High-frequency operations need dedicated UI forms:

1. **New Blog Post form** — topic, genre, keywords, target length → triggers write_blog_post via webhook
2. **New Research Request form** — topic, genre → triggers deep_research via webhook
3. **New Project Wizard** — title, genre, chapter count, story arc selection (with discovery question), premise → triggers brainstorm_story
4. **Generate Cover Art form** — content selection, genre, description override → triggers generate_cover_art
5. **Social Media Repurpose form** — select content, select platforms (multi-select: Twitter, LinkedIn, Instagram, Facebook) → triggers repurpose_to_social

These forms POST to the n8n webhook with structured parameters, same as the chat does but with a guided UI experience.

---

## Part 2: Image & Asset Management Architecture

### Current State: Images Are Ephemeral

The system generates professional cover art (via KIE.AI NanoBanana PRO) and social media images, but:
- Images are downloaded into workflow memory
- Attached to email delivery
- **Never saved to Supabase Storage**
- **Never tracked in the database**
- `published_content_v2.cover_image_path` column exists but is **never populated**
- Users cannot retrieve, view, or reuse previously generated images

### Required Architecture: Image Persistence Layer

#### New Database Table: `generated_images_v2`

```sql
CREATE TABLE generated_images_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  content_id UUID REFERENCES published_content_v2(id) ON DELETE SET NULL,
  project_id UUID REFERENCES writing_projects_v2(id) ON DELETE SET NULL,
  image_type TEXT NOT NULL CHECK (image_type IN ('cover_art', 'chapter_art', 'social_media', 'newsletter_section')),
  platform TEXT, -- 'twitter', 'linkedin', 'instagram', 'facebook', NULL for non-social
  storage_path TEXT NOT NULL, -- path in Supabase Storage bucket
  thumbnail_path TEXT, -- smaller version for gallery views
  original_prompt TEXT, -- the prompt sent to KIE.AI
  genre_slug TEXT,
  image_format TEXT DEFAULT 'png',
  width INTEGER,
  height INTEGER,
  file_size_bytes INTEGER,
  generation_model TEXT DEFAULT 'nano-banana-pro',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_generated_images_v2_user ON generated_images_v2(user_id);
CREATE INDEX idx_generated_images_v2_content ON generated_images_v2(content_id);
CREATE INDEX idx_generated_images_v2_project ON generated_images_v2(project_id);
CREATE INDEX idx_generated_images_v2_type ON generated_images_v2(user_id, image_type);
```

#### Supabase Storage Buckets Required

```
author-content/          (existing — text content, scraped batches)
cover-images/            (NEW — cover art for stories, chapters, blogs)
social-images/           (NEW — platform-specific social media images)
writing-samples/         (NEW — user-uploaded writing style samples)
```

#### Web UI: Cover Art & Image Gallery

The Cover Art page (currently a placeholder) should become:

1. **Gallery View** — grid of all `generated_images_v2` for the user, filterable by type/genre/project
2. **Image Detail** — full-size view, original prompt, linked content, regenerate button
3. **Generate New** — form to request new cover art (description, genre, content type)
4. **Assign to Content** — drag-and-drop or select to assign image as cover for a chapter/story/blog
5. **Download** — original resolution download

#### n8n Workflow Changes Required

The `generate_cover_art` workflow needs modification to:
1. After image generation, upload to Supabase Storage (`cover-images/{user_id}/{date}_{slug}.png`)
2. Insert row into `generated_images_v2` with storage path, prompt, dimensions
3. Update `published_content_v2.cover_image_path` if linked to specific content
4. Return the storage URL in the tool response (not just email)

---

## Part 3: Missing Data Subsystems in the Web UI

### 3.1 Token/Cost Tracking — Zero UI Exposure

The `token_usage_v2` table tracks every LLM call with model, token counts, and estimated cost. Pricing is embedded in the tracker workflow:

| Model | Input $/1M tokens | Output $/1M tokens |
|---|---|---|
| Claude Sonnet 4 | $3.00 | $15.00 |
| Gemini 2.5 Pro | $1.25 | $10.00 |
| Gemini 2.5 Flash | $0.15 | $0.60 |
| GPT-4o | $2.50 | $10.00 |
| Perplexity Sonar | $1.00 | $1.00 |

**Required UI:**
- **Cost Dashboard** — total spend by day/week/month, breakdown by model/workflow
- **Per-Project Cost** — how much each book/project has cost in AI tokens
- **Per-User Cost** (admin view) — spending by user for SaaS billing
- **Cost Alerts** — configurable thresholds

**Note:** The `token_usage_v2` table schema is NOT in `supabase_setup_v2.sql`. It exists in production (created by the workflow) but needs to be formalized in the schema and given proper RLS policies.

### 3.2 Content Provenance — Zero UI Exposure

`content_usage_v2` tracks which scraped sources (from `content_index`) were used to generate each piece of content. `content_metrics_v2` view shows collection vs. usage rates.

**Required UI:**
- **Sources Panel** on ContentDetail — "This chapter was informed by these 5 sources" with links
- **Metrics Dashboard** in Admin — content collection rates, usage rates by genre/source
- **Source Browser** — browse `content_index` entries by genre, see what's available for research

### 3.3 Scheduled Publishing — No Date Picker

The cron publisher (workflow 17) runs hourly and publishes content where `metadata.schedule_date <= now()`. The UI has a "scheduled" status but no way to set the date.

**Required UI:**
- **Schedule Button** with date/time picker on ContentDetail
- **Scheduled Content Calendar** — visual calendar showing upcoming publications
- **Unschedule** action to cancel

### 3.4 Q/A Consistency Reports — Not Displayed

Every chapter write generates a 9-check consistency report (character names, arc compliance, plot drift, etc.). This is emailed but not stored or displayed in the web UI.

**Required:**
- Store Q/A reports in `published_content_v2.metadata` or a new `qa_reports_v2` table
- Display Q/A results in ContentDetail as a collapsible panel
- Show PASS/NEEDS_REVIEW per check with details

### 3.5 Writing Sample Upload — Not Implemented

The system can style-match writing to uploaded samples, but the web UI has no file upload capability.

**Required UI:**
- **Upload** page in Settings — drag-and-drop .txt/.md/.docx files
- Store in `writing-samples/` Supabase Storage bucket
- Display uploaded samples with preview
- Link samples to genre preferences

---

## Part 4: Data Architecture Improvements

### 4.1 User Roles System

Current state: admin role stored in `preferences` JSONB, self-updatable by the user (security vulnerability).

**Required architecture:**

```sql
-- Add dedicated role column
ALTER TABLE users_v2 ADD COLUMN role TEXT NOT NULL DEFAULT 'user' 
  CHECK (role IN ('user', 'admin', 'editor', 'viewer'));

-- Restrict role updates to admins only
CREATE POLICY "Only admins can change roles" ON users_v2
  FOR UPDATE USING (
    supabase_auth_uid = auth.uid() 
    AND (
      -- Users can update their own row EXCEPT the role column
      -- This requires a trigger or column-level security
      true
    )
  );

-- Better: use a trigger to prevent role self-escalation
CREATE OR REPLACE FUNCTION prevent_role_escalation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role != OLD.role AND NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can change user roles';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_role_escalation
  BEFORE UPDATE ON users_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_role_escalation();
```

**Roles:**
- `user` — standard user, can manage own content
- `editor` — can review/approve other users' content (future)
- `admin` — full system access, user management, public genre/arc management
- `viewer` — read-only access (future, for reviewers/beta readers)

### 4.2 Soft Delete Architecture

No entity in the system supports soft delete. All deletes are permanent with cascade.

**Required:**

```sql
-- Add to all user-scoped tables:
ALTER TABLE writing_projects_v2 ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE published_content_v2 ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE research_reports_v2 ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE story_bible_v2 ADD COLUMN deleted_at TIMESTAMPTZ;

-- Update RLS to exclude soft-deleted items by default
-- Update queries to filter WHERE deleted_at IS NULL
-- Add "Trash" view to show deleted items with restore option
-- Auto-purge after 30 days (new cron workflow)
```

### 4.3 Missing FK CASCADE on published_content_v2

```sql
-- Current (no CASCADE specified):
project_id UUID REFERENCES writing_projects_v2(id)

-- Required:
ALTER TABLE published_content_v2 
  DROP CONSTRAINT published_content_v2_project_id_fkey,
  ADD CONSTRAINT published_content_v2_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES writing_projects_v2(id) ON DELETE SET NULL;
```

Using `SET NULL` instead of `CASCADE` — if a project is deleted, chapters become orphaned (still accessible) rather than silently deleted.

### 4.4 Missing discovery_question Column

```sql
ALTER TABLE story_arcs_v2 ADD COLUMN discovery_question TEXT;

-- Populate from known data:
UPDATE story_arcs_v2 SET discovery_question = 'What is the protagonist''s fatal flaw or central belief — and how will the story''s climax shatter or transform it?' WHERE name = 'Freytags Pyramid';
-- ... (all 8 arcs)
```

### 4.5 Formalize token_usage_v2 Schema

```sql
CREATE TABLE IF NOT EXISTS token_usage_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT REFERENCES users_v2(user_id) ON DELETE CASCADE,
  execution_id TEXT,
  workflow_id TEXT,
  workflow_name TEXT,
  llm_model TEXT,
  provider TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  estimated_cost NUMERIC(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_token_usage_v2_user ON token_usage_v2(user_id);
CREATE INDEX idx_token_usage_v2_date ON token_usage_v2(created_at);
```

---

## Part 5: UI Architecture Improvements

### 5.1 Content Creation Panel

Add a "Create" section to the sidebar or a floating action button with options:
- New Blog Post
- New Newsletter  
- New Research Report
- New Short Story
- New Book Project (brainstorm wizard)
- Generate Cover Art
- Create Social Posts

Each opens a dedicated form that POSTs to the n8n webhook with structured parameters.

### 5.2 Project Workspace View

Instead of separate pages for projects/chapters/outlines/story-bible, create a unified **Project Workspace** with tabs:
- **Overview** — project metadata, stats, outline summary
- **Outline** — full outline viewer/editor with version history
- **Chapters** — ordered chapter list with status, word count, links to editor
- **Story Bible** — character/location/event entries with CRUD
- **Cover Art** — images associated with this project
- **Research** — research reports linked to this project
- **Q/A Reports** — consistency reports per chapter
- **Cost** — token usage for this project
- **Export** — KDP export with page size selection

### 5.3 Social Media Management Page

Replace the placeholder with:
- **Generated Posts** — list of social media posts by platform
- **Preview Cards** — Twitter card, LinkedIn post, Instagram caption mockups
- **Copy to Clipboard** — one-click copy for each platform
- **Regenerate** — request new social posts for existing content
- **Image Gallery** — social media images associated with posts

### 5.4 Research Report Detail Page

Research reports need a full detail/editor view:
- Title, genre, status display
- Full content in rich text editor (same TipTap instance as content)
- Save edits back to `research_reports_v2.content`
- Citation URLs rendered as clickable links
- Delete operation

### 5.5 Version History Viewer

Content versions are created but never displayed. Add:
- **Version List** — sidebar panel in ContentDetail showing all versions with timestamps
- **Version Diff** — side-by-side or inline diff between any two versions
- **Restore** — revert to a previous version (creates a new version with the old content)
- **Version Note** — display `change_note` from `content_versions_v2`

### 5.6 Outline Editor with Version History

The outline JSONB in `writing_projects_v2` should be editable:
- **Visual outline editor** — drag-and-drop chapter reordering, inline edit of chapter titles/briefs
- **Character editor** — add/edit/remove characters with name, role, age, description
- **Theme tags** — add/remove themes
- **Version snapshots** — populate `outline_versions_v2` on every save
- **Version history** — view and restore previous outline versions

---

## Part 6: Consolidated Master Task List

Every item from the quality audit (AUDIT_REPORT.md) and this architectural review, deduplicated and prioritized.

### Priority 1: CRITICAL (Security & Data Integrity) — 12 items

| # | Task | Source | Category |
|---|------|--------|----------|
| 1 | Add JWT auth middleware to all server endpoints (export, chat, admin) | Quality Audit | Security |
| 2 | Fix admin role escalation — add role column with trigger preventing self-escalation | Both | Security |
| 3 | Restrict CORS to allowed origins only | Quality Audit | Security |
| 4 | Add input validation (zod) on all server endpoints | Quality Audit | Security |
| 5 | Add security headers via helmet middleware | Quality Audit | Security |
| 6 | Add rate limiting on export and chat proxy endpoints | Quality Audit | Security |
| 7 | Move n8n webhook URL and ElevenLabs agent ID to server-side proxy (not in client bundle) | Quality Audit | Security |
| 8 | Fix published_content_v2 project_id FK — add ON DELETE SET NULL | Arch Review | Data Integrity |
| 9 | Add soft delete columns (deleted_at) to all user-scoped tables | Arch Review | Data Integrity |
| 10 | Add React Error Boundary around route components | Quality Audit | Reliability |
| 11 | Add content-utils XSS sanitization (DOMPurify) before markdown-to-HTML | Quality Audit | Security |
| 12 | Add unsaved changes warning (beforeunload + route change prompt) | Quality Audit | Data Integrity |

### Priority 2: HIGH (Missing Core Functionality) — 22 items

| # | Task | Source | Category |
|---|------|--------|----------|
| 13 | Add delete operations for content (chapters, stories, blogs, newsletters) | Quality Audit | CRUD |
| 14 | Add delete operations for projects (with cascade warning dialog) | Quality Audit | CRUD |
| 15 | Add delete operations for research reports | Quality Audit | CRUD |
| 16 | Add delete operations for story bible entries | Quality Audit | CRUD |
| 17 | Build version history viewer in ContentDetail (list, diff, restore) | Both | Feature |
| 18 | Make Eve voice orb functional with visible status feedback, error handling | Quality Audit | Feature |
| 19 | Build research report detail page with editor (same pattern as ContentDetail) | Both | Feature |
| 20 | Make research report list rows clickable → detail page | Quality Audit | Navigation |
| 21 | Build project edit form (title, genre, status, chapter count) | Arch Review | CRUD |
| 22 | Build story bible entry create/edit/delete UI | Arch Review | CRUD |
| 23 | Build story arc create/edit for custom arcs | Arch Review | CRUD |
| 24 | Add discovery_question column to story_arcs_v2 and populate | Arch Review | Schema |
| 25 | Build content creation forms (blog, research, project wizard, cover art, social) | Arch Review | Feature |
| 26 | Implement scheduled publishing date picker and calendar view | Arch Review | Feature |
| 27 | Add search functionality across all list pages | Quality Audit | Feature |
| 28 | Build outline editor with visual chapter/character editing | Arch Review | Feature |
| 29 | Populate outline_versions_v2 on outline changes | Arch Review | Data Integrity |
| 30 | Add confirmation dialogs for all destructive actions (custom modals, not confirm()) | Quality Audit | UX |
| 31 | Implement admin server routes with proper auth (replace 501 stubs) | Quality Audit | Feature |
| 32 | Build user roles management UI in admin panel | Arch Review | Feature |
| 33 | Add genre feed input improvement — clear add/remove UX for multiple feeds | Quality Audit | UX |
| 34 | Formalize token_usage_v2 table in schema with RLS | Arch Review | Schema |

### Priority 3: MEDIUM (Feature Completeness) — 28 items

| # | Task | Source | Category |
|---|------|--------|----------|
| 35 | Build image persistence layer — generated_images_v2 table, storage buckets | Arch Review | Architecture |
| 36 | Update generate_cover_art workflow to save images to Supabase Storage | Arch Review | Workflow |
| 37 | Build Cover Art gallery page (replace placeholder) | Both | Feature |
| 38 | Build Social Media management page (replace placeholder) with preview cards | Both | Feature |
| 39 | Build token/cost tracking dashboard (per-project, per-model, per-day) | Arch Review | Feature |
| 40 | Build content provenance panel — "Sources used" on ContentDetail | Arch Review | Feature |
| 41 | Build content metrics dashboard in admin (collection vs usage rates) | Arch Review | Feature |
| 42 | Build source browser — browse content_index by genre | Arch Review | Feature |
| 43 | Display Q/A consistency reports on chapter detail pages | Arch Review | Feature |
| 44 | Build writing sample upload UI in Settings | Arch Review | Feature |
| 45 | Build project workspace view with tabs (overview, outline, chapters, bible, art, research, cost, export) | Arch Review | Architecture |
| 46 | Add dark mode toggle in Settings | Quality Audit | Feature |
| 47 | Add pagination to all list pages (projects, content, research, genres) | Quality Audit | Performance |
| 48 | Add bulk actions (multi-select approve, publish, delete) | Quality Audit | Feature |
| 49 | Add content filtering beyond status (genre, project, date range, word count) | Quality Audit | Feature |
| 50 | Add keyboard shortcuts (Ctrl+S save, Cmd+K search) | Quality Audit | UX |
| 51 | Fix breadcrumb to show content title instead of UUID | Quality Audit | UX |
| 52 | Auto-collapse sidebar on mobile screens | Quality Audit | Responsive |
| 53 | Add toast notification system (replace inline status text) | Quality Audit | UX |
| 54 | Add loading skeleton components (replace "Loading..." text) | Quality Audit | UX |
| 55 | Add empty state illustrations with calls-to-action | Quality Audit | UX |
| 56 | Add graceful server shutdown (SIGTERM/SIGINT handlers) | Quality Audit | Production |
| 57 | Add structured logging (winston/pino) | Quality Audit | Production |
| 58 | Add health check that verifies Supabase connectivity | Quality Audit | Production |
| 59 | Fix Dockerfile port mismatch (3000 vs 3001) | Quality Audit | Deployment |
| 60 | Add centralized Express error handler middleware | Quality Audit | Production |
| 61 | Add request logging middleware with request IDs | Quality Audit | Production |
| 62 | Add API versioning prefix (/api/v1/) | Quality Audit | Architecture |

### Priority 4: LOW (Polish & Future) — 27 items

| # | Task | Source | Category |
|---|------|--------|----------|
| 63 | Add table row keyboard navigation (tabindex, onKeyDown) | Quality Audit | Accessibility |
| 64 | Add status badge icon/pattern differentiation for colorblind users | Quality Audit | Accessibility |
| 65 | Add aria-labels to Eve status indicator | Quality Audit | Accessibility |
| 66 | Replace emoji icons in Story Bible with accessible SVG icons | Quality Audit | Accessibility |
| 67 | Add content preview mode (separate from edit) | Quality Audit | Feature |
| 68 | Add content duplication (clone project/chapter) | Quality Audit | Feature |
| 69 | Add content import (upload .txt/.md/.docx) | Quality Audit | Feature |
| 70 | Add activity log / audit trail table and UI | Both | Feature |
| 71 | Add in-app notifications for completed tasks | Quality Audit | Feature |
| 72 | Add onboarding tutorial for new users | Quality Audit | UX |
| 73 | Build OpenAPI/Swagger documentation for server endpoints | Quality Audit | Documentation |
| 74 | Add E2E test suite (Playwright) | Quality Audit | Testing |
| 75 | Add integration tests for auth flows and RLS | Quality Audit | Testing |
| 76 | Add per-user cost attribution for SaaS billing | Arch Review | Feature |
| 77 | Build newsletter section image generation support | Arch Review | Feature |
| 78 | Add cover image redraw/regenerate capability | Arch Review | Feature |
| 79 | Implement RAG writing agent (pgvector, summarizing memory) | Arch Review | Architecture |
| 80 | Add collaborative editing features (comments, @mentions) | Quality Audit | Feature |
| 81 | Add multi-user project sharing with permissions | Quality Audit | Feature |
| 82 | Add network status indicator (online/offline) | Quality Audit | UX |
| 83 | Lazy-load TipTap editor in read-only views | Quality Audit | Performance |
| 84 | Add chat message timestamps display | Quality Audit | UX |
| 85 | Limit chat message history growth | Quality Audit | Performance |
| 86 | Fix query cache key consistency (GenreForm invalidation) | Quality Audit | Code Quality |
| 87 | Add dashboard auto-refresh after external content creation | Quality Audit | UX |
| 88 | Add real-time Supabase subscriptions for live updates | Arch Review | Architecture |
| 89 | Configure KDP export to use S3-stored .docx template | Arch Review | Feature |

---

## Part 7: Architecture Diagrams

### Current Data Flow (Incomplete)

```
User → Web UI → [read-only views of Supabase data]
                  ↕ chat/voice (limited)
User → Eve/Chat → n8n Hub → [18 tool workflows] → Supabase + Email
                                                      ↑ images lost here
```

### Target Data Flow (Complete)

```
User → Web UI → Supabase (direct CRUD with RLS)
         ↕           ↕
    Server API   n8n Webhook
    (auth,       (AI operations)
     export,         ↕
     admin)     [18 tool workflows]
                     ↕
               Supabase DB + Storage
                     ↕
              [images, content, versions, costs, provenance]
                     ↕
                 Email Delivery
```

### Target Image Flow

```
User requests cover art (UI form or chat)
    ↓
n8n generate_cover_art workflow
    ↓
KIE.AI generates image
    ↓
Workflow saves to Supabase Storage (cover-images/{user_id}/{slug}.png)
    ↓
Inserts row in generated_images_v2 (path, prompt, dimensions, content_id)
    ↓
Updates published_content_v2.cover_image_path
    ↓
Attaches to email AND
    ↓
Web UI Cover Art gallery shows persistent image
    ↓
User can reassign, download, or regenerate
```

---

## Part 8: Database Schema Changes Required

Summary of all schema modifications identified in this review:

1. `ALTER TABLE users_v2 ADD COLUMN role TEXT DEFAULT 'user'` + escalation trigger
2. `ALTER TABLE story_arcs_v2 ADD COLUMN discovery_question TEXT`
3. `CREATE TABLE generated_images_v2` (full schema in Part 2)
4. `CREATE TABLE token_usage_v2` (full schema in Part 4.5)
5. `ALTER TABLE writing_projects_v2 ADD COLUMN deleted_at TIMESTAMPTZ`
6. `ALTER TABLE published_content_v2 ADD COLUMN deleted_at TIMESTAMPTZ`
7. `ALTER TABLE research_reports_v2 ADD COLUMN deleted_at TIMESTAMPTZ`
8. `ALTER TABLE story_bible_v2 ADD COLUMN deleted_at TIMESTAMPTZ`
9. Fix `published_content_v2.project_id` FK to `ON DELETE SET NULL`
10. Create Supabase Storage buckets: `cover-images`, `social-images`, `writing-samples`
11. RLS policies for all new tables
12. Update `is_admin()` function to use `role` column instead of `preferences` JSONB

---

## Part 9: Acceptance Criteria Summary

| Requirement | Current | After Remediation |
|---|---|---|
| All AI tools accessible from UI | 40% (chat only) | 100% (forms + chat) |
| Full CRUD on all entities | 8% (1/12 tables) | 100% |
| Image management | 0% | 100% (gallery, persistence, retrieval) |
| Version history visible | 0% (created, hidden) | 100% (viewer, diff, restore) |
| Security hardened | 20% | 100% (JWT, roles, CORS, validation) |
| Token/cost tracking | 0% | 100% (dashboard, per-project) |
| Content provenance | 0% | 100% (sources panel, metrics) |
| Scheduled publishing | 0% (status exists, no date picker) | 100% (calendar, date picker) |
| Eve voice functional | 0% | 100% (working orb with status) |
| Production ready | 30% | 100% (logging, monitoring, graceful shutdown) |

---

*This architectural review represents the perspective of an independent architect evaluating the system for production deployment as a SaaS product. The 89-item task list provides a complete remediation path from current state to customer acceptance.*
