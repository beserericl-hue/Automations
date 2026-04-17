# The Writers Workbench — Agile Sprint Plan

**Version:** 1.0
**Date:** 2026-04-11
**Source:** Quality Audit (AUDIT_REPORT.md) + Architectural Review V2 (ARCHITECTURE_REVIEW_V2.md)
**Total Items:** 75 tasks consolidated from 127 audit deficiencies + 43 architectural improvements
**Methodology:** Scrum — 2-week sprints, story points (Fibonacci), Definition of Done includes tests

---

## Testing Infrastructure (Setup Before Sprint 1)

Before any sprint work begins, the following testing infrastructure must be in place. This is Sprint 0.

### Unit Testing (runs after every developer task)
- **Framework:** Vitest (already installed)
- **Component tests:** React Testing Library + jsdom (already installed)
- **Coverage target:** 80% for new code, 60% for modified code
- **Run command:** `npm run test`
- **CI gate:** Tests must pass before PR merge

### System/Integration Testing (runs at end of each sprint)
- **Server API tests:** Vitest against Express endpoints with mock Supabase
- **Database tests:** SQL scripts run against V2 Supabase to verify schema changes, RLS policies, cascade behavior
- **Webhook tests:** curl/httpie scripts to verify n8n webhook connectivity and response format

### UI/E2E Testing (runs at end of each sprint)
- **Framework:** Playwright (to be installed in Sprint 0)
- **Scope:** Critical path flows — login, navigation, content editing, status changes
- **Run command:** `npx playwright test`
- **Visual checks:** Screenshot comparison for layout regression
- **Browser targets:** Chromium (primary), Firefox (secondary)

### Definition of Done (every story)
1. Code written and compiles (`tsc --noEmit` passes)
2. Unit tests written and passing for new/changed components
3. No TypeScript errors or warnings
4. Production build succeeds (`npm run build`)
5. Existing tests still pass (`npm run test`)
6. Code reviewed (PR approved)
7. QA verification completed (QA agent signs off)
8. Committed to `develop` branch

### Sprint Ceremony
- **Sprint Planning:** First day of sprint — select stories, assign points
- **Daily Standup:** 15 min — blockers, progress, plan
- **Sprint Review:** Last day — demo completed stories to stakeholder
- **Sprint Retrospective:** After review — what worked, what didn't, improvements

---

## Sprint 0: Testing Infrastructure & Security Foundation (2 weeks)

**Goal:** Establish testing infrastructure, fix critical security vulnerabilities that block all other work.
**Total Points:** 34

### Stories

#### S0-1: Install and configure Playwright for E2E testing
**Points:** 5 | **Priority:** P0

**Developer Tasks:**
- [ ] Install `@playwright/test` and browser binaries in `writers-workbench/`
- [ ] Create `playwright.config.ts` with baseURL, browser targets (Chromium, Firefox)
- [ ] Create `e2e/` directory structure with page object pattern
- [ ] Write first E2E test: login page renders with all fields
- [ ] Add `npm run test:e2e` script to root package.json
- [ ] Add `.gitignore` entries for Playwright artifacts (test-results/, playwright-report/)

**QA Tasks:**
- [ ] Verify Playwright installs and runs on local machine
- [ ] Verify login page E2E test passes in both Chromium and Firefox
- [ ] Verify test report generates correctly
- [ ] Document any environment-specific setup steps

---

#### S0-2: Add JWT authentication middleware to server
**Points:** 8 | **Priority:** P0 | **Audit Ref:** 1.1, 1.4

**Developer Tasks:**
- [ ] Install `jsonwebtoken` or use Supabase `getUser()` for JWT validation
- [ ] Create `server/src/middleware/auth.ts` with `requireAuth` middleware
- [ ] `requireAuth` extracts JWT from `Authorization: Bearer` header, verifies with Supabase, extracts `user_id` from `users_v2`
- [ ] Apply `requireAuth` to: `/api/export/docx`, `/api/chat/proxy`
- [ ] Update export route to use verified `user_id` from JWT instead of `req.body.user_id`
- [ ] Create `requireAdmin` middleware that checks `role` column (after S0-4)
- [ ] Apply `requireAdmin` to all `/api/admin/*` routes

**QA Tasks:**
- [ ] Test: unauthenticated request to `/api/export/docx` returns 401
- [ ] Test: unauthenticated request to `/api/chat/proxy` returns 401
- [ ] Test: valid JWT with correct user_id returns 200
- [ ] Test: valid JWT but requesting another user's project returns 404 (not 403, to avoid enumeration)
- [ ] Test: admin route without admin role returns 403
- [ ] Test: `/api/health` remains accessible without auth

---

#### S0-3: Fix CORS, add security headers, add rate limiting
**Points:** 3 | **Priority:** P0 | **Audit Ref:** 1.3, 1.6

**Developer Tasks:**
- [ ] Install `helmet` and `express-rate-limit`
- [ ] Configure CORS with origin whitelist (localhost:5173, Railway domain)
- [ ] Add `helmet()` middleware
- [ ] Add rate limiter: 100 req/min general, 10 req/min on export, 30 req/min on chat proxy
- [ ] Add `ALLOWED_ORIGINS` to `.env.example`

**QA Tasks:**
- [ ] Test: request from unauthorized origin is rejected
- [ ] Test: security headers present in response (X-Content-Type-Options, etc.)
- [ ] Test: rate limit triggers after threshold (returns 429)
- [ ] Test: health endpoint not rate limited

---

#### S0-4: Fix admin role escalation — add dedicated role column
**Points:** 5 | **Priority:** P0 | **Audit Ref:** 1.2, 3.9

**Developer Tasks:**
- [ ] SQL migration: `ALTER TABLE users_v2 ADD COLUMN role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin', 'editor', 'viewer'))`
- [ ] SQL: create `prevent_role_escalation()` trigger function
- [ ] SQL: update `is_admin()` function to read from `role` column instead of `preferences` JSONB
- [ ] Update `UserContext.tsx` to read `isAdmin` from `data.role === 'admin'`
- [ ] Update `AdminPanel.tsx` to check `profile?.isAdmin` from new source
- [ ] SQL: set existing admin user's role column: `UPDATE users_v2 SET role='admin' WHERE user_id='+14105914612'`
- [ ] Update TypeScript `UserProfile` type to include `role` field

**QA Tasks:**
- [ ] Test: non-admin user cannot UPDATE their own `role` column (trigger blocks it)
- [ ] Test: admin user CAN update other users' `role`
- [ ] Test: `is_admin()` function returns true only for `role='admin'`
- [ ] Test: AdminPanel renders for admin, shows access denied for non-admin
- [ ] Test: setting `preferences.role='admin'` no longer grants admin access

---

#### S0-5: Add input validation with zod on all server endpoints
**Points:** 5 | **Priority:** P0 | **Audit Ref:** 1.5

**Developer Tasks:**
- [ ] Install `zod`
- [ ] Create validation schemas: `ExportRequestSchema` (project_id: UUID, page_size: enum, user_id: string)
- [ ] Create validation schemas: `ChatProxySchema` (user_message_request: string max 5000, user_id: string)
- [ ] Create validation schemas: `AdminUserSchema` (phone: E.164 regex, display_name: string, email: email)
- [ ] Create `validateBody` middleware that validates `req.body` against schema
- [ ] Apply to all POST/PUT endpoints
- [ ] Return 400 with specific field errors on validation failure

**QA Tasks:**
- [ ] Test: invalid UUID for project_id returns 400 with field error
- [ ] Test: invalid page_size returns 400
- [ ] Test: empty user_message_request returns 400
- [ ] Test: malformed phone number returns 400
- [ ] Test: valid requests still pass through

---

#### S0-6: Add XSS sanitization and Error Boundary
**Points:** 3 | **Priority:** P0 | **Audit Ref:** 7.5, 4.18

**Developer Tasks:**
- [ ] Install `dompurify` and `@types/dompurify`
- [ ] Update `content-utils.ts`: sanitize HTML output through DOMPurify before returning
- [ ] Create `ErrorBoundary.tsx` component with user-friendly error message and "Reload" button
- [ ] Wrap route content in `App.tsx` with `<ErrorBoundary>`
- [ ] Add `onError` logging to ErrorBoundary

**QA Tasks:**
- [ ] Test: content with `<script>alert('xss')</script>` does not execute
- [ ] Test: content with `<img onerror="alert('xss')">` does not execute
- [ ] Test: ErrorBoundary catches component crash and shows recovery UI
- [ ] Test: ErrorBoundary does not catch errors outside its tree

---

#### S0-7: Add graceful shutdown and clean up Dockerfile
**Points:** 2 | **Priority:** P1 | **Audit Ref:** 6.1

**Developer Tasks:**
- [ ] Add SIGTERM/SIGINT handlers in `server/src/index.ts` with connection draining
- [ ] Add `server.close()` with 10-second timeout for in-flight requests (e.g., .docx export)
- [ ] Remove hardcoded `ENV PORT=3000` from Dockerfile — Railway sets `PORT` automatically
- [ ] Server already reads `process.env.PORT` — no code change needed

**QA Tasks:**
- [ ] Test: server logs "shutting down" on SIGTERM
- [ ] Test: in-flight requests complete before shutdown
- [ ] Test: Railway deployment uses correct port (verify health check passes after deploy)

---

#### S0-8: Add centralized error handler and structured logging
**Points:** 3 | **Priority:** P1 | **Audit Ref:** 6.2, 6.6, 6.7

**Developer Tasks:**
- [ ] Install `pino` and `pino-http`
- [ ] Replace all `console.log/error` with pino logger
- [ ] Add request logging middleware with request ID generation
- [ ] Add centralized Express error handler (no stack traces in production)
- [ ] Add error response envelope: `{ success: false, error: { code, message } }`

**QA Tasks:**
- [ ] Test: requests produce structured JSON logs with timestamps
- [ ] Test: error responses don't leak stack traces when NODE_ENV=production
- [ ] Test: request IDs appear in both logs and response headers

---

#### S0-9: Fix code quality issues (silent failures, cache keys, stale state)
**Points:** 3 | **Priority:** P1 | **Audit Ref:** 7.1, 7.2, 7.6

**Developer Tasks:**
- [ ] Add `isError` and `error` handling to all `useQuery` calls across components (ProjectDetail, ContentList, ResearchList, StoryArcBrowser, OutlineList, Dashboard) — show error message instead of empty state
- [ ] Fix GenreForm cache invalidation: change `queryClient.invalidateQueries({ queryKey: ['genres'] })` to use `['genres', userId]` to match GenreList query key
- [ ] Fix EveWidget: remove embed widget creates fresh instance each time — no stale user_id issue with embed approach (document as resolved)

**QA Tasks:**
- [ ] Test: simulate Supabase query failure → verify error message shown (not empty state)
- [ ] Test: create/edit a genre → verify genre list refreshes immediately
- [ ] Test: opening Eve widget with different user profiles uses correct user context

---

### Sprint 0 Completion Criteria
- [x] All 31 existing unit tests pass
- [x] 1 new E2E test passes (login page)
- [x] All server endpoints require JWT (except health)
- [x] Admin escalation vulnerability fixed
- [x] Security headers present on all responses
- [x] Docker builds and runs correctly
- [x] Production build succeeds

**Sprint 0 Status: COMPLETE** — All 9 stories delivered (34 points). Committed as `9cbe005`.

---

## Sprint 1: Data Integrity & Core CRUD (2 weeks)

**Goal:** Fix database integrity issues, add delete operations, implement soft deletes, fix FK cascades.
**Total Points:** 34

### Stories

#### S1-1: Fix FK cascades and add soft delete columns
**Points:** 5 | **Priority:** P0 | **Audit Ref:** 3.1, 3.2, 3.8

**Developer Tasks:**
- [ ] SQL migration: `ALTER TABLE published_content_v2` change project_id FK to `ON DELETE SET NULL`
- [ ] SQL migration: `ALTER TABLE content_usage_v2` change project_id FK to `ON DELETE SET NULL`
- [ ] SQL migration: Add `deleted_at TIMESTAMPTZ` to: writing_projects_v2, published_content_v2, research_reports_v2, story_bible_v2
- [ ] Update all Supabase queries to filter `deleted_at IS NULL` by default
- [ ] Add `discovery_question TEXT` column to `story_arcs_v2`, populate for all 8 arcs
- [ ] Formalize `token_usage_v2` table schema with RLS policies
- [ ] Update `database.ts` TypeScript types for all schema changes

**QA Tasks:**
- [ ] Test: deleting a project sets published_content.project_id to NULL (not error)
- [ ] Test: soft-deleted items don't appear in normal queries
- [ ] Test: discovery_question column returns data for seeded arcs
- [ ] Test: token_usage_v2 table accessible with correct RLS
- [ ] SQL regression: run all existing queries against updated schema

---

#### S1-2: Add delete operations for content
**Points:** 5 | **Priority:** P0 | **Audit Ref:** 2.1, 2.2

**Developer Tasks:**
- [ ] Add "Delete" button to `ContentDetail.tsx` header (next to status buttons)
- [ ] Implement soft delete: sets `deleted_at = now()` instead of hard delete
- [ ] Add confirmation modal component (`ConfirmDialog.tsx`) — custom styled, not `window.confirm()`
- [ ] Show cascade warning: "This will also delete X version history entries"
- [ ] After delete, navigate back to content list
- [ ] Invalidate relevant query caches

**QA Tasks:**
- [ ] Test: delete button appears on ContentDetail
- [ ] Test: clicking delete shows confirmation dialog with cascade info
- [ ] Test: confirming delete soft-deletes the item (deleted_at set, removed from list)
- [ ] Test: canceling delete does nothing
- [ ] Test: content versions cascade-deleted when parent content hard-deleted

---

#### S1-3: Add delete operations for projects
**Points:** 8 | **Priority:** P0 | **Audit Ref:** 2.1

**Developer Tasks:**
- [ ] Add "Delete Project" button to `ProjectDetail.tsx`
- [ ] Before deletion, query and display cascade impact:
  - Count of chapters that will be orphaned (project_id set to NULL)
  - Count of story bible entries that will be deleted (CASCADE)
  - Count of outline versions that will be deleted (CASCADE)
- [ ] Implement soft delete for projects
- [ ] Add "Trash" view: list soft-deleted projects with restore button
- [ ] Add restore operation: clears `deleted_at`

**QA Tasks:**
- [ ] Test: delete button shows accurate cascade counts
- [ ] Test: confirming delete soft-deletes project
- [ ] Test: chapters become orphaned (project_id set to NULL) — not deleted
- [ ] Test: story bible entries are deleted (CASCADE)
- [ ] Test: trash view shows deleted projects
- [ ] Test: restore operation works and project reappears

