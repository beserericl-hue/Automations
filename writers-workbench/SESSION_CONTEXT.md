# The Writers Workbench — Session Context Document

**Last Updated:** 2026-04-11
**Purpose:** Read this document at the start of any new Claude Code session working on this project. It contains every key decision, architectural choice, and constraint needed to continue development without re-learning the codebase.

---

## Required Reading List

Read these files in order before starting any development work:

1. **`/Users/ericbeser/Documents/GitHub/Automations/CLAUDE.md`** — Project rules. CRITICAL: never modify baseline/V1 resources. All work on V2 only. Git branching: `develop` for changes, `main` for releases.

2. **`/Users/ericbeser/Documents/GitHub/Automations/writers-workbench/sprint_document.md`** — The complete sprint plan. 52 stories across 8 sprints. This is the work backlog. Each story has developer tasks and QA tasks.

3. **`/Users/ericbeser/Documents/GitHub/Automations/writers-workbench/AUDIT_REPORT.md`** — Quality audit with 127 deficiencies. Reference for understanding WHY each sprint task exists.

4. **`/Users/ericbeser/Documents/GitHub/Automations/writers-workbench/ARCHITECTURE_REVIEW_V2.md`** — Architectural review with data hierarchy, orphan analysis, image/social media persistence design, web callback architecture, and 75-item consolidated task list.

5. **`/Users/ericbeser/.claude/plans/nifty-sprouting-bear.md`** — Original design specification. The initial vision document for the product.

6. **`/Users/ericbeser/Documents/GitHub/Automations/supabase_setup_v2.sql`** — The V2 database schema. All tables, FKs, RLS policies, seed data.

7. **`/Users/ericbeser/Documents/GitHub/Automations/writers-workbench/supabase_auth_migration.sql`** — Auth-specific schema changes (supabase_auth_uid column, get_current_user_id() function, is_admin() function, updated RLS policies).

8. **`/Users/ericbeser/Documents/GitHub/Automations/writing-assistant-prompt.md`** — Eve's personality, tool execution rules, brainstorm conversation mode, review mode. Needed for understanding the voice/chat interface behavior.

---

## What This Product Is

**The Writers Workbench** is a SaaS web application — the dashboard UI for **The Author Agent**, an n8n-based AI writing automation system. Users create content (books, stories, blogs, newsletters, research) through voice (Eve via ElevenLabs) or text chat (n8n webhook). The web UI is for **viewing, editing, managing, and organizing** that content — not for creating it directly.

### The Two Interfaces
1. **Chat Drawer** — text-based, POSTs to n8n webhook at `/webhook/author_request_v2`. Handles async (writing tasks → email delivery) and sync (list/retrieve → immediate response) operations. Located in top bar.
2. **Eve Voice Widget** — ElevenLabs embed widget (`<elevenlabs-convai agent-id="...">` from CDN). Located in sidebar. Uses Beta agent `agent_2801kks580vnf5q80j3bd0n0x45v`.

**All content creation happens through chat or Eve.** No UI forms for creating projects, chapters, stories, etc. The chat drawer has Quick Commands to help users compose requests.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, TailwindCSS |
| State/Data | TanStack Query (React Query), Supabase JS client |
| Rich Text Editor | TipTap (StarterKit + Link + Placeholder) |
| Markdown Conversion | marked (with DOMPurify sanitization pending) |
| Voice Widget | ElevenLabs convai-widget-embed (CDN, NOT the React SDK) |
| Backend | Express, TypeScript |
| .docx Export | docx npm library |
| Database | Supabase (PostgreSQL) with RLS |
| Storage | Supabase Storage (author-content bucket) |
| Auth | Supabase Auth (email/password + Google OAuth) |
| Testing | Vitest + React Testing Library + jsdom (31 tests passing) |
| Deployment | Docker on Railway (auto-deploy from GitHub) |

---

## Key Architectural Decisions

### 1. Command Interface Model
Content creation is done through chat/Eve, not UI forms. The web UI is for viewing and managing. This was a deliberate design choice by the product owner — do NOT add creation forms (no "New Project" wizard, no "Write Blog Post" form). Instead, enhance the chat drawer with Quick Commands and context-aware suggestions.

### 2. User Identity: Phone Number = user_id
`users_v2.user_id` is the phone number (E.164 format, e.g., `+14105914612`). This is the same `system__caller_id` that ElevenLabs passes when Eve calls n8n. The web app maps Supabase Auth UUID → `users_v2.supabase_auth_uid` → `user_id` (phone). All V2 tables use `user_id` (phone) as the foreign key, NOT the Supabase Auth UUID.

