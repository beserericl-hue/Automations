# The Writers Workbench — Architectural Review V2

**Date:** 2026-04-11
**Role:** Independent Architect / QA Reviewer (customer representative)
**Scope:** Data hierarchy, entity relationships, UI structure, orphan risks, AI workflow data gaps, and consolidated remediation plan

**Important Context:** This web UI is primarily a **command interface** — users interact with the AI system through chat (text to n8n) or voice (Eve via ElevenLabs). The UI's native functionality is limited to: artwork gallery, KDP export via Word, version control, and data management/viewing. Most content creation happens through the chat/voice interface, not through UI forms.

---

## Part 1: Root Concepts & Entity Hierarchy

### What is the root concept everything depends on?

**`users_v2` is the absolute root.** Every user-scoped table has `ON DELETE CASCADE` to `users_v2(user_id)`. Deleting a user atomically removes all their data.

But the **functional root** — the concept around which the user's work revolves — is the **Writing Project** (`writing_projects_v2`). A project is a book, story, or content initiative. Everything the user creates relates to a project either directly (chapters, outlines, story bible) or indirectly (research that informed it, cover art for it, social posts derived from it).

### The True Data Hierarchy

```
User (users_v2)
│
├── Settings (app_config_v2)
│
├── Genres (genre_config_v2) ← INDEPENDENT REFERENCE
│   └── [soft-referenced by projects, content, research via genre_slug TEXT]
│
├── Story Arcs (story_arcs_v2) ← INDEPENDENT REFERENCE
│   └── [referenced by name in project outlines, not by FK]
│
├── Writing Projects (writing_projects_v2) ← FUNCTIONAL ROOT
│   ├── Outline (JSONB in project row)
│   │   ├── Characters (array in outline JSON)
│   │   ├── Chapters (array in outline JSON)
│   │   └── Themes (array in outline JSON)
│   │
│   ├── Outline Versions (outline_versions_v2) ← CASCADE
│   │
│   ├── Story Bible (story_bible_v2) ← CASCADE
│   │   ├── Characters
│   │   ├── Locations
│   │   ├── Events
│   │   ├── Timeline
│   │   ├── Plot Threads
│   │   └── World Rules
│   │
│   ├── Chapters (published_content_v2 where content_type='chapter') ← NO CASCADE (ORPHAN RISK)
│   │   └── Content Versions (content_versions_v2) ← CASCADE from content
│   │
│   ├── Cover Art (NOT TRACKED — ephemeral email)
│   │
│   └── [KDP Export — generated on demand, not stored]
│
├── Standalone Content (published_content_v2 where project_id IS NULL)
│   ├── Blog Posts
│   ├── Newsletters
│   ├── Short Stories
│   └── Content Versions (content_versions_v2) ← CASCADE
│
├── Research Reports (research_reports_v2) ← CASCADE from user
│
├── Social Media Posts ← NOT IN DATABASE (ephemeral email only)
│
├── Cover Art / Images ← NOT IN DATABASE (ephemeral email only)
│
└── Content Usage / Provenance (content_usage_v2) ← CASCADE from user
    └── References content_index (public, shared)
```

### Independent Reference Entities

These exist independently and are referenced by other entities to improve generation:

1. **Genres** (`genre_config_v2`) — define writing tone, research sources (RSS feeds, subreddits), and art direction. Referenced by `genre_slug` (text, no FK). Public genres are shared; users can create private ones.