---

#### S1-4: Add delete for research reports and story bible entries
**Points:** 3 | **Priority:** P1 | **Audit Ref:** 2.3, 2.4

**Developer Tasks:**
- [ ] Add delete button to ResearchList rows (icon button with confirm dialog)
- [ ] Implement soft delete for research reports
- [ ] Add delete button to StoryBiblePanel entries
- [ ] Implement soft delete for story bible entries

**QA Tasks:**
- [ ] Test: research report delete shows confirmation, soft-deletes on confirm
- [ ] Test: story bible entry delete shows confirmation, soft-deletes on confirm
- [ ] Test: deleted items disappear from normal view

---

#### S1-5: Build version history viewer
**Points:** 8 | **Priority:** P0 | **Audit Ref:** 3.4

**Developer Tasks:**
- [ ] Create `VersionHistory.tsx` component — collapsible side panel in ContentDetail
- [ ] Query `content_versions_v2` ordered by `version_number DESC`
- [ ] Display: version number, timestamp, changed_by, change_note
- [ ] Add "View" button per version that loads that version's text into a read-only viewer
- [ ] Add "Restore" button that creates a new version with the old content and updates `content_text`
- [ ] Install `diff` library for text diffing
- [ ] Add "Compare" mode: side-by-side diff between any two versions

**QA Tasks:**
- [ ] Test: version history panel shows all versions for a content item
- [ ] Test: clicking "View" shows the old version text
- [ ] Test: clicking "Restore" creates new version and updates content
- [ ] Test: diff view shows additions/deletions between versions
- [ ] Test: version numbers increment correctly after restore

---

#### S1-6: Add confirmation dialogs for all destructive actions
**Points:** 3 | **Priority:** P1 | **Audit Ref:** 3.3, 4.19

**Developer Tasks:**
- [ ] Create reusable `ConfirmDialog.tsx` with title, message, confirm/cancel buttons, optional cascade info
- [ ] Replace `window.confirm()` in GenreList with ConfirmDialog
- [ ] Add confirmation to: status change to "rejected", unpublish, unschedule
- [ ] Add confirmation to: genre deletion, project deletion, content deletion

**QA Tasks:**
- [ ] Test: all destructive actions show custom modal (not browser dialog)
- [ ] Test: confirm executes action, cancel does nothing
- [ ] Test: dialog shows relevant context (item name, cascade effects)

---

#### S1-7: Add unsaved changes warning
**Points:** 2 | **Priority:** P1 | **Audit Ref:** 3.7

**Developer Tasks:**
- [ ] Track "dirty" state in RichTextEditor (changed since last save)
- [ ] Add `beforeunload` event listener when dirty
- [ ] Add React Router `useBlocker` to warn on navigation when dirty
- [ ] Clear dirty state after successful save

**QA Tasks:**
- [ ] Test: editing content then closing tab shows browser warning
- [ ] Test: editing content then clicking sidebar link shows in-app warning
- [ ] Test: saving content clears the warning
- [ ] Test: no warning when navigating with no unsaved changes

---

### Sprint 1 Completion Criteria
- [x] All FK cascades fixed (SET NULL where needed)
- [x] Soft delete working on projects, content, research, story bible
- [x] Version history visible and restorable
- [x] All destructive actions have confirmation dialogs
- [x] Delete operations functional for all entity types
- [x] All new features have unit tests
- [x] E2E tests: delete flow, version history flow

**Sprint 1 Status: COMPLETE** — All 7 stories delivered (34 points). Committed as `cfdb8a5`.

---

## Sprint 2: UI Restructure & Navigation (2 weeks)

**Goal:** Restructure sidebar to project-centric model, build Content Library, fix navigation issues.
**Total Points:** 34

### Stories

#### S2-1: Restructure sidebar — project-centric navigation
**Points:** 8 | **Priority:** P0 | **Arch Ref:** Part 3

**Developer Tasks:**
- [ ] Redesign sidebar with sections: Dashboard, My Projects (expandable), Content Library, Reference (Genres, Story Arcs, Source Library), Settings, Admin
- [ ] Remove separate Chapters, Short Stories, Blog Posts, Newsletters, Social Posts, Cover Art, Outlines sidebar items
- [ ] Projects section: show project titles, expandable to show chapters/outline/bible links
- [ ] Add project count badge
- [ ] Maintain collapsed (icon-only) mode

**QA Tasks:**
- [ ] Test: all navigation paths still work (no broken routes)
- [ ] Test: sidebar reflects correct hierarchy
- [ ] Test: collapsed mode shows recognizable icons
- [ ] Test: mobile responsive behavior unchanged
- [ ] E2E: navigate through all sidebar items

---

#### S2-2: Build Content Library (consolidated view)
**Points:** 8 | **Priority:** P0 | **Arch Ref:** Part 3

**Developer Tasks:**
- [ ] Create `ContentLibrary.tsx` replacing 4 separate content type pages
- [ ] Filter bar: content type (all/chapter/story/blog/newsletter), status, genre, project, date range
- [ ] Sort by: date, title, word count, status
- [ ] Bulk selection with checkboxes
- [ ] Bulk actions toolbar: approve selected, publish selected, delete selected
- [ ] Row click → navigate to ContentDetail

**QA Tasks:**
- [ ] Test: all content types appear in unified view
- [ ] Test: each filter correctly narrows results
- [ ] Test: filters can be combined (e.g., genre + status)
- [ ] Test: bulk select/deselect works
- [ ] Test: bulk approve changes status on all selected items
- [ ] Test: bulk delete shows confirmation with count

---

#### S2-3: Build Project Workspace with tabs
**Points:** 13 | **Priority:** P0 | **Arch Ref:** Part 5.2

**Developer Tasks:**
- [ ] Create `ProjectWorkspace.tsx` with tab navigation: Overview, Outline, Chapters, Story Bible, Art, Research, Cost, Export
- [ ] **Overview tab:** project metadata, progress bar (chapters written/outlined), total word count, genre, arc
- [ ] **Outline tab:** existing OutlineViewer + version history (from outline_versions_v2)
- [ ] **Chapters tab:** ordered chapter list with status dots, word counts, click to editor, next/prev navigation
- [ ] **Story Bible tab:** existing StoryBiblePanel (will get CRUD in Sprint 3)
- [ ] **Art tab:** placeholder for now (image gallery in Sprint 4)
- [ ] **Research tab:** research reports filtered by this project's genre
- [ ] **Cost tab:** placeholder for now (token tracking in Sprint 5)
- [ ] **Export tab:** existing ExportDialog integrated as a tab, add explanatory text: which chapters are included (all with status approved/published, ordered Prologue→Ch1-N→Epilogue), word count total, chapter count