### 3. Eve Widget: Embed, Not React SDK
We tried `@elevenlabs/react` (programmatic SDK) — it failed with WebRTC/LiveKit 404 errors. Switched to the official `<elevenlabs-convai>` embed widget loaded from CDN. This is the same code ElevenLabs provides in their dashboard. It handles connection, microphone, UI, and status internally. The `@elevenlabs/react` package was uninstalled.

### 4. Content is Stored as Markdown, Displayed as HTML
The n8n workflows (Claude Sonnet) generate content as markdown. `content-utils.ts` converts markdown → HTML via `marked` before loading into TipTap. After the first editor save, content is stored as HTML. The conversion auto-detects: if content has `<p>` tags it's already HTML (pass through), if it has `#` headers or `\n\n` it's markdown (convert).

### 5. Direct Supabase Access from Frontend
The React client queries Supabase directly using `@supabase/supabase-js` with the anon key + auth JWT. RLS enforces data isolation. The Express server is only used for: health check, chat proxy (CORS), .docx export (needs service role), and admin operations (needs service role).

### 6. No Floating Eve Orb
Eve was moved from a floating bottom-right button to the sidebar (bottom section, above Settings). Clicking "Talk to Eve" opens a popover with the embed widget. This was a user request — the floating orb overlapped content and was confusing.

### 7. Web Callback Architecture (Planned, Not Built)
When Eve is on the web widget and n8n's `eve_knowledge_callback` fires, it should NOT trigger an outbound phone call. Instead:
- Web app registers active sessions (`POST /api/session/register`)
- n8n checks `GET /api/session/active?user_id=X` before callback
- If web session: POST to `/api/callback/content-ready` → SSE push to client
- If no web session: trigger phone call (existing behavior)
This is Sprint 5, stories S5-4 and S5-5.

### 8. Soft Deletes (Planned, Not Built)
No entity supports delete yet. When implemented, all deletes will be soft (set `deleted_at` timestamp). Hard delete only after 30 days or admin action. Cascade warnings shown before deletion.

### 9. Images and Social Posts Are Ephemeral (To Be Fixed)
Cover art (KIE.AI) and social media posts are currently generated, emailed, and discarded. Sprint 4 adds `generated_images_v2` and `social_posts_v2` tables plus Supabase Storage buckets to persist them. The n8n workflows need modification to save images to storage.

### 10. Admin Role Vulnerability (To Be Fixed)
Admin role is currently stored in `users_v2.preferences` JSONB — users can self-escalate. Sprint 0 (S0-4) adds a dedicated `role` column with a trigger preventing self-escalation.

---

## Database Architecture

### Root Entity
`users_v2` — everything cascades from here on user deletion.

### Functional Root
`writing_projects_v2` — the concept around which all work revolves. A project has: outline (JSONB), chapters, story bible, cover art, social posts, research.

### Entity Hierarchy
```
users_v2 (ROOT)
├── genre_config_v2 (public + private, CASCADE)
├── story_arcs_v2 (public + private, CASCADE)
├── writing_projects_v2 (CASCADE)
│   ├── story_bible_v2 (CASCADE)
│   ├── outline_versions_v2 (CASCADE) ← DEAD TABLE, never written to
│   └── published_content_v2 (NO CASCADE — ORPHAN RISK, to be fixed to SET NULL)
│       └── content_versions_v2 (CASCADE)
├── research_reports_v2 (CASCADE)
├── app_config_v2 (CASCADE)
├── content_usage_v2 (CASCADE from user, RESTRICT from project/content)
└── [MISSING: generated_images_v2, social_posts_v2, token_usage_v2 — to be created]
```