2. **Story Arcs** (`story_arcs_v2`) — define narrative frameworks (Freytag, Hero's Journey, etc.) with full prompt templates. Referenced by name in outline JSONB. Public arcs are shared; users should be able to create private ones.

3. **Content Index** (`content_index`) — scraped research material (RSS, Reddit, Google Books, Open Library). Public, shared across all users. Referenced by `content_usage_v2` for provenance tracking.

**Critical Finding:** These independent entities improve generation quality but the UI does not show how they relate to user content. A user cannot see "this chapter was written using the post-apocalyptic genre guidelines and the Hero's Journey arc with research from these 5 sources." This lineage is invisible.

---

## Part 2: Orphan Analysis — What Happens When You Delete?

### Deleting a Project

| Child Entity | Cascade Behavior | Result |
|---|---|---|
| story_bible_v2 | ON DELETE CASCADE | Deleted cleanly |
| outline_versions_v2 | ON DELETE CASCADE | Deleted cleanly |
| published_content_v2 (chapters) | **NO CASCADE (RESTRICT)** | **ORPHANED** — chapters remain with dead project_id |
| content_versions_v2 | Cascades from content, not project | Versions of orphaned chapters survive |
| content_usage_v2 | **NO CASCADE** | **ORPHANED** — provenance records with dead project_id |
| Cover art | Not in database | N/A (already lost) |
| Social media posts | Not in database | N/A (already lost) |

**To properly delete a project, the application must:**
1. Delete or nullify all `published_content_v2` rows with `project_id = X`
2. Delete all `content_usage_v2` rows with `project_id = X`
3. Then delete the project (which cascades story_bible and outline_versions)

**This is not implemented anywhere in the application.**

### Deleting a Content Item (Chapter/Story/Blog/Newsletter)

| Child Entity | Cascade Behavior | Result |
|---|---|---|
| content_versions_v2 | ON DELETE CASCADE | Deleted cleanly |
| content_usage_v2 | content_id FK, NO CASCADE | **ORPHANED** |

### Deleting a Genre

| Affected Entity | Reference Type | Result |
|---|---|---|
| writing_projects_v2.genre_slug | Soft text reference | **ORPHANED** — project still shows deleted genre slug |
| published_content_v2.genre_slug | Soft text reference | **ORPHANED** |
| research_reports_v2.genre_slug | Soft text reference | **ORPHANED** |
| content_index.genre_slug | Soft text reference | **ORPHANED** (acceptable for public data) |

**Genre deletion should be prevented if any projects/content reference it**, or the application should offer to reassign the genre first.

---

## Part 3: Critical UI Structure Review

### Problem: The Sidebar is a Flat List of 12 Items

The current sidebar presents every content type as a top-level navigation item:

```
Dashboard, Projects, Chapters, Short Stories, Blog Posts, 
Newsletters, Research, Social Posts, Cover Art, Outlines, 
Story Arcs, Genres, Settings, Admin
```

This is **wrong for two reasons:**

1. **It doesn't reflect the data hierarchy.** Chapters belong to projects. Outlines belong to projects. Story bible belongs to projects. Cover art belongs to content. Social posts are derived from content. These parent-child relationships are invisible in a flat sidebar.

2. **Most items are just different views of the same table.** Chapters, Short Stories, Blog Posts, and Newsletters are all `published_content_v2` filtered by `content_type`. They don't need separate sidebar entries.

### Recommended Sidebar Restructure

```
Dashboard
─────────────────
My Projects          ← click opens project list
  [Project Name]     ← expandable: shows chapters, outline, bible, art
  [Project Name]
─────────────────
Content Library      ← ALL published_content_v2, filterable by type
Research             ← research_reports_v2
─────────────────
Reference            ← collapsible section
  Genres             ← genre_config_v2 (user can manage feeds here)
  Story Arcs         ← story_arcs_v2 (browse frameworks)
  Source Library     ← content_index (browse scraped sources)
─────────────────
Settings
Admin (if admin)
```

**Key changes:**
- **Projects become the primary navigation.** Clicking a project opens a workspace with tabs for outline, chapters, story bible, cover art, Q/A reports, cost tracking, and export.
- **Content Library** consolidates chapters, stories, blogs, newsletters into one page with type/status/genre filters. This is the "everything I've written" view.
- **Social Posts, Cover Art, Outlines** are removed as top-level items. They belong inside project workspaces or content detail pages.
- **Reference** section groups independent entities (genres, arcs, source library) that inform generation but don't belong to any project.

---

## Part 4: Social Media — An Unmanaged Content Type

### Current State

Social media is **not a first-class entity.** The workflow generates platform-specific text posts (Twitter threads, LinkedIn posts, Instagram captions, Facebook posts) with hashtags, plus a cover image. Everything is emailed and discarded. Nothing is stored in the database.

### What Social Media Actually Produces

For a single "repurpose to social" request:
- 1-3 text posts per platform
- Hashtag arrays per post
- 1 cover image (via KIE.AI)
- Platform-specific formatting

### What's Missing

There is no `social_posts_v2` table. Social media posts should be persisted:

```sql
CREATE TABLE social_posts_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  source_content_id UUID REFERENCES published_content_v2(id) ON DELETE SET NULL,
  project_id UUID REFERENCES writing_projects_v2(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('twitter', 'linkedin', 'instagram', 'facebook')),
  post_text TEXT NOT NULL,
  hashtags TEXT[] DEFAULT '{}',
  image_id UUID REFERENCES generated_images_v2(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'scheduled')),
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}', -- engagement data, character count, thread position
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Where Social Posts Belong in the UI

Social posts should NOT be a top-level sidebar item. They belong:
- **In Content Detail** — "Create Social Posts" button on any chapter/story/blog, shows generated posts grouped by platform with copy-to-clipboard
- **In Project Workspace** — "Social" tab showing all social posts generated from this project's content
- **In Content Library** — as a filter option alongside chapters/stories/blogs/newsletters

---

## Part 5: Cover Art & Images — An Unmanaged Asset Type

### Current State

Cover art is generated by KIE.AI, emailed as a PNG attachment, and lost forever. The `cover_image_path` column in `published_content_v2` exists but is never populated. There is no `generated_images_v2` table.

### Where Images Belong in the UI

Images should NOT be a top-level sidebar item. They belong:
- **In Content Detail** — cover image displayed at the top of the editor, with "Generate New" and "Choose from Gallery" buttons
- **In Project Workspace** — "Art" tab showing all images generated for this project (chapter covers, social images)
- **In an Image Picker** — modal that appears when assigning cover art to any content item

### Required: Image Persistence

See ARCHITECTURE_REVIEW.md Part 2 for the `generated_images_v2` table and storage bucket design. The n8n workflow must be modified to save images to Supabase Storage and record metadata in the database.

---

## Part 6: Does the UI Show the Data Hierarchy?

**No.** The current UI presents a flat, disconnected view of data. Specific failures:

### 6.1 Projects Don't Show Their Children

ProjectDetail shows chapters in a sidebar list, but:
- Cannot see which chapters are draft vs published at a glance (only a tiny dot)
- Cannot see word counts per chapter
- Cannot see total project word count
- Cannot see which chapters have Q/A reports
- No visual progress indicator (e.g., "7 of 12 chapters written")

### 6.2 Content Doesn't Show Its Parent

ContentDetail shows the content type and genre, but:
- No link to the parent project
- No breadcrumb showing Project → Chapter → Editor
- No way to navigate to the next/previous chapter
- No context about where this chapter fits in the story arc

### 6.3 No Cross-References Visible

- Research reports don't show which projects used them
- Projects don't show which research informed them
- Content doesn't show its provenance (which scraped sources were used)
- Genres don't show how many projects/content items use them
- Story arcs don't show which projects use them

### 6.4 Version History Is Invisible

Content versions are created on every save but:
- No version list anywhere in the UI
- No diff viewer
- No restore capability
- Users don't know versions exist

### 6.5 Outline Is Disconnected from Chapters

The outline shows chapter briefs (plan) and the chapter list shows written chapters (execution), but:
- No visual mapping between "planned chapter 3" and "written chapter 3"
- No indicator of which outlined chapters have been written vs. not yet started
- No way to see if the written chapter matches the outline brief

---

## Part 7: Revised Recommendations

Given that this is a **command interface** (chat/voice primary, UI for viewing/managing), the improvements focus on data visibility, hierarchy navigation, and asset management.

### 7.1 UI Structure: Project-Centric Workspace

Replace the flat sidebar with a project-centric model:

**Project Workspace** (single page with tabs):
- **Overview** — title, genre, arc, status, progress bar (chapters written/total), total word count, cost
- **Outline** — visual outline with chapter cards, character profiles, themes. Shows which chapters are written (green check) vs pending. Version history.
- **Chapters** — ordered list with status, word count, Q/A results. Click to open editor. Next/prev navigation between chapters.
- **Story Bible** — grouped entries with CRUD. Auto-updated indicator showing "3 new entries from Chapter 7"
- **Art** — all generated images for this project. Assign as cover. Generate new.
- **Social** — all social posts generated from this project's content. Platform tabs.
- **Research** — research reports linked to this project's genre/topics
- **Cost** — token usage breakdown by chapter/model
- **Export** — KDP formatting with page size selection

### 7.2 Content Library: Consolidated View

Replace 4 separate sidebar items (Chapters, Short Stories, Blog Posts, Newsletters) with one **Content Library** page:
- Filter bar: type (all/chapter/story/blog/newsletter), status, genre, project, date range
- Sort by: date, title, word count, status
- Bulk actions: approve all, publish all, delete selected
- Click row → opens editor with full project context

### 7.3 Reference Section

Group independent entities under "Reference":
- **Genres** — view/edit genre configurations including RSS feeds, writing guidelines
- **Story Arcs** — browse the 8 frameworks with discovery questions, create custom
- **Source Library** — browse scraped content from content_index by genre/source

### 7.4 Chat & Voice as Primary Interface

The chat drawer and Eve orb should be prominent:
- **Chat drawer** — wider, always accessible, shows history. Context-aware: if viewing a project, chat can reference it ("write chapter 3 of this project")
- **Eve orb** — must work (currently non-functional). Visual status. Conversation history.
- **Quick actions** from context: "Write next chapter" button on project workspace that pre-fills the chat with the right command

---

## Part 8: Web Callback Architecture (Eve Channel Routing)

### Problem

When Eve is accessed via phone, the `eve_knowledge_callback` workflow retrieves content, injects it into Eve's Knowledge Base, and triggers an **outbound phone call** back to the user. But when the user is connected via the **web widget**, there is no phone to call. n8n receives the same webhook payload from Eve regardless of channel — it has no way to know whether the user is on the phone or in the web UI.

### Recommended Solution: Session Registration + Web Webhook

```
Web Widget connects to Eve
    ↓
Web app registers active session:
POST /api/session/register  { user_id: "+14105914612", channel: "web" }
    ↓ (stored in memory or Redis)

User says: "Pull up my outline for The Burial Mound"
    ↓
Eve → n8n hub → retrieve_content → eve_knowledge_callback
    ↓
BEFORE outbound call decision, n8n checks:
GET https://writers-workbench.railway.app/api/session/active?user_id=+14105914612
    ↓
Response: { active: true, channel: "web" }  OR  { active: false }
    ↓
IF web session active:
    n8n POSTs content to:
    POST https://writers-workbench.railway.app/api/callback/content-ready
    Body: { user_id, content_title, content_text, content_type, callback_mode }
        ↓
    Express server pushes to client via Server-Sent Events (SSE)
        ↓
    Web UI shows notification: "Eve has loaded 'The Burial Mound' outline"
    User can now ask Eve about it in the existing widget session

IF no web session:
    n8n triggers outbound phone call (existing behavior, unchanged)
```

### Implementation Components

**Web App (Express server) — 3 new endpoints:**

1. `POST /api/session/register` — called by web UI when Eve widget opens
   - Stores `{ user_id, channel, connected_at }` in memory Map or Redis
   - Called from EveOrb component on widget mount

2. `GET /api/session/active?user_id=X` — called by n8n to check channel
   - Returns `{ active: true, channel: "web" }` or `{ active: false }`
   - n8n adds an HTTP Request node before the callback decision

3. `POST /api/callback/content-ready` — called by n8n when content is loaded
   - Receives content payload from n8n
   - Pushes to connected client via SSE

4. `GET /api/callback/events?user_id=X` — SSE stream for the client
   - Client opens this on page load, listens for push notifications
   - Server sends events when content is ready

**Web UI (React) — client-side:**

- EveOrb calls `/api/session/register` on mount, `/api/session/unregister` on unmount
- EventSource connection to `/api/callback/events` listens for content-ready notifications
- On notification: show toast "Eve has loaded [title] — ask her about it"
- Optionally: auto-inject context into chat drawer

**n8n Workflow (eve_knowledge_callback) — small change:**

- Add HTTP Request node before the outbound call decision
- `GET /api/session/active?user_id={{ $json.user_id }}`
- IF response.active === true AND response.channel === "web":
  - POST content to `/api/callback/content-ready`
  - Skip outbound phone call
  - Skip first_message change (not needed for web)
- ELSE:
  - Existing phone callback flow (unchanged)

### Why This Approach

- **No changes to Eve's agent configuration** — same agent serves both channels
- **No changes to the embed widget** — works with the drop-in `<elevenlabs-convai>` component
- **n8n makes one simple HTTP check** — minimal workflow change
- **Works for multiple users simultaneously** — one on phone, one on web, each gets the right callback
- **SSE is simpler than WebSocket** — one-direction push (server → client), built into browsers, no library needed
- **Session cleanup is automatic** — web app removes session on widget unmount or on timeout

---

## Part 9: Database Schema Changes Required

All changes from V1 review plus new findings:

| # | Change | Reason |
|---|--------|--------|
| 1 | `ALTER TABLE published_content_v2` — change project_id FK to `ON DELETE SET NULL` | Prevent orphaned content on project delete |
| 2 | `ALTER TABLE content_usage_v2` — change project_id FK to `ON DELETE SET NULL` | Prevent orphaned provenance on project delete |
| 3 | `CREATE TABLE social_posts_v2` | Persist social media content (currently ephemeral) |
| 4 | `CREATE TABLE generated_images_v2` | Persist cover art and social images (currently ephemeral) |
| 5 | `CREATE TABLE token_usage_v2` (formalize) | Cost tracking already exists but needs schema/RLS |
| 6 | `ALTER TABLE users_v2 ADD COLUMN role TEXT` | Proper role system (replace JSONB preferences hack) |
| 7 | `ALTER TABLE story_arcs_v2 ADD COLUMN discovery_question TEXT` | TypeScript type exists, DB column missing |
| 8 | Add `deleted_at TIMESTAMPTZ` to projects, content, research, story_bible | Soft delete support |
| 9 | Add escalation prevention trigger on users_v2.role | Prevent users from self-promoting to admin |
| 10 | Create Supabase Storage buckets: cover-images, social-images, writing-samples | Asset persistence |
| 11 | Add `published_content_v2.content_type` CHECK update to include 'social_post' | Or use separate table (#3) |
| 12 | Add `genre_slug` deletion protection | Prevent deleting genre with dependent content |

---

## Part 9: AI Workflow Changes Required

The n8n workflows generate data that the web UI needs to display. Current gaps:

| Workflow | Change Needed | Why |
|---|---|---|
| generate_cover_art | Save image to Supabase Storage, insert `generated_images_v2` row, update `published_content_v2.cover_image_path` | Images are ephemeral — user can never see them again |
| repurpose_to_social | Save posts to `social_posts_v2` table, save image to storage | Social posts are ephemeral — user can never see them again |
| write_chapter (worker) | Store Q/A report in `published_content_v2.metadata.qa_report` | Q/A results only emailed, not queryable |
| brainstorm_story | Insert `outline_versions_v2` row on every outline save | Outline version table exists but is never populated |
| edit_outline | Insert `outline_versions_v2` row before applying edits | Same — outline changes have no version history |
| token_tracker | Include `user_id` in `token_usage_v2` records | Currently no user attribution for cost tracking |
| All writing workflows | Populate `content_usage_v2` with source references | Provenance tracking exists but may not be consistently populated |

---

## Part 10: Consolidated Master Task List

Merged from Quality Audit (AUDIT_REPORT.md), Architecture Review V1, and this V2 review. Deduplicated and re-prioritized.

### CRITICAL — Security & Data Integrity (12 items)

| # | Task | Est. |
|---|------|------|
| 1 | Add JWT auth middleware to all server endpoints | 4h |
| 2 | Fix admin role escalation — dedicated `role` column with escalation trigger | 3h |
| 3 | Restrict CORS to allowed origins | 30m |
| 4 | Add input validation (zod) on all server endpoints | 6h |
| 5 | Add helmet security headers | 30m |
| 6 | Add rate limiting on export and chat proxy | 2h |
| 7 | Move webhook URL and agent ID to server proxy | 3h |
| 8 | Fix published_content_v2 project_id FK → ON DELETE SET NULL | 30m |
| 9 | Fix content_usage_v2 project_id FK → ON DELETE SET NULL | 30m |
| 10 | Add XSS sanitization (DOMPurify) in content-utils | 1h |
| 11 | Add React Error Boundary around route components | 2h |
| 12 | Add genre deletion protection (prevent if content references it) | 2h |

### HIGH — Core Functionality (20 items)

| # | Task | Est. |
|---|------|------|
| 13 | Restructure sidebar: project-centric with Content Library, Reference section | 8h |
| 14 | Build Project Workspace with tabs (overview, outline, chapters, bible, art, social, research, cost, export) | 16h |
| 15 | Build Content Library (consolidated view replacing 4 separate pages) with multi-filter | 6h |
| 16 | Add delete operations for content with cascade warning | 4h |
| 17 | Add delete operations for projects with cascade cleanup (children warning dialog) | 6h |
| 18 | Add soft delete columns and trash/restore UI | 4h |
| 19 | Build version history viewer (list, diff, restore) in content editor | 8h |
| 20 | ~~Make Eve voice orb functional~~ DONE — using ElevenLabs embed widget | -- |
| 21 | Build research report detail page with editor | 4h |
| 22 | Add unsaved changes warning (beforeunload + route prompt) | 2h |
| 23 | Create `social_posts_v2` table and update repurpose workflow to persist posts | 4h |
| 24 | Create `generated_images_v2` table and update cover art workflow to persist images | 6h |
| 25 | Build image gallery in project workspace (view, assign, regenerate, download) | 8h |
| 26 | Build social media panel in project workspace (view by platform, copy, regenerate) | 6h |
| 27 | Add search functionality across all list pages | 4h |
| 28 | Populate outline_versions_v2 in brainstorm/edit workflows | 3h |
| 29 | Formalize token_usage_v2 schema with user_id attribution | 2h |
| 30 | Add discovery_question column to story_arcs_v2 | 30m |
| 31 | Add confirmation dialogs for all destructive actions (custom modals) | 4h |
| 32 | Implement admin server routes with auth (replace 501 stubs) | 6h |
| 33 | Build web callback architecture: session registration, SSE push, content-ready webhook | 8h |
| 34 | Update n8n eve_knowledge_callback workflow: add channel check before phone/web routing | 3h |

### MEDIUM — Feature Completeness (22 items)

| # | Task | Est. |
|---|------|------|
| 35 | Build token/cost tracking dashboard (per-project, per-model, per-day) | 8h |
| 36 | Build content provenance panel ("Sources used" on content detail) | 4h |
| 37 | Build scheduled publishing date picker and calendar | 6h |
| 38 | Display Q/A consistency reports on chapter detail pages | 4h |
| 39 | Add chapter progress visualization on project overview (written/total, word counts) | 4h |
| 40 | Add outline-to-chapter mapping (which outlined chapters are written vs pending) | 4h |
| 41 | Add next/previous chapter navigation in editor | 2h |
| 42 | Build story bible entry CRUD (create, edit, delete) | 6h |
| 43 | Build story arc create/edit for custom arcs | 4h |
| 44 | Build source library browser (browse content_index by genre/source) | 4h |
| 45 | Add context-aware chat (pre-fill commands from current project context) | 4h |
| 46 | Add dark mode toggle in Settings | 2h |
| 47 | Add pagination to all list pages | 4h |
| 48 | Add bulk actions (multi-select approve, publish, delete) | 4h |
| 49 | Fix breadcrumb to show content title instead of UUID | 2h |
| 50 | Auto-collapse sidebar on mobile | 1h |
| 51 | Add toast notification system | 3h |
| 52 | Add loading skeleton components | 3h |
| 53 | Fix Dockerfile port mismatch (3000 vs 3001) | 15m |
| 54 | Add graceful server shutdown handlers | 2h |
| 55 | Add structured logging (pino/winston) | 4h |
| 56 | Add health check that verifies Supabase connectivity | 1h |

### LOW — Polish & Future (19 items)

| # | Task | Est. |
|---|------|------|
| 57 | Add writing sample upload UI in Settings | 4h |
| 58 | Create Supabase Storage buckets (cover-images, social-images, writing-samples) | 1h |
| 59 | Add keyboard shortcuts (Ctrl+S, Cmd+K search) | 3h |
| 60 | Add table row keyboard navigation (accessibility) | 2h |
| 61 | Add status badge differentiation for colorblind users | 1h |
| 62 | Add aria-labels to Eve and story bible icons | 1h |
| 63 | Add content preview mode | 4h |
| 64 | Add content duplication (clone project/chapter) | 3h |
| 65 | Add content import (.txt/.md/.docx upload) | 6h |
| 66 | Add activity log / audit trail | 8h |
| 67 | Add in-app notifications | 6h |
| 68 | Add onboarding tutorial for new users | 4h |
| 69 | Add API versioning prefix (/api/v1/) | 1h |
| 70 | Add OpenAPI documentation | 4h |
| 71 | Add E2E test suite (Playwright) | 12h |
| 72 | Add request logging middleware with request IDs | 2h |
| 73 | Add centralized Express error handler | 2h |
| 74 | Configure KDP export to use S3-stored .docx template | 3h |
| 75 | Add genre reference count (show "12 projects use this genre") | 2h |

**Total: 75 items** (73 original + 2 callback architecture items, minus 1 completed Eve item)

**Estimated total effort: ~291 hours**

---

## Part 11: Acceptance Criteria (Revised)

Given the command-interface model (chat/voice primary):

| Requirement | Priority | Status |
|---|---|---|
| Chat drawer works and connects to n8n hub | CRITICAL | Implemented (needs CORS testing) |
| Eve voice widget works (embed widget) | CRITICAL | **FIXED** — using ElevenLabs embed widget |
| Eve web callback routing (phone vs web channel) | HIGH | **MISSING** — needs session registration + SSE push |
| All generated data visible in UI (content, images, social, research) | HIGH | **PARTIAL** — images and social posts are ephemeral |
| Project workspace shows complete hierarchy | HIGH | **MISSING** — flat sidebar, no hierarchy |
| Content editable with version history | HIGH | **PARTIAL** — editor works, versions hidden |
| Delete operations with cascade warnings | HIGH | **MISSING** — no delete anywhere |
| Search across all content | HIGH | **MISSING** |
| Security hardened (JWT, CORS, roles) | CRITICAL | **MISSING** |
| Data integrity (no orphans on delete) | HIGH | **BROKEN** — orphan risks documented |
| Token/cost tracking visible | MEDIUM | **MISSING** — data exists, no UI |
| KDP export functional | MEDIUM | Implemented (template not used) |
| Admin panel functional | MEDIUM | **PARTIAL** — stubs, no real auth |

---

*This V2 review reflects the command-interface philosophy: the web UI is for viewing, managing, and organizing the work that the AI system produces. The AI system (via chat and Eve) remains the primary creation tool. The UI must faithfully represent the complete data hierarchy that the AI system generates, including assets (images, social posts) that are currently lost after email delivery.*