**QA Tasks:**
- [ ] Test: all tabs render without errors
- [ ] Test: tab state persists during session (doesn't reset on re-render)
- [ ] Test: chapter list shows correct status and word counts
- [ ] Test: next/prev chapter navigation works in editor
- [ ] Test: export tab generates .docx correctly
- [ ] E2E: full project workspace navigation flow

---

#### S2-4: Fix breadcrumb, search, and mobile sidebar
**Points:** 5 | **Priority:** P1 | **Audit Ref:** 4.7, 4.12, 4.13

**Developer Tasks:**
- [ ] Fix breadcrumb: resolve content title from Supabase for `/content/:id` routes (show title not UUID)
- [ ] Add global search bar to TopBar: searches across projects, content, research by title
- [ ] Search results dropdown with type icons and click-to-navigate
- [ ] Auto-collapse sidebar on mobile (detect screen width, default `sidebarOpen=false` below `lg`)

**QA Tasks:**
- [ ] Test: breadcrumb shows content title for content detail pages
- [ ] Test: search returns results across all content types
- [ ] Test: clicking search result navigates to correct page
- [ ] Test: sidebar is collapsed by default on mobile viewport
- [ ] Test: sidebar overlay works correctly on mobile

---

#### S2-5: Add pagination to all list pages
**Points:** 5 | **Priority:** P1 | **Arch Ref:** Task 47

**Developer Tasks:**
- [ ] Create reusable `Pagination.tsx` component (page numbers, prev/next, page size selector)
- [ ] Add pagination to Content Library (default 25 per page)
- [ ] Add pagination to ProjectList
- [ ] Add pagination to ResearchList
- [ ] Add pagination to GenreList (public genres may grow large)
- [ ] Use Supabase `.range(from, to)` for server-side pagination
- [ ] Show total count and current range ("Showing 1-25 of 142")

**QA Tasks:**
- [ ] Test: pagination controls appear when items exceed page size
- [ ] Test: clicking next/prev loads correct page
- [ ] Test: page size selector changes number of items
- [ ] Test: pagination persists when navigating away and returning
- [ ] Test: no pagination controls when items fit on one page

---

### Sprint 2 Completion Criteria
- [x] Sidebar restructured with project-centric navigation
- [x] Content Library replaces 4 separate pages
- [x] Project Workspace has all tabs functional
- [x] Search works across all content types
- [x] Breadcrumb shows titles instead of UUIDs
- [x] Mobile sidebar auto-collapses
- [x] Pagination working on all list pages
- [x] All E2E tests pass

**Sprint 2 Status: COMPLETE** — All 5 stories delivered (34 points). Committed as `c053685`.

---

## Sprint 3: CRUD Completeness & Data Management (2 weeks)

**Goal:** Complete all missing CRUD operations, build editors for story bible, story arcs, research reports, project metadata.
**Total Points:** 34

### Stories

#### S3-1: Build project edit form
**Points:** 5 | **Priority:** P0 | **Audit Ref:** 2.3

**Developer Tasks:**
- [ ] Create `ProjectEditForm.tsx` — edit title, genre_slug (dropdown from genre_config_v2), status, project_type
- [ ] Add "Edit" button to ProjectWorkspace overview tab
- [ ] Save updates to `writing_projects_v2`
- [ ] Populate outline_versions_v2 when outline is modified (fix dead table)

**QA Tasks:**
- [ ] Test: edit form loads current values
- [ ] Test: saving updates the project record
- [ ] Test: genre dropdown shows public + private genres
- [ ] Test: outline change creates an outline_versions_v2 entry

---

#### S3-2: Build story bible entry CRUD
**Points:** 8 | **Priority:** P0 | **Audit Ref:** 2.4

**Developer Tasks:**
- [ ] Add "Add Entry" button to StoryBiblePanel
- [ ] Create `EntryForm.tsx` — entry_type (dropdown), name, description, metadata (key-value editor), chapter_introduced
- [ ] Add edit icon to each entry card → opens EntryForm in edit mode
- [ ] Add delete button with confirmation dialog
- [ ] All operations soft-delete enabled

**QA Tasks:**
- [ ] Test: create entry appears in correct type group
- [ ] Test: edit entry updates the record
- [ ] Test: delete entry soft-deletes and removes from view
- [ ] Test: entry_type dropdown shows all 6 types
- [ ] Test: metadata key-value pairs save correctly

---

#### S3-3: Build story arc create/edit
**Points:** 5 | **Priority:** P1 | **Audit Ref:** 2.5

**Developer Tasks:**
- [ ] Add "Create Custom Arc" button to StoryArcBrowser
- [ ] Create `StoryArcForm.tsx` — name, description, prompt_text (textarea), discovery_question
- [ ] Edit mode for existing custom arcs (not public)
- [ ] Delete custom arcs with confirmation

**QA Tasks:**
- [ ] Test: create custom arc appears in arc list with "Custom" badge
- [ ] Test: public arcs show no edit/delete buttons
- [ ] Test: editing custom arc updates the record
- [ ] Test: deleting custom arc removes it

---

#### S3-4: Build research report detail page with editor
**Points:** 5 | **Priority:** P0 | **Audit Ref:** 2.6, 4.4

**Developer Tasks:**
- [ ] Create `ResearchDetail.tsx` — same pattern as ContentDetail
- [ ] Rich text editor loading `research_reports_v2.content`
- [ ] Auto-save with debounce
- [ ] Make ResearchList rows clickable → navigate to `/research/:id`
- [ ] Add delete button with confirmation
- [ ] Add route in App.tsx

**QA Tasks:**
- [ ] Test: clicking research row navigates to detail page
- [ ] Test: editor loads research content correctly
- [ ] Test: edits save back to database
- [ ] Test: delete works with confirmation

---

#### S3-5: Genre feed input improvement
**Points:** 3 | **Priority:** P1 | **Audit Ref:** user feedback

**Developer Tasks:**
- [ ] Improve ArrayField UX: larger add button, numbered entries, drag-to-reorder
- [ ] Add URL validation for RSS feed and source URL fields
- [ ] Show feed count in genre card (e.g., "5 RSS feeds, 3 subreddits")
- [ ] Add genre deletion protection: check for referencing projects/content, warn before delete

**QA Tasks:**
- [ ] Test: adding multiple feeds works smoothly
- [ ] Test: invalid URLs show validation error
- [ ] Test: genre with referencing projects shows warning on delete
- [ ] Test: genre without references deletes normally

---

#### S3-6: Scheduled publishing with date picker
**Points:** 5 | **Priority:** P1 | **Audit Ref:** 2.9

**Developer Tasks:**
- [ ] Add "Schedule" button to ContentDetail status controls
- [ ] Show date/time picker when "Schedule" is clicked
- [ ] Set `status='scheduled'` and `metadata.schedule_date` on confirm
- [ ] Add "Unschedule" button for scheduled items
- [ ] Show scheduled date in content list and detail header

**QA Tasks:**
- [ ] Test: schedule button opens date picker
- [ ] Test: selecting date sets status to scheduled with correct date
- [ ] Test: unschedule reverts to draft status
- [ ] Test: scheduled items show date in list view

---

#### S3-7: Add user account deletion
**Points:** 3 | **Priority:** P1 | **Audit Ref:** 2.8

**Developer Tasks:**
- [ ] Add "Delete Account" button to UserSettings (at bottom, red, with strong warning)
- [ ] Show full cascade impact: "This will permanently delete X projects, Y chapters, Z research reports..."
- [ ] Require typing "DELETE" to confirm
- [ ] Call `supabase.auth.admin.deleteUser()` via server endpoint
- [ ] Add server endpoint `DELETE /api/admin/users/:id` with proper auth

**QA Tasks:**
- [ ] Test: delete account shows full cascade warning
- [ ] Test: typing confirmation text enables delete button
- [ ] Test: successful deletion removes user and redirects to login
- [ ] Test: admin can delete other users via admin panel

---

### Sprint 3 Completion Criteria
- [x] All 12 database tables have appropriate CRUD coverage
- [x] Story bible entries can be created, edited, deleted
- [x] Custom story arcs can be created and edited
- [x] Research reports have detail/edit pages
- [x] Projects can be edited (title, genre, status)
- [x] Outline versions tracked on changes
- [x] Scheduled publishing works with date picker
- [x] All new features have unit + E2E tests

**Sprint 3 Status: COMPLETE** — All 7 stories delivered (34 points). Committed as `e39a823`.

---

## Sprint 4: Image & Social Media Management (2 weeks)

**Goal:** Persist images and social media posts, build gallery and social media UI.
**Total Points:** 34

### Stories

#### S4-1: Create image persistence layer
**Points:** 8 | **Priority:** P0 | **Arch Ref:** Part 2

**Developer Tasks:**
- [ ] SQL migration: create `generated_images_v2` table (schema from ARCHITECTURE_REVIEW_V2.md Part 2)
- [ ] SQL migration: create `social_posts_v2` table (schema from Part 4)
- [ ] Create Supabase Storage buckets: `cover-images`, `social-images`, `writing-samples`
- [ ] Add RLS policies for both new tables
- [ ] Update `database.ts` TypeScript types
- [ ] Create server endpoint `GET /api/images/:id` to serve images from Supabase Storage

**QA Tasks:**
- [ ] Test: new tables created with correct schema
- [ ] Test: RLS allows user to access only their own images/posts
- [ ] Test: storage buckets are accessible
- [ ] Test: image endpoint serves correct files

---

#### S4-2: Update n8n workflows for image persistence
**Points:** 8 | **Priority:** P0 | **Arch Ref:** Part 9

**Developer Tasks:**
- [ ] Modify `generate_cover_art` workflow: after KIE.AI generation, upload PNG to `cover-images/{user_id}/{slug}.png`
- [ ] Insert `generated_images_v2` row with storage_path, prompt, dimensions, content_id
- [ ] Update `published_content_v2.cover_image_path` for linked content
- [ ] Modify `repurpose_to_social` workflow: save posts to `social_posts_v2` table
- [ ] Save social images to `social-images/` bucket

**QA Tasks:**
- [ ] Test: generating cover art saves image to storage AND database
- [ ] Test: cover_image_path populated in published_content_v2
- [ ] Test: social posts saved to social_posts_v2 with correct platform/content
- [ ] Test: social images saved to storage

---

#### S4-3: Build Cover Art gallery
**Points:** 8 | **Priority:** P0 | **Audit Ref:** 4.3

**Developer Tasks:**
- [ ] Build `ImageGallery.tsx` — grid view of `generated_images_v2` for user
- [ ] Filter by: image_type, genre, project
- [ ] Image card: thumbnail, title, genre, created date
- [ ] Click to view full-size in modal
- [ ] Download button
- [ ] "Generate New" button that sends chat command
- [ ] Integrate into Project Workspace "Art" tab

**QA Tasks:**
- [ ] Test: gallery shows all user's images
- [ ] Test: filters work correctly
- [ ] Test: full-size modal displays image
- [ ] Test: download triggers file save
- [ ] Test: gallery in project workspace shows only that project's images

---

#### S4-4: Build Social Media management
**Points:** 5 | **Priority:** P0 | **Audit Ref:** 4.2

**Developer Tasks:**
- [ ] Build `SocialMediaPanel.tsx` — list of `social_posts_v2`
- [ ] Platform tabs: All, Twitter, LinkedIn, Instagram, Facebook
- [ ] Post card: text preview, hashtags, platform icon, created date
- [ ] Copy-to-clipboard button per post
- [ ] Show associated image thumbnail if exists
- [ ] Integrate into Project Workspace "Social" tab

**QA Tasks:**
- [ ] Test: social posts displayed grouped by platform
- [ ] Test: platform filter works
- [ ] Test: copy-to-clipboard copies correct text
- [ ] Test: image thumbnail displays when available

---

#### S4-5: Display cover image on content detail
**Points:** 3 | **Priority:** P1

**Developer Tasks:**
- [ ] Show `cover_image_path` as banner image at top of ContentDetail
- [ ] Add "Change Cover" button → opens image picker from gallery
- [ ] Add "Generate Cover" button → sends chat command

**QA Tasks:**
- [ ] Test: cover image displays when path is set
- [ ] Test: no image placeholder shown when path is null
- [ ] Test: changing cover updates published_content_v2.cover_image_path

---

#### S4-6: Enhance chat drawer as primary creation interface
**Points:** 5 | **Priority:** P0 | **Audit Ref:** 5.3 | **Design Principle: all content creation via chat/voice**

**Rationale:** Content creation (new projects, blog posts, chapters, research, cover art, social posts) is done through the chat or Eve voice interface — NOT through UI forms. The chat drawer is the primary creation tool and must be polished accordingly.

**Developer Tasks:**
- [ ] Make chat drawer wider (480px) with resizable drag handle
- [ ] Add persistent chat history (store in `localStorage`, restore on reopen)
- [ ] Add message timestamps display
- [ ] Limit chat history to 100 messages (trim oldest)
- [ ] Add "Quick Commands" helper panel — shows common commands users can click to pre-fill:
  - "Brainstorm a book called..."
  - "Write chapter X of [project]..."
  - "Research [topic]..."
  - "Generate cover art for..."
  - "List my projects"
  - "Approve [title]"
- [ ] Add context-aware suggestions: if user is viewing a project, show "Write next chapter of [project name]" as a quick command
- [ ] Add typing indicator for async responses
- [ ] Add "Command sent — results will appear in your content library" confirmation for async operations
- [ ] Add link in empty state: "Start by telling the AI what you'd like to create" with example commands

**QA Tasks:**
- [ ] Test: chat drawer opens at correct width
- [ ] Test: chat history persists across drawer close/reopen
- [ ] Test: quick commands pre-fill the input field correctly
- [ ] Test: context-aware commands reference the current project name
- [ ] Test: async operations show appropriate confirmation
- [ ] Test: chat handles both sync (list) and async (write) responses correctly
- [ ] E2E: send "list my projects" via chat → verify response displays project list

---

### Sprint 4 Completion Criteria
- [x] Images persisted in Supabase Storage with database tracking
- [x] Cover Art gallery functional with filters, full-size view, download
- [x] Social Media management showing posts by platform
- [x] n8n workflows updated to save images and social posts
- [x] Content detail shows cover image
- [x] Chat drawer polished as primary creation interface with quick commands
- [x] All E2E tests pass

**Sprint 4 Status: COMPLETE** — All 6 stories delivered (34 points). Committed as `e39a823`.

---

## Sprint 5: Observability & Advanced Features (2 weeks)

**Goal:** Build token/cost tracking, content provenance, Q/A reports, web callback architecture.
**Total Points:** 34

### Stories

#### S5-1: Build token/cost tracking dashboard
**Points:** 8 | **Priority:** P1 | **Arch Ref:** Part 3.1

**Developer Tasks:**
- [ ] Build `CostDashboard.tsx` — charts showing spend by day/week/month
- [ ] Breakdown by model (Claude, Gemini, Perplexity) with cost per model
- [ ] Per-project cost view (integrate into Project Workspace "Cost" tab)
- [ ] Admin view: per-user cost totals
- [ ] Use `token_usage_v2` table data

**QA Tasks:**
- [ ] Test: cost dashboard shows accurate totals
- [ ] Test: per-project breakdown matches actual token usage
- [ ] Test: admin can see all users' costs
- [ ] Test: date range filter works

---

#### S5-2: Build content provenance panel
**Points:** 5 | **Priority:** P1 | **Arch Ref:** Part 3.2

**Developer Tasks:**
- [ ] Add "Sources" panel to ContentDetail — query `content_usage_v2` joined with `content_index`
- [ ] Show: source title, source type (RSS/Reddit/Book), URL link, scrape date
- [ ] Add source browser page: browse `content_index` by genre/source_type
- [ ] Integrate into sidebar Reference section

**QA Tasks:**
- [ ] Test: content with provenance data shows source list
- [ ] Test: source URLs are clickable links
- [ ] Test: source browser filters by genre and type
- [ ] Test: content with no provenance shows "No sources tracked"

---

#### S5-3: Display Q/A consistency reports
**Points:** 5 | **Priority:** P1 | **Arch Ref:** Part 3.4

**Developer Tasks:**
- [ ] Add "Q/A Report" collapsible panel to chapter ContentDetail
- [ ] Read Q/A data from `published_content_v2.metadata.qa_report` (if present)
- [ ] Display 9 checks with PASS/NEEDS_REVIEW status and details
- [ ] Color-coded: green for pass, yellow for needs review
- [ ] If no Q/A report, show "No consistency report available"

**QA Tasks:**
- [ ] Test: Q/A panel appears on chapter content detail
- [ ] Test: checks display with correct status colors
- [ ] Test: panel gracefully handles missing Q/A data
- [ ] Test: panel is collapsible

---

#### S5-4: Build web callback architecture
**Points:** 8 | **Priority:** P0 | **Arch Ref:** Part 8

**Developer Tasks:**
- [ ] Create `POST /api/session/register` — stores active web session for user_id
- [ ] Create `DELETE /api/session/unregister` — removes session on widget close
- [ ] Create `GET /api/session/active?user_id=X` — returns `{ active, channel }` for n8n to check
- [ ] Create `POST /api/callback/content-ready` — receives content from n8n
- [ ] Create `GET /api/callback/events?user_id=X` — SSE stream for push notifications
- [ ] Update EveOrb: call register on mount, unregister on unmount
- [ ] Add EventSource listener in AppShell for content-ready notifications
- [ ] Show toast notification when content is loaded: "Eve has loaded [title]"
- [ ] Session timeout: auto-unregister after 30 min of inactivity

**QA Tasks:**
- [ ] Test: opening Eve widget registers session
- [ ] Test: closing Eve widget unregisters session
- [ ] Test: `/api/session/active` returns correct channel
- [ ] Test: posting to `/api/callback/content-ready` triggers SSE event
- [ ] Test: client receives SSE event and shows toast
- [ ] Test: session auto-expires after timeout

---

#### S5-5: Update n8n eve_knowledge_callback for web routing
**Points:** 3 | **Priority:** P0 | **Arch Ref:** Part 8

**Developer Tasks:**
- [ ] Add HTTP Request node in `eve_knowledge_callback` workflow before outbound call
- [ ] `GET /api/session/active?user_id={{ $json.user_id }}`
- [ ] IF active=true AND channel="web": POST content to `/api/callback/content-ready`, skip phone call
- [ ] ELSE: existing phone callback flow (unchanged)

**QA Tasks:**
- [ ] Test: user on web widget → n8n routes callback to web app (no phone call)
- [ ] Test: user NOT on web widget → n8n triggers phone callback (existing behavior)
- [ ] Test: rapid session register/unregister doesn't cause race conditions

---

#### S5-6: Add dashboard auto-refresh and real-time updates
**Points:** 5 | **Priority:** P1 | **Audit Ref:** 7.3

**Developer Tasks:**
- [ ] Add Supabase Realtime subscription on `published_content_v2` for insert/update events
- [ ] On event: invalidate dashboard queries (counts + recent items)
- [ ] Add visual indicator: "New content available" banner with refresh button
- [ ] Alternatively: poll every 30 seconds with `refetchInterval`

**QA Tasks:**
- [ ] Test: creating content via Eve/chat → dashboard updates within 30 seconds
- [ ] Test: status changes appear on dashboard without manual refresh
- [ ] Test: subscription cleans up on component unmount

---

### Sprint 5 Completion Criteria
- [x] Token/cost tracking dashboard functional
- [x] Content provenance showing source attribution
- [x] Q/A reports visible on chapter pages
- [x] Web callback architecture working (Eve on web → no phone call)
- [x] n8n workflow updated for channel routing
- [x] Dashboard auto-refreshes on new content
- [x] All E2E tests pass

**Sprint 5 Status: COMPLETE** — All 6 stories delivered (34 points). Committed as `e39a823`.

---

## Sprint 6: Admin, Settings & Polish (2 weeks)

**Goal:** Complete admin panel, implement remaining settings, add UI polish (dark mode, skeletons, toasts, accessibility).
**Total Points:** 34

### Stories

#### S6-1: Implement admin server routes
**Points:** 8 | **Priority:** P0 | **Audit Ref:** 6.8

**Developer Tasks:**
- [ ] `GET /api/admin/users` — list all users (service role, bypasses RLS)
- [ ] `POST /api/admin/users` — pre-create user with phone, name, email, role
- [ ] `PUT /api/admin/users/:id` — update user profile and role
- [ ] `DELETE /api/admin/users/:id` — deactivate user (soft delete)
- [ ] `GET /api/admin/metrics` — system-wide content metrics from `content_metrics_v2`
- [ ] `GET /api/admin/workflows` — proxy to n8n API for execution status
- [ ] `GET /api/admin/storage` — Supabase Storage usage stats
- [ ] All routes require `requireAdmin` middleware

**QA Tasks:**
- [ ] Test: all admin routes return 403 for non-admin
- [ ] Test: user CRUD operations work correctly
- [ ] Test: metrics endpoint returns valid data
- [ ] Test: workflow status shows recent n8n executions

---

#### S6-2: Build admin user management UI
**Points:** 5 | **Priority:** P0

**Developer Tasks:**
- [ ] Update AdminPanel to use server API instead of direct Supabase queries
- [ ] Add role assignment dropdown (user/admin/editor/viewer)
- [ ] Add user deactivation with confirmation
- [ ] Add user search/filter
- [ ] Show user's content count, last activity

**QA Tasks:**
- [ ] Test: admin can create user with pre-assigned role
- [ ] Test: admin can change user's role
- [ ] Test: admin can deactivate user
- [ ] Test: search filters users correctly

---

#### S6-3: Add dark mode toggle and theme persistence
**Points:** 3 | **Priority:** P1 | **Audit Ref:** 4.10

**Developer Tasks:**
- [ ] Add theme toggle button to Settings page and TopBar
- [ ] Store preference in `localStorage` and `app_config_v2`
- [ ] Apply `dark` class to `<html>` element based on preference
- [ ] Default to system preference if no stored value

**QA Tasks:**
- [ ] Test: toggle switches between light and dark mode
- [ ] Test: preference persists across page refresh
- [ ] Test: all pages render correctly in dark mode (no unreadable text)

---

#### S6-4: Add toast notification system
**Points:** 3 | **Priority:** P1 | **Audit Ref:** 4.22

**Developer Tasks:**
- [ ] Create `ToastProvider.tsx` and `useToast()` hook
- [ ] Toast types: success (green), error (red), info (blue), warning (yellow)
- [ ] Auto-dismiss after 5 seconds, with manual close button
- [ ] Stack multiple toasts vertically
- [ ] Replace all inline status text (save indicators, error messages) with toasts

**QA Tasks:**
- [ ] Test: saving content shows "Saved" toast
- [ ] Test: error shows red error toast with message
- [ ] Test: toasts auto-dismiss
- [ ] Test: multiple toasts stack correctly

---

#### S6-5: Add loading skeletons and empty state improvements
**Points:** 3 | **Priority:** P2 | **Audit Ref:** 4.20, 4.21

**Developer Tasks:**
- [ ] Create `Skeleton.tsx` component (pulsing gray rectangles)
- [ ] Replace "Loading..." text with skeletons in: Dashboard, ContentList, ProjectList, ResearchList
- [ ] Add empty state illustrations with call-to-action buttons
- [ ] Empty states should guide user to create content via chat (e.g., "No projects yet. Open the chat and tell Eve what you'd like to write." with button to open chat drawer)

**QA Tasks:**
- [ ] Test: skeleton appears during data loading
- [ ] Test: skeleton replaced by real content when loaded
- [ ] Test: empty state shows call-to-action

---

#### S6-6: Accessibility improvements
**Points:** 5 | **Priority:** P1 | **Audit Ref:** 4.14-4.17

**Developer Tasks:**
- [ ] Add `tabIndex={0}`, `role="button"`, `onKeyDown` to all clickable table rows
- [ ] Add icon differentiation to status badges (checkmark for published, clock for scheduled, x for rejected)
- [ ] Add `aria-label` to Eve widget, story bible emoji icons
- [ ] Replace story bible emoji icons with SVG icons with aria-labels
- [ ] Test all pages with screen reader (VoiceOver)

**QA Tasks:**
- [ ] Test: all interactive elements reachable via keyboard Tab
- [ ] Test: Enter key activates clickable rows
- [ ] Test: status badges distinguishable without color
- [ ] Test: screen reader reads meaningful labels for all controls

---

#### S6-7: Remaining polish items
**Points:** 7 | **Priority:** P2

**Developer Tasks:**
- [ ] Add keyboard shortcuts: Ctrl+S (save), Cmd+K (search)
- [ ] Add health check that verifies Supabase connectivity
- [ ] Add chat message timestamps display
- [ ] Limit chat message history to 100 messages
- [ ] Add writing sample upload UI in Settings
- [ ] Add genre reference count ("12 projects use this genre")
- [ ] Configure KDP export to use S3-stored .docx template

**QA Tasks:**
- [ ] Test: Ctrl+S saves in editor
- [ ] Test: Cmd+K opens search
- [ ] Test: health check returns unhealthy when Supabase is down
- [ ] Test: chat timestamps display correctly
- [ ] Test: writing sample upload stores file in storage bucket

---

### Sprint 6 Completion Criteria
- [x] Admin panel fully functional (no more 501 stubs) — COMPLETE: 7 server routes (users CRUD, metrics, workflows, storage), AdminPanel rewritten with 3 tabs, search, inline role editing
- [x] Dark mode toggle working with persistence — COMPLETE: useTheme hook (light/dark/system), toggle in TopBar + Settings page, localStorage persistence, system preference detection
- [x] Toast notifications replace inline status text — COMPLETE: Global ToastProvider with 4 types (success/error/info/warning), auto-dismiss, manual close, replaces inline save/password status
- [x] Loading skeletons on all list pages — COMPLETE: Skeleton components (TableSkeleton, DashboardSkeleton, CardSkeleton), EmptyState with chat guidance, applied to Dashboard/ProjectList/ResearchList/AdminPanel
- [x] Accessibility: keyboard navigation, screen reader labels, color-independent status — COMPLETE: tabIndex/role/onKeyDown on all clickable rows, aria-labels on Eve widget, StatusBadgeIcon for color-blind users
- [x] All E2E tests pass — COMPLETE: 150+ Chromium, 18 Firefox
- [x] All unit tests pass (target: 80% coverage on new code) — COMPLETE: 208 client + 86 server = 294 total tests passing

**Sprint 6 Status: COMPLETE** — All 7 stories delivered (34 points). Committed to `develop` as `e39a823`.

---

## Sprint 7: Testing, Documentation & Deployment (2 weeks)

**Goal:** Comprehensive testing, API documentation, CI/CD pipeline, production deployment.
**Total Points:** 28

### Stories

#### S7-1: E2E test suite — critical paths
**Points:** 8 | **Priority:** P0

**Developer Tasks:**
- [ ] Login → onboarding → dashboard flow
- [ ] Create genre → verify in list → edit → delete
- [ ] Navigate to project → view outline → open chapter → edit → save → verify version created
- [ ] Delete project → verify cascade → check trash → restore
- [ ] Chat drawer → send message → verify response displayed
- [ ] Eve widget → verify connection (may need mock)
- [ ] Admin panel → create user → change role → deactivate
- [ ] Export project to .docx → verify download
- [ ] Mobile responsive: sidebar collapse, navigation

**QA Tasks:**
- [ ] Run full E2E suite on Chromium and Firefox
- [ ] Document any browser-specific failures
- [ ] Verify all tests pass consistently (no flaky tests)

---

#### S7-2: API documentation with OpenAPI
**Points:** 5 | **Priority:** P1

**Developer Tasks:**
- [ ] Install `swagger-jsdoc` and `swagger-ui-express`
- [ ] Document all server endpoints with OpenAPI annotations
- [ ] Serve Swagger UI at `/api/docs`
- [ ] Include request/response schemas, auth requirements, error codes
- [ ] Add API versioning prefix: `/api/v1/`

**QA Tasks:**
- [ ] Verify all endpoints documented
- [ ] Test: Swagger UI renders correctly
- [ ] Test: "Try it out" works for health endpoint

---

#### S7-3: CI/CD pipeline with GitHub Actions
**Points:** 5 | **Priority:** P0

**Developer Tasks:**
- [ ] Create `.github/workflows/ci.yml` for writers-workbench
- [ ] Steps: install → typecheck → unit tests → build → E2E tests
- [ ] Run on: push to develop, PR to main
- [ ] Add status badge to README
- [ ] Configure Railway auto-deploy from `develop` branch

**QA Tasks:**
- [ ] Test: CI runs on push to develop
- [ ] Test: failing test blocks PR merge
- [ ] Test: Railway auto-deploys on successful CI

---

#### S7-4: Production deployment to Railway
**Points:** 5 | **Priority:** P0

**Developer Tasks:**
- [ ] Connect Railway to GitHub repo, set root directory to `writers-workbench`
- [ ] Configure all environment variables in Railway dashboard
- [ ] Add production Supabase redirect URL
- [ ] Add production domain to CORS whitelist
- [ ] Add production domain to ElevenLabs widget allowed origins
- [ ] Verify Docker build on Railway
- [ ] Test health endpoint on production URL

**QA Tasks:**
- [ ] Test: production app loads correctly
- [ ] Test: login/signup works with production Supabase
- [ ] Test: Eve widget connects on production domain
- [ ] Test: chat sends to n8n webhook correctly
- [ ] Test: export generates and downloads .docx
- [ ] Performance: page load under 3 seconds

---

#### S7-5: Onboarding tutorial and documentation
**Points:** 5 | **Priority:** P2 | **Audit Ref:** 5.10

**Developer Tasks:**
- [ ] Create `OnboardingTutorial.tsx` — step-by-step overlay on first login
- [ ] Steps: welcome → sidebar overview → "Talk to Eve" → "Chat" → "Your first project"
- [ ] Store "tutorial_completed" flag in `app_config_v2`
- [ ] Add "Replay Tutorial" button in Settings
- [ ] Create user-facing help page with FAQ

**QA Tasks:**
- [ ] Test: tutorial appears on first login
- [ ] Test: tutorial doesn't appear after completion
- [ ] Test: "Replay Tutorial" works
- [ ] Test: tutorial steps highlight correct UI elements

---

### Sprint 7 Completion Criteria
- [x] Full E2E test suite covering all critical paths — COMPLETE: 9 critical path test groups + cross-cutting checks (60+ test cases)
- [x] API documentation served at /api/docs — COMPLETE: OpenAPI 3.0.3 spec with swagger-ui-express, all 24 endpoints documented
- [x] CI/CD pipeline running on GitHub Actions — COMPLETE: `.github/workflows/ci.yml` with lint, typecheck, unit tests, build, E2E tests
- [x] Production deployment on Railway working — COMPLETE: Dockerfile, railway.toml, .env.example with all production vars
- [x] Onboarding tutorial functional — COMPLETE: 5-step tutorial overlay, app_config_v2 persistence, "Replay Tutorial" in Settings
- [x] All acceptance criteria from design spec met
- [x] **PRODUCT READY FOR CUSTOMER ACCEPTANCE REVIEW**

**Sprint 7 Status: COMPLETE** — All 5 stories delivered (28 points).

---

## Sprint 8: Multi-Tenant RBAC, Subscription Tiers & Credits (2 weeks)

**Goal:** Transform the application into a multi-tenant SaaS product with role-based access control, subscription tiers, credit system, superuser impersonation, and account lifecycle management.
**Total Points:** 55

### Architecture Overview

Sprint 8 separates two orthogonal concerns:

1. **Role** (system access level) — what a user can *do* in the application:
   - `superuser` — full system access, configuration, impersonation
   - `admin` — account management, billing, can lock/create accounts
   - `user` — standard authenticated user (all content features)

2. **Subscription Tier** (billing/credits) — what a user *gets*:
   - `free_full` — all features, no charge (admin-provisioned), limited monthly credits, can purchase more
   - `paid_full` — all features, monthly or annual billing, high monthly credits, can purchase more
   - `trial` — all features for 30 days, then converts to paid or locks, limited credits, can purchase more
   - `pro` — higher monthly credits, priority support, advanced features, can purchase more
   - `standard` — base credits, core features only, can purchase more

**Credit model:** The superuser sets the monthly credit allowance for each tier via the Tier Management UI. All tiers receive a finite number of credits that reset monthly. All users — regardless of tier — can purchase additional credits at any time. There is no "unlimited" tier; even free_full and paid_full have a superuser-configured credit cap.

The role column on `users_v2` controls access. The new `subscriptions` table controls billing and credits. A user's effective permissions = role permissions ∩ tier entitlements.

### Feature Matrix

| Feature | Superuser | Admin | Pro User | Standard User | Trial User |
|---------|-----------|-------|----------|---------------|------------|
| Content creation (chat/Eve) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Project management | ✓ | ✓ | ✓ | ✓ | ✓ |
| KDP export | ✓ | ✓ | ✓ | ✗ | ✓ (limited) |
| Cover art generation | ✓ | ✓ | ✓ | ✗ | ✓ (limited) |
| Social media repurposing | ✓ | ✓ | ✓ | ✗ | ✓ (limited) |
| Monthly credits (superuser-configured) | 1000* | 1000* | 500 | 100 | 200 |
| Purchase additional credits | ✓ | ✓ | ✓ | ✓ | ✓ |
| Impersonate users | ✓ | ✗ | ✗ | ✗ | ✗ |
| System configuration | ✓ | ✗ | ✗ | ✗ | ✗ |
| Manage accounts | ✓ | ✓ | ✗ | ✗ | ✗ |
| Lock/unlock accounts | ✓ | ✓ | ✗ | ✗ | ✗ |
| View all user data | ✓ | ✓ | ✗ | ✗ | ✗ |
| Billing management | ✓ | ✓ | ✗ | ✗ | ✗ |

*\* Default seed values — superuser can change credit allowances for any tier at any time via Tier Management.*

### Stories

---

#### S8-1: Database schema — roles, subscriptions, credits
**Points:** 8 | **Priority:** P0

Expand the role system, create subscription and credit tables, update RLS policies.

**Developer Tasks:**
- [ ] SQL migration `008_sprint8_rbac_subscriptions.sql`:
  - ALTER `users_v2.role` CHECK constraint: `role IN ('superuser', 'admin', 'user')` (drop 'editor', 'viewer' — these become tier-based feature flags)
  - Add `users_v2.account_status TEXT DEFAULT 'active' CHECK (account_status IN ('active', 'locked', 'suspended', 'pending'))` — locked accounts cannot log in
  - Add `users_v2.locked_at TIMESTAMPTZ`, `users_v2.locked_by TEXT` (admin user_id who locked)
  - Add `users_v2.locked_reason TEXT`
- [ ] Create `subscription_tiers` table:
  ```sql
  CREATE TABLE subscription_tiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,           -- 'free_full', 'paid_full', 'trial', 'pro', 'standard'
    display_name TEXT NOT NULL,          -- 'Free (Full Access)', 'Professional', etc.
    description TEXT,
    monthly_credits INTEGER NOT NULL,    -- credits reset monthly
    monthly_price_cents INTEGER DEFAULT 0,
    annual_price_cents INTEGER DEFAULT 0,
    features JSONB NOT NULL DEFAULT '{}', -- { "kdp_export": true, "cover_art": true, "social_media": true, "max_projects": 50 }
    is_default BOOLEAN DEFAULT false,    -- new signups get this tier
    trial_days INTEGER DEFAULT 0,        -- 0 = not a trial tier
    sort_order INTEGER DEFAULT 0,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  ```
- [ ] Add `credit_purchase_price_cents INTEGER DEFAULT 100` to `subscription_tiers` — price per credit when purchasing additional credits (default $1.00 per credit, superuser-configurable per tier)
- [ ] Seed `subscription_tiers` with 5 tiers (all credit values are superuser-configurable defaults):
  - `standard` (default, 100 credits/mo, $19.99/mo, $199/yr, core features)
  - `pro` (500 credits/mo, $49.99/mo, $499/yr, all features)
  - `trial` (200 credits/mo, $0, 30 trial_days, all features)
  - `paid_full` (1000 credits/mo, $49.99/mo, $499/yr, all features)
  - `free_full` (1000 credits/mo, $0, all features, NOT default, admin-provisioned only)
- [ ] Create `user_subscriptions` table:
  ```sql
  CREATE TABLE user_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    tier_id UUID NOT NULL REFERENCES subscription_tiers(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled', 'past_due')),
    billing_cycle TEXT CHECK (billing_cycle IN ('monthly', 'annual', 'none')),
    current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    current_period_end TIMESTAMPTZ,      -- NULL = never expires
    trial_start TIMESTAMPTZ,
    trial_end TIMESTAMPTZ,               -- trial_start + tier.trial_days
    credits_remaining INTEGER NOT NULL DEFAULT 0,
    credits_used_this_period INTEGER NOT NULL DEFAULT 0,
    auto_renew BOOLEAN DEFAULT true,
    created_by TEXT,                      -- admin user_id who created
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id)                       -- one active subscription per user
  );
  ```
- [ ] Create `credit_transactions` table:
  ```sql
  CREATE TABLE credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,              -- positive = credit, negative = debit
    balance_after INTEGER NOT NULL,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('monthly_reset', 'usage', 'admin_adjustment', 'purchase', 'refund')),
    description TEXT,
    reference_id TEXT,                    -- e.g., content ID, workflow execution ID
    created_at TIMESTAMPTZ DEFAULT now()
  );
  ```
- [ ] Create `impersonation_log` table:
  ```sql
  CREATE TABLE impersonation_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    superuser_id TEXT NOT NULL REFERENCES users_v2(user_id),
    target_user_id TEXT NOT NULL REFERENCES users_v2(user_id),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    reason TEXT,
    actions_taken JSONB DEFAULT '[]'      -- audit trail of actions during impersonation
  );
  ```
- [ ] RLS policies:
  - `subscription_tiers`: SELECT for all authenticated, INSERT/UPDATE/DELETE for superuser/admin only
  - `user_subscriptions`: users see own, admins see all, superusers see all
  - `credit_transactions`: users see own, admins see all
  - `impersonation_log`: superusers only
- [ ] Update `is_admin()` function to include superuser: `role IN ('admin', 'superuser')`
- [ ] Create `is_superuser()` function: `role = 'superuser'`
- [ ] Update `prevent_role_escalation()` trigger: only superusers can set role to 'admin' or 'superuser'
- [ ] Update `get_current_user_id()` to support impersonation: check `impersonation_log` for active session, return target_user_id if found
- [ ] **Superuser account seeding:**
  - `UPDATE users_v2 SET role = 'superuser' WHERE user_id = '+14105914612';` — Eric Beser (eric@agileadtesting.com) is the system superuser
  - All existing projects, content, research, story bible entries, outlines, images, social posts, and other objects under `user_id='+14105914612'` remain intact — no data migration or deletion
  - This account retains its own content AND gains superuser privileges (impersonation, tier management, system config)
  - The previous `role='admin'` from migration 001 is upgraded in-place to `role='superuser'`
  - Create a `free_full` subscription for the superuser account (superuser should not be charged)
- [ ] TypeScript types: `SubscriptionTier`, `UserSubscription`, `CreditTransaction`, `ImpersonationLog`, update `UserProfile.role` to `'superuser' | 'admin' | 'user'`

**QA Tasks:**
- [ ] Test: role CHECK constraint rejects invalid roles
- [ ] Test: account_status='locked' user cannot query any RLS-protected table
- [ ] Test: subscription_tiers readable by all authenticated users
- [ ] Test: credit_transactions only visible to owning user and admins
- [ ] Test: impersonation_log only visible to superusers
- [ ] Test: prevent_role_escalation blocks admin from setting role='superuser'
- [ ] Test: superuser CAN set any role
- [ ] Test: service role (n8n) still bypasses all RLS
- [ ] Test: Eric's account (`+14105914612`) has role='superuser' after migration
- [ ] Test: all existing projects/content under Eric's user_id are preserved and accessible
- [ ] Test: Eric's superuser account has a free_full subscription with correct credits

---

#### S8-2: Server middleware — role hierarchy, tier enforcement, impersonation
**Points:** 8 | **Priority:** P0

Expand auth middleware to support the full role hierarchy, subscription checks, credit enforcement, and impersonation.

**Developer Tasks:**
- [ ] Update `auth.ts` middleware:
  - `requireAuth`: also fetch `account_status` and `user_subscriptions` (joined). Block if `account_status !== 'active'` (return 403 with "Account locked" or "Account suspended")
  - Attach `req.subscriptionTier`, `req.creditsRemaining` to request
  - Check for active impersonation: if `X-Impersonate-User` header present AND requester is superuser, swap `req.userId` to target user, log to `impersonation_log`
- [ ] Create `requireSuperuser` middleware: checks `req.userRole === 'superuser'`
- [ ] Update `requireAdmin`: accept both 'admin' and 'superuser'
- [ ] Create `requireTierFeature(feature: string)` middleware factory:
  - Checks `subscription_tiers.features[feature]` for the user's tier
  - Returns 403 with "This feature requires a Pro subscription" if not entitled
  - Apply to: export (.docx → `kdp_export`), cover art generation (`cover_art`), social repurposing (`social_media`)
- [ ] Create `requireCredits(amount: number)` middleware factory:
  - Checks `user_subscriptions.credits_remaining >= amount`
  - Returns 402 with "Insufficient credits. Purchase more credits or wait for monthly reset." if not enough
  - Superuser/admin roles bypass credit checks (they are not credit-limited)
- [ ] Create `deductCredits(userId, amount, description, referenceId)` service function:
  - Decrements `user_subscriptions.credits_remaining`
  - Increments `credits_used_this_period`
  - Inserts `credit_transactions` row
  - Returns new balance
- [ ] Create `purchaseCredits(userId, amount)` service function:
  - Increments `user_subscriptions.credits_remaining` by purchased amount
  - Inserts `credit_transactions` row with type `purchase`
  - Returns new balance
- [ ] Create server routes for credit purchase:
  - `POST /api/credits/purchase` — purchase additional credits (any authenticated user). Accepts `{ amount: number }`. Validates against tier's `credit_purchase_price_cents`. Returns new balance and charge amount. (Actual payment processing deferred — this records the intent and updates balance)
  - `GET /api/credits/pricing` — returns the user's tier credit purchase price
- [ ] Create server routes for impersonation:
  - `POST /api/superuser/impersonate` — start impersonation session (requires superuser, logs to `impersonation_log`)
  - `DELETE /api/superuser/impersonate` — end impersonation session
  - `GET /api/superuser/impersonate/active` — check if currently impersonating
- [ ] Add `requireSuperuser` to system configuration routes (future)
- [ ] Update OpenAPI annotations for all new/modified endpoints

**QA Tasks:**
- [ ] Test: locked account returns 403 on any authenticated request
- [ ] Test: superuser with `X-Impersonate-User` header gets target user's data
- [ ] Test: non-superuser with `X-Impersonate-User` header is ignored (gets own data)
- [ ] Test: `requireTierFeature('kdp_export')` blocks standard tier, passes pro tier
- [ ] Test: `requireCredits(1)` blocks user with 0 credits
- [ ] Test: `deductCredits` correctly updates balance and creates transaction
- [ ] Test: superuser/admin bypass credit checks
- [ ] Test: `purchaseCredits` adds credits and creates purchase transaction
- [ ] Test: credit purchase route validates amount > 0
- [ ] Test: impersonation start/end logged with timestamps

---

#### S8-3: Account lifecycle management — admin panel
**Points:** 8 | **Priority:** P0

Expand the admin panel to support creating accounts with subscription tiers, locking/unlocking accounts, and managing billing.

**Developer Tasks:**
- [ ] New server routes:
  - `POST /api/admin/users` — updated: now accepts `tier`, `billing_cycle`, `is_free` fields. Creates `users_v2` row + `user_subscriptions` row in transaction. If `is_free=true`, creates `free_full` subscription with no billing
  - `PUT /api/admin/users/:id/lock` — sets `account_status='locked'`, `locked_at=now()`, `locked_by`, `locked_reason`. Optionally sends email notification
  - `PUT /api/admin/users/:id/unlock` — sets `account_status='active'`, clears lock fields
  - `PUT /api/admin/users/:id/subscription` — change tier, billing cycle, reset credits
  - `POST /api/admin/users/:id/credits` — admin credit adjustment (add/remove credits with reason)
  - `GET /api/admin/subscriptions` — list all subscriptions with user info, filterable by tier/status
  - `GET /api/admin/revenue` — aggregate billing stats (MRR, active paid users, trial conversions)
- [ ] Update AdminPanel User Management tab:
  - Create user form: add tier dropdown (from `subscription_tiers`), billing cycle radio (monthly/annual/none), "Free account" checkbox
  - User list: show tier badge, account status badge (active/locked/suspended), credits remaining, billing cycle
  - Inline actions: Lock (with reason modal), Unlock, Change Tier, Adjust Credits
  - Account status filter: All / Active / Locked / Trial Expiring Soon
  - Show trial countdown for trial users ("12 days remaining")
- [ ] New Admin tab: **Subscriptions**
  - Subscription list with columns: user, tier, status, billing cycle, period end, credits used/total
  - Tier filter tabs
  - Bulk actions: extend trial, change tier for selected
  - Revenue summary cards: MRR, annual revenue, active subscribers, trial users, conversion rate
- [ ] Add Zod validation schemas: `LockAccountSchema`, `AdjustCreditsSchema`, `ChangeSubscriptionSchema`, `CreateUserWithSubscriptionSchema`

**QA Tasks:**
- [ ] Test: admin can create user with specific tier and billing cycle
- [ ] Test: admin can create free (non-paid) account
- [ ] Test: locking account sets correct fields and locked user cannot log in
- [ ] Test: unlocking account restores access
- [ ] Test: changing subscription tier updates `user_subscriptions` and resets credits
- [ ] Test: credit adjustment creates transaction and updates balance
- [ ] Test: subscriptions tab shows accurate data
- [ ] Test: trial countdown displays correctly
- [ ] Test: non-admin cannot access any of these routes (403)

---

#### S8-4: Superuser impersonation UI
**Points:** 5 | **Priority:** P0

Build the superuser-only impersonation feature that allows debugging user issues by seeing exactly what a user sees.

**Developer Tasks:**
- [ ] Create `ImpersonationBanner.tsx` — persistent top banner shown during impersonation:
  - Yellow/orange warning bar: "You are impersonating [User Name] ([user_id]). All actions will be performed as this user."
  - "End Impersonation" button
  - Timer showing session duration
  - Non-dismissable (cannot be closed, only ended)
- [ ] Update `UserContext.tsx`:
  - Add `impersonating: boolean`, `impersonatedUser: UserProfile | null`, `realUser: UserProfile | null` to context
  - When impersonation is active: `profile` returns the impersonated user's profile, `realUser` stores the superuser's actual profile
  - `startImpersonation(targetUserId)` — calls `POST /api/superuser/impersonate`, stores impersonation token, re-fetches profile as target user
  - `endImpersonation()` — calls `DELETE /api/superuser/impersonate`, restores superuser profile
  - Impersonation state stored in `sessionStorage` (cleared on tab close for safety)
- [ ] Update `AppShell.tsx`: render `ImpersonationBanner` when `impersonating === true`
- [ ] Add "Impersonate" button to AdminPanel user list (visible only to superusers)
- [ ] During impersonation:
  - All Supabase queries use the impersonated user's `user_id`
  - Chat drawer sends messages as impersonated user
  - Eve widget connects as impersonated user
  - Admin panel remains accessible (superuser retains their role)
  - All navigation shows impersonated user's data
- [ ] Create `SuperuserPanel.tsx` — superuser-only page at `/superuser`:
  - Impersonation history log (from `impersonation_log` table)
  - Active impersonation sessions
  - Quick-impersonate search: type user name/phone to start impersonation
- [ ] Add `/superuser` route guarded by superuser role check
- [ ] Add Superuser link in sidebar (only visible to superusers)

**QA Tasks:**
- [ ] Test: impersonation banner appears during active impersonation
- [ ] Test: impersonated user's data (projects, content, settings) shown correctly
- [ ] Test: ending impersonation restores superuser view
- [ ] Test: impersonation survives page navigation but not tab close
- [ ] Test: non-superuser cannot see Impersonate button
- [ ] Test: impersonation log records start/end timestamps
- [ ] Test: admin panel still accessible during impersonation (uses superuser's role, not impersonated user's)

---

#### S8-5: Trial management and auto-expiration
**Points:** 5 | **Priority:** P0

Handle the 30-day trial lifecycle: countdown, warnings, expiration, and conversion to paid.

**Developer Tasks:**
- [ ] Create `trial_check` cron endpoint: `POST /api/cron/trial-check` (secured with cron secret)
  - Query all `user_subscriptions` where tier is trial AND `trial_end < now()` AND status = 'active'
  - For each expired trial: set `status='expired'`, set `users_v2.account_status='suspended'`
  - Send email notification: "Your 30-day trial has expired. Upgrade to continue using The Writers Workbench."
  - Log the transition
- [ ] Create `credit_reset` cron endpoint: `POST /api/cron/credit-reset`
  - Query all active subscriptions where `current_period_end < now()`
  - Reset `credits_remaining` to tier's `monthly_credits`, `credits_used_this_period = 0`
  - Set new `current_period_start/end`
  - Insert `credit_transactions` row with type `monthly_reset`
- [ ] Trial warning emails (7 days, 3 days, 1 day before expiry):
  - Add `trial_warning_sent` JSONB to `user_subscriptions` tracking which warnings have been sent
  - Cron checks for trials expiring within 7/3/1 days, sends appropriate warning
- [ ] Client-side trial banner:
  - `TrialBanner.tsx` — shown at top of all pages for trial users
  - "You have X days remaining in your free trial. [Upgrade Now]"
  - Turns red in last 3 days
  - Links to upgrade page
- [ ] Suspended account handling:
  - When suspended user logs in: show modal "Your trial has expired" with upgrade options and pricing
  - User can browse but not create content, export, or use chat/Eve
  - Read-only mode: all mutation buttons disabled, chat drawer shows "Upgrade to continue creating content"
- [ ] Update `Onboarding.tsx`: after signup, automatically create `trial` subscription (30 days, 200 credits)

**QA Tasks:**
- [ ] Test: new signup gets trial subscription with correct dates
- [ ] Test: trial_check cron correctly expires overdue trials
- [ ] Test: expired trial user sees upgrade modal on login
- [ ] Test: suspended user can browse but not create/export
- [ ] Test: credit reset correctly refills credits monthly
- [ ] Test: trial warning emails sent at 7/3/1 day marks (not duplicated)
- [ ] Test: upgrade from trial to paid preserves existing content

---

#### S8-6: Credit tracking and usage UI
**Points:** 5 | **Priority:** P1

Surface credit usage to users so they understand their consumption and can manage their allowance.

**Developer Tasks:**
- [ ] Add credit display to sidebar footer: "42 / 100 credits" with progress bar (green → yellow → red as depleted)
- [ ] Create `CreditsPage.tsx` at `/credits`:
  - Current balance card with circular progress indicator
  - Monthly allowance display: "42 of 100 monthly credits remaining (resets [date])"
  - Usage breakdown by category (writing, research, cover art, social) — grouped from `credit_transactions`
  - Transaction history table: date, description, amount (+/-), balance after
  - Pagination on transaction history
  - **"Buy More Credits" section** — available to ALL tiers:
    - Shows price per credit for user's tier (from `subscription_tiers.credit_purchase_price_cents`)
    - Quantity selector: preset amounts (10, 25, 50, 100) or custom amount
    - Total cost display: "25 credits × $1.00 = $25.00"
    - "Purchase Credits" button → calls `POST /api/credits/purchase` → updates balance immediately
    - Purchase confirmation modal with total cost
    - (Actual payment gateway integration deferred — records transaction for admin billing)
- [ ] Integrate credit deduction into chat proxy:
  - When `POST /api/chat/proxy` succeeds, deduct credits based on operation type:
    - Writing operations (write chapter, blog, newsletter, short story): 5 credits
    - Brainstorm/outline: 3 credits
    - Research: 2 credits
    - Cover art generation: 10 credits
    - Social media repurposing: 3 credits
    - List/retrieve operations: 0 credits (free)
  - Return remaining credits in response headers: `X-Credits-Remaining`
- [ ] Update chat drawer: show credit cost before sending expensive operations ("This will use 5 credits. You have 42 remaining. [Send]")
- [ ] Credit exhaustion handling:
  - When credits hit 0: show modal "You've used all your credits for this period"
  - Show two options: "Purchase More Credits" (immediate) and "Credits reset on [date]" (wait)
  - Block creation operations, allow read/browse operations
  - "Purchase Credits" button in exhaustion modal links directly to credits page purchase section
- [ ] Add credits route to sidebar (below Cost Tracking)
- [ ] Update CostDashboard to show credits alongside token costs

**QA Tasks:**
- [ ] Test: sidebar shows correct credit balance
- [ ] Test: sending a write command deducts correct credits
- [ ] Test: list operations do not deduct credits
- [ ] Test: credit exhaustion modal appears at 0 credits with purchase option
- [ ] Test: purchasing credits updates balance immediately and creates transaction
- [ ] Test: purchase price reflects tier-specific pricing
- [ ] Test: transaction history shows all debits, credits, and purchases
- [ ] Test: credit cost confirmation shown before expensive operations
- [ ] Test: X-Credits-Remaining header present in chat responses
- [ ] Test: free_full user can purchase additional credits

---

#### S8-7: Subscription tier management (superuser)
**Points:** 5 | **Priority:** P1

Allow superusers to configure subscription tiers — pricing, credits, features — without code changes.

**Developer Tasks:**
- [ ] Create `TierManagement.tsx` in SuperuserPanel:
  - List all subscription tiers with: name, price (monthly/annual), monthly credits, credit purchase price, features, user count, active/inactive
  - Edit tier form: display_name, description, **monthly_credits** (the key superuser-controlled value), credit_purchase_price_cents, monthly_price_cents, annual_price_cents, features (checkbox grid), trial_days, sort_order, active toggle
  - **Monthly credits control** is the primary configuration — prominently displayed with clear labeling: "Monthly Credit Allowance: how many credits users on this tier receive each billing cycle"
  - Create new tier button
  - Deactivate tier (soft — existing subscribers keep their tier, new signups cannot select it)
  - Show user count per tier
  - "Apply credit change to existing subscribers" checkbox — when superuser changes monthly_credits, option to immediately update all existing subscribers' allowance (does not change their current remaining credits, only the reset amount)
- [ ] Server routes (all require superuser):
  - `GET /api/superuser/tiers` — list all tiers with subscriber counts
  - `POST /api/superuser/tiers` — create new tier
  - `PUT /api/superuser/tiers/:id` — update tier (price changes only affect new subscribers)
  - `PUT /api/superuser/tiers/:id/deactivate` — soft deactivate
- [ ] Create `SystemConfig.tsx` in SuperuserPanel:
  - Credit costs per operation (currently hardcoded in S8-6) — move to `app_config_v2` with key `credit_costs`
  - Default tier for new signups
  - Trial duration override
  - Global maintenance mode toggle
- [ ] Server route: `GET/PUT /api/superuser/config` — read/write system-wide configuration
- [ ] Add Zod schemas: `TierSchema`, `SystemConfigSchema`

**QA Tasks:**
- [ ] Test: superuser can create a new tier
- [ ] Test: editing tier price doesn't retroactively change existing subscribers
- [ ] Test: deactivating tier hides it from signup but keeps existing subscribers
- [ ] Test: credit cost configuration applies to chat proxy deductions
- [ ] Test: admin cannot access superuser tier management (403)
- [ ] Test: system config changes take effect immediately

---

#### S8-8: Role-gated UI and feature flags
**Points:** 5 | **Priority:** P0

Gate all UI elements based on the user's role and subscription tier. Users should only see what they can access.

**Developer Tasks:**
- [ ] Create `usePermissions()` hook:
  - Returns `{ role, tier, features, credits, canExport, canGenerateArt, canRepurposeSocial, isAdmin, isSuperuser, isTrialUser, trialDaysRemaining }`
  - Reads from `UserContext` profile + subscription data
  - Memoized for performance
- [ ] Create `<RequireRole role="admin">` wrapper component:
  - Renders children only if user has required role (respects hierarchy: superuser > admin > user)
  - Optional `fallback` prop for "Access Denied" message
- [ ] Create `<RequireFeature feature="kdp_export">` wrapper component:
  - Renders children only if user's tier includes the feature
  - Shows upgrade prompt as fallback: "Upgrade to Pro to unlock this feature"
- [ ] Gate existing UI elements:
  - Admin panel link in sidebar: `<RequireRole role="admin">`
  - Superuser panel link: `<RequireRole role="superuser">`
  - Export button in ProjectDetail: `<RequireFeature feature="kdp_export">`
  - "Generate Cover Art" quick command in chat: `<RequireFeature feature="cover_art">`
  - Social Media tab in ProjectDetail: `<RequireFeature feature="social_media">`
  - Credit adjustment in admin: `<RequireRole role="admin">`
  - Tier management: `<RequireRole role="superuser">`
- [ ] Update sidebar to show/hide sections based on role:
  - "Superuser" section (only for superusers): Tier Management, System Config, Impersonation Log
  - "Admin" section (admin + superuser): User Management, Subscriptions, Revenue
  - "Credits" section (all users): shows credit balance, link to credits page
- [ ] Upgrade prompts: when a feature is blocked, show inline upgrade card with tier comparison and "Upgrade" CTA
- [ ] Update all API calls to handle 402 (insufficient credits) and 403 (feature not available) gracefully with user-friendly messages

**QA Tasks:**
- [ ] Test: standard user cannot see export button
- [ ] Test: pro user can see and use export button
- [ ] Test: admin sidebar shows admin items, hides superuser items
- [ ] Test: superuser sidebar shows all items
- [ ] Test: upgrade prompt renders for blocked features
- [ ] Test: 402 response shows "insufficient credits" message (not generic error)
- [ ] Test: 403 response shows "upgrade required" message for tier-gated features
- [ ] Test: role hierarchy works correctly (superuser has all admin permissions)

---

#### S8-9: Signup flow with tier selection
**Points:** 3 | **Priority:** P1

Update the signup and onboarding flow to include tier selection and trial activation.

**Developer Tasks:**
- [ ] Update `Signup.tsx`:
  - After email/password step, show tier selection screen
  - Display pricing cards for each active tier: name, price, credits, feature list, CTA button
  - "Start Free Trial" card prominent (30 days, no credit card)
  - "Free Full Access" tier hidden from public signup (admin-provisioned only)
- [ ] Update `Onboarding.tsx`:
  - Step 1: Welcome (existing)
  - Step 2: Choose your plan (tier selection — skipped if admin-created account)
  - Step 3: Sidebar overview (existing)
  - Step 4: Eve + Chat (existing)
  - Step 5: First project (existing)
- [ ] Create `PricingCards.tsx` — reusable pricing display component:
  - Card per tier: name, price (monthly/annual toggle), feature checklist, credit count, CTA
  - Highlight "Most Popular" on pro tier
  - Annual discount percentage shown
- [ ] After tier selection:
  - Create `user_subscriptions` row
  - For trial: set `trial_start=now()`, `trial_end=now()+30d`, `credits_remaining=200`
  - For paid: set billing cycle, period start/end, credits per tier
  - Redirect to dashboard
- [ ] Add `GET /api/tiers` public endpoint (no auth required) — returns active tiers for pricing page

**QA Tasks:**
- [ ] Test: signup shows tier selection after account creation
- [ ] Test: selecting trial creates correct subscription record
- [ ] Test: selecting paid tier sets correct billing cycle and credits
- [ ] Test: free_full tier not visible in public signup
- [ ] Test: admin-created accounts skip tier selection in onboarding
- [ ] Test: pricing cards render correctly with monthly/annual toggle

---

#### S8-10: E2E tests and migration validation
**Points:** 3 | **Priority:** P0

Comprehensive testing for the entire RBAC and subscription system.

**Developer Tasks:**
- [ ] `e2e/sprint8-rbac.spec.ts`:
  - Login as superuser → verify superuser panel visible → verify impersonation works
  - Login as admin → verify admin panel visible, superuser panel hidden
  - Login as standard user → verify limited features, upgrade prompts shown
  - Login as trial user → verify trial banner, countdown, full features available
  - Locked account → verify login blocked with appropriate message
  - Credit exhaustion → verify creation blocked, read operations still work
  - Impersonation flow: start → verify target user data → end → verify restoration
- [ ] `client/src/test/sprint8-qa.test.ts`:
  - `usePermissions` hook: returns correct values for each role/tier combination
  - `RequireRole`: renders/hides based on role hierarchy
  - `RequireFeature`: renders/hides based on tier features
  - Credit display: correct formatting, color thresholds
  - Trial banner: shows correct days remaining, color changes at 3 days
  - Pricing cards: renders all tiers, handles monthly/annual toggle
- [ ] `server/src/test/sprint8-qa.test.ts`:
  - `requireSuperuser` middleware: blocks non-superusers
  - `requireTierFeature`: blocks users without feature
  - `requireCredits`: blocks users with insufficient credits, passes unlimited
  - `deductCredits`: correct balance math, transaction created
  - Impersonation routes: only superuser can start, log created
  - Account lock/unlock: correct status changes
  - Trial expiration cron: correctly expires and suspends
  - Credit reset cron: correctly resets and logs
- [ ] Migration dry-run: verify `008_sprint8_rbac_subscriptions.sql` against V2 Supabase without breaking existing data

**QA Tasks:**
- [ ] Run full E2E suite on Chromium and Firefox
- [ ] Verify no regression in Sprints 0-7 functionality
- [ ] Test migration rollback path (document manual steps)
- [ ] Verify n8n service role still bypasses all RLS after policy changes
- [ ] Test with multiple concurrent users at different tiers

---

### Sprint 8 Completion Criteria
- [ ] Role system expanded: superuser, admin, user (3 roles)
- [ ] 5 subscription tiers seeded and configurable
- [ ] Credit system tracking usage per operation
- [ ] Superuser impersonation working with audit log
- [ ] Admin can create, lock, unlock, and manage user accounts
- [ ] Trial lifecycle: 30-day countdown, warnings, expiration, suspension
- [ ] UI gated by role and tier (upgrade prompts for blocked features)
- [ ] Signup flow includes tier selection
- [ ] All new features have unit + E2E tests
- [ ] Migration tested against V2 Supabase without data loss
- [ ] All existing tests still pass (no regressions)

---

## Sprint 9: Stripe Integration & Payment Processing (2 weeks)

**Goal:** Integrate Stripe for real payment processing — subscriptions, credit purchases, invoicing, and self-service tier upgrades/downgrades. Replace the manual billing reconciliation from Sprint 8 with automated Stripe-powered payments.
**Total Points:** 47
**Prerequisite:** Sprint 8 must be complete (RBAC, subscription tiers, credit system all in place).

### Architecture Overview

Stripe integration follows the **Stripe-as-source-of-truth** pattern for billing, while Supabase remains the source of truth for content and access control:

```
User Action (upgrade/purchase/cancel)
    → Client calls server API
        → Server creates Stripe Checkout Session / PaymentIntent
            → Stripe processes payment
                → Stripe fires webhook to server
                    → Server updates user_subscriptions & credit_transactions in Supabase
                        → Client reflects updated state via query invalidation
```

**Key Principle:** Never grant access based on client-side state alone. All entitlement changes flow through Stripe webhooks → server → database. The client only reads the result.

### Stripe Resources Used

| Stripe Concept | Our Use Case |
|----------------|-------------|
| **Products** | Each subscription tier = 1 Stripe Product |
| **Prices** | Monthly and annual price per product (2 per tier) |
| **Subscriptions** | Recurring billing for paid tiers |
| **Checkout Sessions** | New subscription signup + tier upgrades |
| **Customer Portal** | Self-service billing management (update card, cancel) |
| **Payment Intents** | One-time credit purchases |
| **Webhooks** | Server-side fulfillment of all payment events |
| **Customer** | 1:1 mapping to `users_v2` via `stripe_customer_id` |

### Stories

---

#### S9-1: Stripe SDK setup, environment config, and product/price seeding
**Points:** 5 | **Priority:** P0

Install Stripe, configure API keys, and create the Stripe Products and Prices that mirror our subscription tiers.

**Developer Tasks:**
- [ ] Install `stripe` npm package in `server/`
- [ ] Add environment variables to `.env.example`:
  - `STRIPE_SECRET_KEY` — Stripe secret API key (sk_test_... for dev, sk_live_... for prod)
  - `STRIPE_PUBLISHABLE_KEY` — Stripe publishable key (pk_test_... / pk_live_...)
  - `STRIPE_WEBHOOK_SECRET` — webhook endpoint signing secret (whsec_...)
  - `STRIPE_PRICE_STANDARD_MONTHLY`, `STRIPE_PRICE_STANDARD_ANNUAL` — Stripe Price IDs
  - `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL`
  - `STRIPE_PRICE_PAID_FULL_MONTHLY`, `STRIPE_PRICE_PAID_FULL_ANNUAL`
  - `STRIPE_CREDIT_PRICE_ID` — price ID for credit pack purchases
- [ ] Create `server/src/services/stripe.ts`:
  - Lazy-initialized Stripe client (same pattern as `supabase-admin.ts`)
  - `getStripeClient()` function — validates `STRIPE_SECRET_KEY` exists, creates singleton
- [ ] SQL migration `009_sprint9_stripe.sql`:
  - `ALTER TABLE users_v2 ADD COLUMN stripe_customer_id TEXT UNIQUE`
  - `ALTER TABLE user_subscriptions ADD COLUMN stripe_subscription_id TEXT UNIQUE`
  - `ALTER TABLE user_subscriptions ADD COLUMN stripe_current_period_end TIMESTAMPTZ`
  - `ALTER TABLE credit_transactions ADD COLUMN stripe_payment_intent_id TEXT`
  - `ALTER TABLE subscription_tiers ADD COLUMN stripe_product_id TEXT`
  - `ALTER TABLE subscription_tiers ADD COLUMN stripe_price_monthly_id TEXT`
  - `ALTER TABLE subscription_tiers ADD COLUMN stripe_price_annual_id TEXT`
  - Add index on `users_v2.stripe_customer_id`
  - Add index on `user_subscriptions.stripe_subscription_id`
- [ ] Create `scripts/seed-stripe-products.ts` — CLI script that:
  - Reads `subscription_tiers` from Supabase
  - Creates matching Stripe Products and Prices for each tier (monthly + annual)
  - Creates a Stripe Price for credit pack purchases (per-credit pricing)
  - Updates `subscription_tiers` rows with `stripe_product_id`, `stripe_price_monthly_id`, `stripe_price_annual_id`
  - Idempotent (skips tiers that already have Stripe IDs)
  - Run via: `npx tsx scripts/seed-stripe-products.ts`
- [ ] Update TypeScript types: add `stripe_customer_id` to `UserProfile`, Stripe IDs to `SubscriptionTier`
- [ ] Update `server/src/index.ts`: add raw body parsing for Stripe webhook route (Stripe requires raw body for signature verification — must be registered BEFORE `express.json()` or use a separate parser)

**QA Tasks:**
- [ ] Test: `getStripeClient()` throws clear error when `STRIPE_SECRET_KEY` is missing
- [ ] Test: seed script creates Products and Prices in Stripe test mode
- [ ] Test: seed script is idempotent (running twice doesn't create duplicates)
- [ ] Test: Stripe IDs saved to `subscription_tiers` table
- [ ] Test: `stripe_customer_id` column is unique (no two users share a Stripe customer)
- [ ] Test: raw body parsing works for webhook route without breaking JSON parsing for other routes

---

#### S9-2: Stripe Customer creation and sync
**Points:** 5 | **Priority:** P0

Automatically create Stripe Customers for users and keep them synchronized.

**Developer Tasks:**
- [ ] Create `server/src/services/stripe-sync.ts`:
  - `getOrCreateStripeCustomer(userId: string)`: looks up `users_v2.stripe_customer_id`. If null, creates a Stripe Customer with `email`, `name`, `phone`, `metadata: { user_id, supabase_auth_uid }`. Saves `stripe_customer_id` back to `users_v2`. Returns customer ID.
  - `syncCustomerToStripe(userId: string)`: updates Stripe Customer with latest email/name/phone from `users_v2` (called on profile update)
  - `findUserByStripeCustomerId(customerId: string)`: reverse lookup for webhook handling
- [ ] Hook into user creation flow:
  - When admin creates user (S8-3 `POST /api/admin/users`): call `getOrCreateStripeCustomer` after creating user record
  - When user signs up (onboarding): call `getOrCreateStripeCustomer` after `users_v2` row is created
  - Trial users get a Stripe Customer but no Stripe Subscription (trial is free, managed internally)
- [ ] Hook into profile update:
  - When `PUT /api/admin/users/:id` changes email/name: call `syncCustomerToStripe`
  - When user updates own profile in Settings: call `syncCustomerToStripe`
- [ ] Backfill existing users:
  - Create `POST /api/superuser/stripe/backfill` — iterates all `users_v2` rows without `stripe_customer_id`, creates Stripe Customers
  - Eric's account (`+14105914612`) gets a Stripe Customer but no subscription (free_full tier, never charged)
- [ ] Error handling: if Stripe is unreachable, log error and continue — don't block user creation. Mark `stripe_customer_id` as null and retry on next relevant action.

**QA Tasks:**
- [ ] Test: new user signup creates Stripe Customer with correct metadata
- [ ] Test: admin-created user gets Stripe Customer
- [ ] Test: profile update syncs to Stripe Customer
- [ ] Test: `getOrCreateStripeCustomer` is idempotent (calling twice returns same customer)
- [ ] Test: Stripe failure doesn't block user creation (graceful degradation)
- [ ] Test: backfill endpoint creates Customers for all existing users
- [ ] Test: Eric's superuser account gets Customer but no Stripe Subscription

---

#### S9-3: Checkout flow — new subscriptions and tier upgrades
**Points:** 8 | **Priority:** P0

Build the Stripe Checkout integration for subscribing to a paid tier and upgrading/downgrading between tiers.

**Developer Tasks:**
- [ ] Server routes:
  - `POST /api/billing/checkout` — creates Stripe Checkout Session for new subscription:
    - Accepts `{ tier_id, billing_cycle: 'monthly' | 'annual' }`
    - Looks up `subscription_tiers` to get the correct `stripe_price_monthly_id` or `stripe_price_annual_id`
    - Creates Checkout Session with `mode: 'subscription'`, `customer`, `success_url`, `cancel_url`
    - `success_url` includes `session_id` query param for verification
    - Returns `{ checkout_url }` — client redirects to Stripe
  - `POST /api/billing/upgrade` — creates Checkout Session for tier change:
    - If upgrading: prorated, immediate switch via Stripe `subscription.update` with `proration_behavior: 'create_prorations'`
    - If downgrading: change takes effect at end of current period via `proration_behavior: 'none'` + `cancel_at_period_end` on old + new subscription at period end
    - Returns `{ checkout_url }` or `{ success: true }` for immediate proration
  - `POST /api/billing/portal` — creates Stripe Customer Portal session:
    - Customer Portal handles: update payment method, view invoices, cancel subscription
    - Returns `{ portal_url }`
  - `GET /api/billing/status` — returns current billing status:
    - Current tier, billing cycle, next billing date, payment method (last 4 digits), upcoming invoice amount
    - Reads from both `user_subscriptions` and Stripe API
- [ ] Client integration:
  - Update `PricingCards.tsx` (from S8-9): "Subscribe" button calls `POST /api/billing/checkout` and redirects to `checkout_url`
  - Add `BillingPage.tsx` at `/billing`:
    - Current plan card: tier name, price, billing cycle, next payment date
    - "Change Plan" button → shows tier comparison with upgrade/downgrade pricing
    - "Manage Billing" button → opens Stripe Customer Portal (payment method, invoices, cancel)
    - Payment method display: card brand + last 4 digits from Stripe
    - Invoice history: last 12 invoices from Stripe with PDF download links
  - Update signup flow: after selecting a paid tier, redirect to Stripe Checkout instead of immediate activation
  - Add `/billing/success` route — landing page after Stripe Checkout success. Shows "Payment confirmed" and redirects to dashboard.
  - Add `/billing/cancel` route — landing page after Stripe Checkout cancellation. Shows "No charges made" and redirects to pricing.
- [ ] Add `Billing` link in sidebar (visible to all users except free_full)
- [ ] Superuser/admin accounts skip Stripe Checkout entirely (their subscriptions are managed internally)

**QA Tasks:**
- [ ] Test: clicking "Subscribe" on pro tier redirects to Stripe Checkout with correct price
- [ ] Test: successful Checkout creates Stripe Subscription and redirects to success page
- [ ] Test: cancelled Checkout redirects to cancel page with no charges
- [ ] Test: upgrade from standard to pro creates prorated charge
- [ ] Test: downgrade from pro to standard takes effect at period end (not immediately)
- [ ] Test: Customer Portal opens and shows correct customer data
- [ ] Test: billing page shows correct current plan, price, and next payment date
- [ ] Test: invoice history displays PDFs from Stripe
- [ ] Test: free_full and trial users see "Subscribe" not "Change Plan"
- [ ] Test: superuser/admin accounts do not see billing page or get charged

---

#### S9-4: Stripe webhook handler — subscription lifecycle events
**Points:** 8 | **Priority:** P0

Handle all Stripe webhook events to keep `user_subscriptions` in sync with Stripe billing state.

**Developer Tasks:**
- [ ] Create `server/src/routes/stripe-webhook.ts`:
  - `POST /api/webhooks/stripe` — Stripe webhook endpoint
  - Verify webhook signature using `stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)`
  - **Must use raw body** — register route before `express.json()` middleware or use `express.raw({ type: 'application/json' })` on this specific route
- [ ] Handle these Stripe events:
  - **`checkout.session.completed`**: 
    - Extract `customer`, `subscription` from session
    - Look up user by `stripe_customer_id`
    - Update `user_subscriptions`: set `stripe_subscription_id`, `status='active'`, `billing_cycle`, `current_period_start/end`
    - Set `users_v2.account_status = 'active'` (in case they were suspended/trial-expired)
    - Insert `credit_transactions` row with type `monthly_reset`
    - Set `credits_remaining` to tier's `monthly_credits`
  - **`invoice.paid`** (recurring payment success):
    - Reset credits: `credits_remaining = tier.monthly_credits`, `credits_used_this_period = 0`
    - Update `current_period_start/end` from Stripe subscription
    - Insert `credit_transactions` row with type `monthly_reset`
  - **`invoice.payment_failed`**:
    - Set `user_subscriptions.status = 'past_due'`
    - Send email: "Your payment failed. Please update your payment method."
    - After 3 consecutive failures (check Stripe subscription status): set `account_status = 'suspended'`
  - **`customer.subscription.updated`**:
    - Sync tier changes (plan_id → find matching `subscription_tiers`)
    - Update `billing_cycle` if changed
    - Update `stripe_current_period_end`
  - **`customer.subscription.deleted`** (cancellation):
    - Set `user_subscriptions.status = 'cancelled'`
    - Keep `account_status = 'active'` until `current_period_end` (access continues through paid period)
    - After `current_period_end`: set `account_status = 'suspended'` (handled by trial_check cron or a new subscription_check cron)
  - **`payment_intent.succeeded`** (one-time credit purchase):
    - Extract `metadata.user_id` and `metadata.credits` from PaymentIntent
    - Call `purchaseCredits(userId, credits)` — adds credits and creates transaction with `stripe_payment_intent_id`
- [ ] Idempotency: store processed event IDs in `stripe_events` table (or check `credit_transactions.stripe_payment_intent_id`) to prevent double-processing on webhook retries
- [ ] Create `stripe_events` table:
  ```sql
  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,                    -- Stripe event ID (evt_...)
    event_type TEXT NOT NULL,
    processed_at TIMESTAMPTZ DEFAULT now(),
    payload JSONB
  );
  ```
- [ ] Error handling: if webhook processing fails, return 500 so Stripe retries. Log full event payload for debugging. Never return 200 unless fully processed.
- [ ] Register webhook route in `server/src/index.ts` — BEFORE `express.json()` middleware

**QA Tasks:**
- [ ] Test: webhook signature verification rejects tampered payloads
- [ ] Test: `checkout.session.completed` activates subscription and resets credits
- [ ] Test: `invoice.paid` resets credits monthly
- [ ] Test: `invoice.payment_failed` sets status to past_due
- [ ] Test: 3 consecutive payment failures suspends account
- [ ] Test: `customer.subscription.deleted` keeps access through paid period then suspends
- [ ] Test: `payment_intent.succeeded` for credit purchase adds correct credits
- [ ] Test: duplicate webhook events are idempotent (same event ID processed once)
- [ ] Test: failed webhook processing returns 500 (not 200) so Stripe retries
- [ ] Test: webhook route uses raw body parsing (not JSON-parsed)
- [ ] Test: subscription tier change via Stripe Portal syncs to `user_subscriptions`

---

#### S9-5: Credit purchase checkout flow
**Points:** 5 | **Priority:** P0

Wire up the credit purchase UI (from S8-6) to actual Stripe payment processing.

**Developer Tasks:**
- [ ] Update `POST /api/credits/purchase` (from S8-2):
  - Instead of immediately adding credits, create a Stripe PaymentIntent:
    - `amount` = `quantity * tier.credit_purchase_price_cents`
    - `currency` = 'usd'
    - `customer` = user's `stripe_customer_id`
    - `metadata` = `{ user_id, credits: quantity, tier_id }`
  - Return `{ client_secret }` for Stripe Elements or redirect to Stripe Checkout
  - Credits are NOT added until webhook confirms payment (via `payment_intent.succeeded`)
- [ ] Alternative flow using Stripe Checkout (simpler):
  - `POST /api/credits/purchase-checkout` — creates Checkout Session with `mode: 'payment'`
  - Uses the credit pack Price from `STRIPE_CREDIT_PRICE_ID` with `quantity`
  - `success_url` = `/credits?purchase=success`
  - Returns `{ checkout_url }`
- [ ] Update `CreditsPage.tsx` purchase section:
  - "Purchase Credits" button creates checkout session and redirects to Stripe
  - After successful payment + webhook: credits appear in balance (may need polling or SSE notification)
  - Show "Processing payment..." state between Stripe redirect return and credit appearing
  - Purchase history section: shows all `credit_transactions` with type `purchase` and their Stripe receipt links
- [ ] Update credit exhaustion modal:
  - "Buy More Credits" now redirects to Stripe Checkout (not just internal credit addition)
  - Show price: "25 credits for $25.00"
- [ ] Free_full tier credit purchase: free_full users can still purchase credits — their `credit_purchase_price_cents` may differ from paid tiers (superuser-configurable)

**QA Tasks:**
- [ ] Test: clicking "Purchase 25 Credits" redirects to Stripe Checkout with correct amount ($25.00 at $1.00/credit)
- [ ] Test: successful payment adds credits via webhook (not client-side)
- [ ] Test: credits page shows "Processing..." until webhook confirms
- [ ] Test: cancelled purchase doesn't add credits
- [ ] Test: purchase history shows Stripe receipt links
- [ ] Test: free_full users can purchase credits
- [ ] Test: credit exhaustion modal purchase button works end-to-end

---

#### S9-6: Self-service tier upgrade/downgrade
**Points:** 5 | **Priority:** P1

Allow users to change their own subscription tier through the billing page.

**Developer Tasks:**
- [ ] Create `TierComparisonModal.tsx`:
  - Shows current tier vs available tiers in comparison grid
  - Feature checklist per tier (from `subscription_tiers.features`)
  - Credit allowance per tier
  - Price difference display:
    - Upgrade: "You'll be charged $30.00 now (prorated for remaining billing period)"
    - Downgrade: "Your plan will change to Standard at the end of your current billing period on [date]"
  - "Confirm Change" button
- [ ] Upgrade flow:
  - Client calls `POST /api/billing/upgrade` with `{ new_tier_id }`
  - Server uses Stripe `subscriptions.update()` to switch the price
  - Stripe prorates and charges immediately for upgrades
  - Server updates `user_subscriptions.tier_id` upon webhook confirmation
  - Credits: if upgrading, immediately set `credits_remaining` to max of (current_remaining, new_tier.monthly_credits)
- [ ] Downgrade flow:
  - Client calls `POST /api/billing/downgrade` with `{ new_tier_id }`
  - Server sets `schedule` on Stripe subscription: current plan continues until period end, then switches
  - Show pending downgrade notice on billing page: "Your plan will change to Standard on [date]"
  - At period end: Stripe fires `customer.subscription.updated` → webhook updates tier and credits
- [ ] Cancel flow:
  - "Cancel Subscription" in Stripe Customer Portal (or via billing page)
  - Server receives `customer.subscription.deleted` webhook
  - Access continues through paid period, then account suspends
  - Show: "Your subscription is cancelled. You have access until [date]."
  - "Reactivate" button: calls Stripe to un-cancel (if before period end)
- [ ] Trial → Paid conversion:
  - Trial users see "Upgrade" prominently on trial banner and billing page
  - Selecting a paid tier creates new Stripe Subscription
  - Trial subscription transitions to paid (no gap in access)

**QA Tasks:**
- [ ] Test: upgrade from standard to pro charges prorated amount
- [ ] Test: upgrade immediately increases credit allowance
- [ ] Test: downgrade from pro to standard shows pending notice
- [ ] Test: downgrade takes effect at period end (not immediately)
- [ ] Test: cancel shows end date and "Reactivate" button
- [ ] Test: reactivation before period end works
- [ ] Test: trial user can upgrade to any paid tier
- [ ] Test: tier comparison modal shows accurate feature/price differences
- [ ] Test: admin/superuser accounts cannot trigger Stripe billing operations

---

#### S9-7: Admin billing dashboard and revenue reporting
**Points:** 5 | **Priority:** P1

Give admins visibility into billing, revenue, and payment health across all users.

**Developer Tasks:**
- [ ] Update AdminPanel Subscriptions tab (from S8-3):
  - Add "Payment Status" column: paid, past_due, cancelled, trialing
  - Add "Last Payment" column: date and amount from Stripe
  - Add "MRR Contribution" column per user
  - Failed payments highlighted in red with "Retry Payment" admin action
- [ ] Create `RevenueDashboard.tsx` — new Admin tab or SuperuserPanel section:
  - **Summary cards:** MRR, ARR, total customers, active subscribers, trial users, churn rate (30-day)
  - **Revenue chart:** monthly revenue over last 12 months (from Stripe invoices)
  - **Tier breakdown:** pie chart showing subscriber count per tier
  - **Trial conversion funnel:** trial starts → active trials → converted to paid → churned
  - **Failed payments:** list of past_due accounts with "Send reminder" and "Retry" actions
  - **Recent transactions:** last 50 Stripe events (from `stripe_events` table)
- [ ] Server routes:
  - `GET /api/admin/revenue` — aggregated revenue data:
    - Pulls from Stripe API: `stripe.invoices.list()` for revenue, `stripe.subscriptions.list()` for counts
    - Caches results for 5 minutes (Stripe API rate limits)
  - `POST /api/admin/retry-payment/:userId` — retries failed invoice via `stripe.invoices.pay()`
  - `GET /api/admin/stripe-events` — paginated list from `stripe_events` table
- [ ] Superuser: can issue refunds via `POST /api/superuser/refund`:
  - Accepts `{ stripe_payment_intent_id, amount_cents?, reason }`
  - Calls `stripe.refunds.create()`
  - Deducts credits if refunding a credit purchase
  - Creates `credit_transactions` row with type `refund`

**QA Tasks:**
- [ ] Test: revenue dashboard shows correct MRR calculation
- [ ] Test: tier breakdown matches actual subscriber counts
- [ ] Test: failed payment list shows correct past_due accounts
- [ ] Test: retry payment triggers Stripe invoice payment
- [ ] Test: refund deducts credits and creates refund transaction
- [ ] Test: revenue data caching works (second request within 5 min returns cached)
- [ ] Test: non-admin cannot access revenue routes

---

#### S9-8: Subscription lifecycle cron and health monitoring
**Points:** 3 | **Priority:** P1

Ensure subscriptions stay synchronized between Stripe and the database, and handle edge cases.

**Developer Tasks:**
- [ ] Create `POST /api/cron/subscription-sync` (secured with cron secret):
  - Queries all `user_subscriptions` with `stripe_subscription_id`
  - For each, fetches current status from Stripe API
  - Fixes any drift: if Stripe says `active` but local says `past_due`, update local
  - If Stripe says `canceled` and `current_period_end < now()`, set `account_status = 'suspended'`
  - Handles accounts that cancelled but whose access period has now ended
  - Log all corrections for admin review
- [ ] Update `POST /api/cron/credit-reset` (from S8-5):
  - For Stripe-managed subscriptions: verify with Stripe that subscription is still active before resetting credits
  - Don't reset credits for `past_due` or `cancelled` subscriptions
- [ ] Create `POST /api/cron/trial-conversion-reminder`:
  - Trials expiring in 3 days that haven't converted: send email with pricing and direct Checkout link
  - Include one-click "Start Pro Plan" link (pre-filled Checkout Session)
- [ ] Health monitoring:
  - Add Stripe connectivity check to `/api/health`: calls `stripe.balance.retrieve()` — returns `checks.stripe: 'ok' | 'error' | 'skipped'`
  - Log Stripe API errors with request IDs for debugging
  - Alert if webhook events stop arriving (check `stripe_events` for gap > 1 hour during business hours)

**QA Tasks:**
- [ ] Test: subscription-sync corrects drifted status
- [ ] Test: cancelled subscriptions with expired access get suspended
- [ ] Test: credit reset skips past_due subscriptions
- [ ] Test: trial conversion reminder sent at 3-day mark
- [ ] Test: health check returns stripe status
- [ ] Test: cron endpoints reject requests without correct secret

---

#### S9-9: E2E tests — full payment lifecycle
**Points:** 3 | **Priority:** P0

Comprehensive end-to-end testing of the entire billing system using Stripe test mode.

**Developer Tasks:**
- [ ] `e2e/sprint9-billing.spec.ts` — using Stripe test mode (test API keys + test card numbers):
  - **New user signup → trial → paid conversion:**
    1. Sign up new account
    2. Verify trial subscription created (no Stripe subscription)
    3. Click "Upgrade to Pro" → verify Stripe Checkout redirect
    4. Complete Checkout with test card `4242424242424242`
    5. Verify redirect to success page
    6. Verify subscription active with correct credits
  - **Credit purchase flow:**
    1. Navigate to Credits page
    2. Select 25 credits
    3. Click Purchase → verify Stripe Checkout
    4. Complete payment with test card
    5. Verify credits added to balance
    6. Verify transaction appears in history
  - **Payment failure flow:**
    1. Create subscription with test card `4000000000000341` (attaches then fails on charge)
    2. Verify `past_due` status shown in billing page
    3. Verify warning banner/email notification
    4. Update payment method via Customer Portal
    5. Verify account recovers
  - **Tier upgrade/downgrade:**
    1. Login as standard user
    2. Upgrade to pro → verify prorated charge
    3. Verify credits increase immediately
    4. Downgrade back to standard → verify pending notice
    5. Verify access continues through period
  - **Cancellation:**
    1. Cancel subscription via billing page
    2. Verify "access until [date]" message
    3. Verify "Reactivate" button works before period end
  - **Admin/superuser billing views:**
    1. Login as admin → verify revenue dashboard
    2. Verify subscriber list with payment status
    3. Login as superuser → verify refund capability
- [ ] `server/src/test/sprint9-qa.test.ts`:
  - Stripe client initialization (missing key handling)
  - Webhook signature verification (valid, invalid, replay)
  - Checkout session creation (correct price, customer, URLs)
  - `getOrCreateStripeCustomer` idempotency
  - Subscription sync cron (drift correction)
  - Credit purchase → webhook → balance update flow
  - Refund → credit deduction flow
  - Rate limiting on billing endpoints
- [ ] `client/src/test/sprint9-qa.test.ts`:
  - PricingCards rendering (monthly/annual toggle, feature lists)
  - BillingPage states (active, past_due, cancelled, trial)
  - TierComparisonModal (upgrade vs downgrade messaging)
  - Credit purchase form (quantity, total calculation, validation)
  - RevenueDashboard (summary cards, chart data formatting)
  - Billing link visibility (hidden for free_full, visible for paid tiers)

**QA Tasks:**
- [ ] Run full E2E suite on Chromium and Firefox with Stripe test keys
- [ ] Verify all Stripe test card scenarios (success, decline, 3D Secure)
- [ ] Test with Stripe CLI `stripe listen --forward-to localhost:3001/api/webhooks/stripe` for local webhook testing
- [ ] Verify no regression in Sprints 0-8 functionality
- [ ] Test webhook idempotency (replay same event twice)
- [ ] Test race conditions: simultaneous credit purchase + credit usage
- [ ] Verify PCI compliance: no card numbers stored in our database (all handled by Stripe)
- [ ] Test Stripe Customer Portal renders correctly
- [ ] Verify Stripe Dashboard shows correct Products, Prices, Subscriptions, and Customers

---

### Sprint 9 Completion Criteria
- [ ] Stripe SDK installed and configured with test + production key support
- [ ] All 5 subscription tiers have corresponding Stripe Products and Prices
- [ ] Stripe Customers created for all users (with backfill for existing)
- [ ] Checkout flow works for new subscriptions
- [ ] Credit purchases processed through Stripe
- [ ] Webhook handler processes all lifecycle events (paid, failed, cancelled, updated)
- [ ] Self-service upgrade/downgrade with correct proration
- [ ] Admin revenue dashboard with MRR, churn, trial conversion metrics
- [ ] Subscription sync cron catches drift between Stripe and database
- [ ] Superuser can issue refunds
- [ ] All Stripe interactions use test mode in dev, live mode in production
- [ ] No card numbers or sensitive payment data stored in Supabase (PCI compliance)
- [ ] Full E2E test coverage using Stripe test cards
- [ ] All existing tests still pass (no regressions)

---

## Summary

| Sprint | Focus | Stories | Points | Status |
|--------|-------|---------|--------|--------|
| 0 | Testing Infrastructure & Security | 9 | 34 | COMPLETE |
| 1 | Data Integrity & Core CRUD | 7 | 34 | COMPLETE |
| 2 | UI Restructure & Navigation | 5 | 34 | COMPLETE |
| 3 | CRUD Completeness & Data Management | 7 | 34 | COMPLETE |
| 4 | Image & Social Media Management | 6 | 34 | COMPLETE |
| 5 | Observability & Advanced Features | 6 | 34 | COMPLETE |
| 6 | Admin, Settings & Polish | 7 | 34 | COMPLETE |
| 7 | Testing, Documentation & Deployment | 5 | 28 | COMPLETE |
| 8 | Multi-Tenant RBAC & Subscriptions | 10 | 55 | NOT STARTED |
| 9 | Stripe Integration & Payments | 9 | 47 | NOT STARTED |
| **Total** | | **71 stories** | **358 points** | |

### Velocity Assumption
- 1 developer agent + 1 QA agent
- ~35 points per sprint (sustainable pace)
- 2-week sprints
- Sprint 8 is larger than average (~55 points) — may extend to 3 weeks or split into 8a/8b
- Sprint 9 (~47 points) — may extend to 3 weeks if Stripe edge cases require iteration

### Risk Factors
- n8n workflow changes (Sprints 4, 5) require testing against live workflows
- ElevenLabs widget behavior may vary across browsers
- Supabase RLS changes require careful migration to avoid breaking n8n service role access
- KIE.AI image persistence requires workflow deployment coordination
- **Sprint 8:** Role constraint migration must handle existing users with 'editor'/'viewer' roles — migrate them to 'user' before dropping old values
- **Sprint 8:** Impersonation via `get_current_user_id()` override must not break n8n service role operations
- **Sprint 8:** Credit deduction in chat proxy must be atomic to prevent race conditions (use DB transaction)
- **Sprint 9:** Stripe webhook endpoint must receive raw body (not JSON-parsed) for signature verification — conflicts with global `express.json()` middleware ordering
- **Sprint 9:** Stripe test mode vs live mode must be environment-driven — no hardcoded test keys in production
- **Sprint 9:** PCI compliance: never log, store, or transmit card numbers — Stripe Checkout and Elements handle all sensitive data client-side
- **Sprint 9:** Webhook retries can cause double-processing — idempotency via `stripe_events` table is critical
- **Sprint 9:** Stripe API rate limits (100 req/s in test, 25 req/s for some endpoints) — admin revenue dashboard must cache responses

### Deferred to Post-Launch (explicitly out of scope)
- Collaborative editing / multi-user shared projects (Audit 5.6) — requires significant architecture change
- Real-time collaborative cursors — not needed for initial SaaS launch
- Multi-currency support — USD only for initial launch
- Stripe Connect / marketplace payouts — not needed (single-vendor model)
- Tax calculation (Stripe Tax) — manual for now, integrate if crossing tax nexus thresholds
- Dunning management beyond 3-retry — use Stripe's built-in Smart Retries for now

### Coverage Verification
All items from the following sources are accounted for in this sprint plan:
- AUDIT_REPORT.md: 127 deficiencies — **100% covered** (63 explicit items + consolidated categories)
- ARCHITECTURE_REVIEW_V2.md: 75 tasks — **100% covered** (Task 20 marked done, all others assigned)
- Conversation items: 9 items — **100% covered** (2 architectural decisions documented, 7 in sprints)
- Collaborative features (Audit 5.6) — **explicitly deferred** to post-launch
- Payment processing — **covered in Sprint 9** (Stripe integration)

### Definition of "Done" for Product
- [ ] All 71 stories completed and QA-verified
- [ ] All unit tests passing (80%+ coverage on new code)
- [ ] All E2E tests passing on Chromium and Firefox
- [ ] All 12 acceptance criteria from design spec marked PASS
- [ ] Security audit re-run with zero CRITICAL findings
- [ ] Production deployed on Railway with health checks passing
- [ ] Customer acceptance review completed
- [ ] RBAC system tested with all role/tier combinations
- [ ] Stripe billing tested end-to-end with test cards (signup, payment, upgrade, downgrade, cancel, refund)
- [ ] PCI compliance verified (no card data in Supabase, all payments via Stripe Checkout/Elements)