### Known Data Issues
- `published_content_v2.project_id` FK has NO CASCADE — deleting a project orphans chapters
- `genre_slug` is a soft text reference everywhere (no FK) — deleting a genre orphans referencing content
- `outline_versions_v2` table exists but is never populated by any code
- `content_versions_v2` is populated on every save but no UI displays versions
- `discovery_question` column is missing from `story_arcs_v2` (TypeScript type expects it, DB doesn't have it)
- `token_usage_v2` table exists in production but is not in the SQL schema file

---

## Supabase Configuration

### V2 (Development/Active)
- **URL:** `https://faklxfakgzkpkbxfihzh.supabase.co`
- **Anon Key:** `sb_publishable_HsIkelEZaIr0VauiB3GgIQ_59XJRoWc`
- **Test User:** `user_id="+14105914612"`, display_name="Eric Beser"

### V1 (Production/Frozen — DO NOT MODIFY)
- **URL:** `https://qsirioazmsmrrfoltrhn.supabase.co`

### Auth Configuration
- Email/password enabled
- Google OAuth available (needs Google Cloud credentials)
- Redirect URLs: add `http://localhost:5173` and Railway production URL in Supabase Auth → URL Configuration

---

## n8n Configuration

- **URL:** `https://n8n.agileadautomation.com`
- **Webhook:** `/webhook/author_request_v2` (V2 hub)
- **API Key:** in `.mcp.json` (same repo root)
- **Hub Workflow ID:** `roMDypuMXHv6ugaZ`
- The hub receives `{ user_message_request, user_id }` and routes to 18 tool sub-workflows

---

## ElevenLabs Configuration

- **Beta Agent ID:** `agent_2801kks580vnf5q80j3bd0n0x45v` (Beta Writing Assistant)
- **Baseline Agent ID:** `agent_6401kjwqy66nfhabj82dvy8pnh2b` (DO NOT MODIFY)
- **Widget:** `<elevenlabs-convai agent-id="agent_2801kks580vnf5q80j3bd0n0x45v">` loaded from `https://unpkg.com/@elevenlabs/convai-widget-embed`
- **Configuration:** In ElevenLabs dashboard → Beta Writing Assistant → Widget tab. Ensure "Chat (text-only) mode" is OFF for voice.

---

## Project Structure

```
writers-workbench/
├── package.json              # npm workspaces root
├── .env                      # Local env vars (gitignored)
├── .env.example              # Template
├── Dockerfile                # Multi-stage for Railway
├── railway.toml              # Railway deployment config
├── supabase_auth_migration.sql  # Run in Supabase SQL Editor
├── AUDIT_REPORT.md           # Quality audit (127 deficiencies)
├── ARCHITECTURE_REVIEW.md    # V1 architectural review
├── ARCHITECTURE_REVIEW_V2.md # V2 review (data hierarchy, callbacks, task list)
├── sprint_document.md        # Complete sprint plan (52 stories, 8 sprints)
├── SESSION_CONTEXT.md        # THIS FILE
│
├── client/                   # React frontend
│   ├── src/
│   │   ├── App.tsx           # Routes — all pages wired
│   │   ├── config/           # supabase.ts, constants.ts
│   │   ├── contexts/         # AuthContext, UserContext
│   │   ├── hooks/            # useDashboardData
│   │   ├── lib/              # content-utils (markdown→HTML)
│   │   ├── types/            # database.ts (V2 schema types)
│   │   ├── test/             # setup.ts, test-utils.tsx
│   │   └── components/
│   │       ├── auth/         # Login, Signup, ForgotPassword, ResetPassword, Onboarding, AuthGuard
│   │       ├── layout/       # AppShell, Sidebar, TopBar
│   │       ├── dashboard/    # Dashboard (live counts + recent activity table)
│   │       ├── content/      # ContentList, ContentDetail (TipTap editor)
│   │       ├── projects/     # ProjectList, ProjectDetail (outline viewer, chapters, export)
│   │       ├── research/     # ResearchList (read-only, needs detail page)
│   │       ├── story-bible/  # StoryBiblePanel (read-only, needs CRUD)
│   │       ├── story-arcs/   # StoryArcBrowser (read-only, needs create/edit)
│   │       ├── outlines/     # OutlineList
│   │       ├── genres/       # GenreList, GenreForm (full CRUD with feeds)
│   │       ├── editor/       # RichTextEditor, EditorToolbar
│   │       ├── export/       # ExportDialog, PageSizeSelector
│   │       ├── chat/         # ChatDrawer (n8n webhook)
│   │       ├── eve/          # EveOrb, EveWidget (embed widget)
│   │       ├── settings/     # UserSettings
│   │       └── admin/        # AdminPanel (users + metrics)
│
└── server/                   # Express backend
    └── src/
        ├── index.ts          # Express app, serves static + API
        ├── routes/           # health, chat (proxy), export (docx), admin (stubs)
        └── services/         # supabase-admin (lazy init)
```

---

## Running Locally

```bash
cd writers-workbench
npm install
npm run dev          # starts client (5173) + server (3001) concurrently
npm run test         # runs all 31 tests (29 client + 2 server)
npm run build        # production build
```

Vite proxies `/api/*` to `localhost:3001` during dev.

---

## Git State

- **Branch:** `develop` (all work here)
- **Remote:** `origin` → `https://github.com/beserericl-hue/Automations.git`
- **13+ commits** for writers-workbench on develop, ahead of main
- **Do NOT push to main** without PR and testing

---

## Current Sprint Status

**All phases (0-10) of initial build are complete.** The application runs and is functional for basic viewing/editing. The sprint document defines 52 stories of remaining work to reach production quality.

**What works now:**
- Login/signup/onboarding with Supabase Auth
- Dashboard with live counts and recent activity
- All sidebar pages render with real data
- TipTap editor with auto-save (markdown→HTML conversion)
- Content status workflow (approve/publish/reject)
- Eve voice widget (ElevenLabs embed)
- Chat drawer (n8n webhook)
- Genre management with RSS feeds
- Story arc browser
- KDP export (.docx generation)
- 31 passing tests

**What doesn't work or is missing (see sprint_document.md for full list):**
- No delete operations anywhere
- No version history UI (versions saved but invisible)
- No server auth middleware (security vulnerability)
- No admin role protection (escalation vulnerability)
- No soft deletes
- No image persistence (ephemeral)
- No social media persistence (ephemeral)
- No web callback routing (Eve phone vs web)
- No pagination, no search
- No cost tracking UI
- Research reports not clickable/editable
- Story bible is read-only
- Outline versions never populated

---

## Constraints & Rules

1. **NEVER modify V1/baseline resources** (V1 workflows, baseline Eve agent, V1 webhook, production Supabase)
2. **All development on V2 resources** (V2 workflows, Beta Eve agent, V2 webhook, V2 Supabase)
3. **Git: commit to `develop`**, PR to `main` after testing
4. **Always verify code before deploying** — typecheck + build + tests
5. **Never use single quotes inside `$fromAI()` descriptions** (n8n bug)
6. **Content creation is via chat/Eve only** — no UI creation forms
7. **Run `npm run test` before every commit** — all 31 tests must pass
8. **Sprint execution: don't ask, just start.** When beginning a sprint, select the optimal implementation order based on dependencies and begin coding immediately. Do not ask the user to confirm the order.
9. **Sprint completion: update this document.** At the end of each sprint, append a sprint status section below documenting: stories completed, QA test results, any open issues, and what the next agent should pick up. This ensures continuity across sessions.

---

## Sprint Status Log

### Sprint 0 — Testing Infrastructure & Security Foundation
**Status:** COMPLETE (committed: `9cbe005`)
**Date:** 2026-04-11

All 9 stories delivered (34 points). Playwright installed, JWT auth middleware, CORS/helmet/rate-limiting, admin role column, zod validation, DOMPurify, test infrastructure.

---

### Sprint 1 — Data Integrity & Delete Operations
**Status:** COMPLETE (in working tree, uncommitted)
**Date:** 2026-04-11

All 7 stories delivered (34 points):
- S1-1: FK cascades fixed (SET NULL), soft delete columns added, discovery_question column added. Migration: `migrations/002_sprint1_data_integrity.sql`
- S1-2: Content delete with soft delete + cascade info in ConfirmDialog
- S1-3: Project delete with cascade impact display + TrashView with restore
- S1-4: Research report and story bible delete operations
- S1-5: VersionHistory.tsx — list/view/compare/restore modes with diff visualization
- S1-6: Reusable ConfirmDialog.tsx (danger/warning/default variants, keyboard support)
- S1-7: Unsaved changes warning (beforeunload + React Router useBlocker)

QA: `sprint1-qa.test.ts` exists. All soft delete queries filter `.is('deleted_at', null)`. Indexes created for `deleted_at` columns.

---

### Sprint 2 — UI Restructure & Navigation
**Status:** COMPLETE (in working tree, uncommitted)
**Date:** 2026-04-11

All 5 stories delivered (34 points):
- S2-1: Sidebar restructured — project-centric with expandable "My Projects" (live Supabase query, project count badge, status dots), "Content Library" link, collapsible "Reference" section (Genres, Story Arcs, Research). Removed 8 old flat nav items (Chapters, Short Stories, Blog Posts, Newsletters, Social Posts, Cover Art, Outlines, Story Bible). Collapsed (icon-only) mode preserved.
- S2-2: Content Library (`ContentLibrary.tsx`) — consolidated view replacing 4 content type pages. Filter bar: type, status, genre, project. Sortable columns. Bulk selection with checkboxes. Bulk actions: approve, publish, delete. URL param `?type=` for deep-linking. Legacy routes (`/chapters`, `/short-stories`, `/blog-posts`, `/newsletters`) redirect to `/library?type=X`.
- S2-3: Project Workspace tabs in `ProjectDetail.tsx` — 8 tabs: Overview (progress bar, word count, character cards, premise/themes), Outline (chapter list with sub-chapter outlines), Chapters (table with word counts, status badges, prev/next navigation), Story Bible (grouped by entry type), Art (placeholder), Research (filtered by project genre), Cost (placeholder), Export (exportable chapter count, word count, page size selector). Tab state persisted via URL `?tab=` param.
- S2-4: Breadcrumb resolves entity titles from Supabase (content and project UUIDs show actual titles). Global search bar in TopBar with Cmd/Ctrl+K shortcut — searches across projects, content, research with type icons and click-to-navigate. Mobile sidebar auto-collapses below `lg` breakpoint via `matchMedia` listener.
- S2-5: Reusable `Pagination.tsx` component with page numbers, ellipsis for large page counts, prev/next buttons, page size selector. Applied to: Content Library (default 25/page), ProjectList, ResearchList, GenreList (public genres section).

**Files created:**
- `client/src/components/content/ContentLibrary.tsx` (lazy-loaded via `React.lazy`)
- `client/src/components/shared/Pagination.tsx`
- `client/src/test/sprint2-qa.test.ts` (7 unit tests)
- `e2e/sprint2-navigation.spec.ts` (13 E2E tests)

**Files modified:**
- `client/src/App.tsx` — added `/library` route, legacy redirects, removed `Placeholder` component, added `Suspense` wrapper
- `client/src/components/layout/Sidebar.tsx` — complete rewrite with project-centric sections
- `client/src/components/layout/TopBar.tsx` — breadcrumb title resolution, global search, Cmd+K shortcut
- `client/src/components/layout/AppShell.tsx` — mobile-responsive sidebar default
- `client/src/components/projects/ProjectDetail.tsx` — complete rewrite as tabbed workspace
- `client/src/components/projects/ProjectList.tsx` — pagination added
- `client/src/components/research/ResearchList.tsx` — pagination added
- `client/src/components/genres/GenreList.tsx` — pagination added
- `client/src/hooks/useDashboardData.ts` — updated content type paths to `/library?type=X`

**QA Results (final run 2026-04-12):**

| Suite | Tests | Status |
|-------|-------|--------|
| Client unit tests (`npm run test --workspace=client`) | 80 (21 files) | All passing |
| Server unit tests (`npm run test --workspace=server`) | 46 (6 files) | All passing |
| E2E Chromium (`npx playwright test --project=chromium`) | 18 | All passing |
| E2E Firefox (`npx playwright test --project=firefox`) | 18 | All passing |
| TypeScript (`npx tsc -p client/tsconfig.json --noEmit`) | — | 0 errors |
| Production build (`npm run build`) | — | Succeeds |
| **Total** | **162** | **All passing** |

Sprint 2 unit tests (`client/src/test/sprint2-qa.test.ts`):
- Pagination `getPageNumbers` — small total, large total with ellipsis
- Content type label mapping (chapter, short_story, blog_post, newsletter)
- Breadcrumb labels — new nav labels present, old labels removed
- Tab definitions — all 8 Project Workspace tabs exist
- Route structure — 4 legacy routes map to `/library?type=X`

Sprint 2 E2E tests (`e2e/sprint2-navigation.spec.ts`):
- Unauthenticated user redirected to `/login`
- Legacy routes `/chapters`, `/short-stories`, `/blog-posts`, `/newsletters` redirect through auth guard
- New routes `/library`, `/projects`, `/genres`, `/story-arcs`, `/research`, `/trash` all exist
- Unknown route redirects to login
- Login page renders correctly

**What the next agent should do:**
- Sprint 2 work is uncommitted — commit to `develop` when ready
- Sprint 3 (CRUD Completeness & Data Management) is next: project edit form, story bible CRUD, story arc editor, research detail page, project metadata editing
- The `ContentList.tsx` component is now unused (replaced by `ContentLibrary.tsx`) — can be removed after confirming no imports
- Art tab and Cost tab are placeholders — they get filled in Sprint 4 and Sprint 5 respectively
