# The Writers Workbench — Independent Architecture Audit Report

**Date:** 2026-04-11
**Auditor Role:** Independent reviewer representing the customer
**Scope:** Full application review — UI, server, database, security, data integrity, UX

---

## Executive Summary

The Writers Workbench is a React + Node.js SaaS application built on Supabase. The architecture is sound and the tech stack is modern, but the application has **significant gaps** that would prevent customer acceptance. The system is optimized for **reading data** but lacks critical **write, edit, and delete** operations. Security middleware is absent on the server. Several UI pages are non-functional or incomplete. Version history is created but never displayed. The Eve voice integration does not work.

**Total deficiencies found: 127**

| Category | Count | Severity |
|----------|-------|----------|
| Critical Security | 7 | CRITICAL |
| Missing CRUD Operations | 18 | HIGH |
| Data Integrity Risks | 9 | HIGH |
| UI/UX Deficiencies | 31 | MEDIUM-HIGH |
| Missing Features | 22 | MEDIUM |
| Code Quality Issues | 16 | MEDIUM |
| Production Readiness | 14 | MEDIUM |
| Type/Schema Mismatches | 6 | LOW-MEDIUM |
| Performance Issues | 4 | LOW |

---

## 1. CRITICAL SECURITY DEFICIENCIES

### 1.1 No Authentication Middleware on Server Endpoints [CRITICAL]
**Location:** server/src/routes/export.ts, chat.ts, admin.ts
**Finding:** Zero JWT validation on any server endpoint. The export endpoint accepts `user_id` directly from the request body (`req.body.user_id`) without verifying the caller's identity. Any client can specify any `user_id` to export another user's book.

**Proof:**
```typescript
// export.ts line 29 — user_id trusted from client input
const { project_id, page_size = '6x9', user_id } = req.body;
```

The server uses the Supabase **service role key** (which bypasses RLS) to query the database. This means RLS cannot protect against this — the `.eq('user_id', user_id)` filter is the ONLY authorization check, and it uses an untrusted client-supplied value.

### 1.2 Admin Role Escalation Vulnerability [CRITICAL]
**Location:** supabase_auth_migration.sql, UserContext.tsx
**Finding:** Admin role is stored in `users_v2.preferences` JSONB field (`{"role": "admin"}`). The RLS policy allows users to UPDATE their own profile row. A user can set their own `preferences` to `{"role": "admin"}` and gain admin access.

The `is_admin()` SQL function reads from `preferences->>'role'`, and the UPDATE policy allows `supabase_auth_uid = auth.uid()` with no column restriction.

### 1.3 CORS Wide Open [HIGH]
**Location:** server/src/index.ts, line 19
**Finding:** `app.use(cors())` accepts requests from ANY origin. No origin whitelist, no credential restrictions.

### 1.4 Chat Proxy Accepts Unauthenticated Requests [HIGH]
**Location:** server/src/routes/chat.ts
**Finding:** The `/api/chat/proxy` endpoint forwards any request body to the n8n webhook without authentication. Can be used to DoS the n8n instance or abuse AI agent resources.

### 1.5 No Input Validation on Any Endpoint [HIGH]
**Finding:** No validation library (zod, joi, express-validator) is used. No schema validation on request bodies. No format checking on project_id (UUID), page_size, or user_id (E.164).

### 1.6 No Security Headers [HIGH]
**Finding:** No `helmet` middleware. Missing: X-Content-Type-Options, X-Frame-Options, Content-Security-Policy, Strict-Transport-Security.

### 1.7 API Keys Exposed in Client Bundle [MEDIUM]
**Finding:** N8N webhook URL and ElevenLabs Agent ID are VITE_ environment variables baked into the client JavaScript bundle. Anyone can view source and call these endpoints directly.

---

## 2. MISSING CRUD OPERATIONS

The application can display data but cannot manage it. Out of 12 database tables, only **1 table (genre_config_v2) has full CRUD**. The rest are read-only or partially implemented.

### CRUD Completeness Matrix

| Table | Create | Read | Update | Delete | Version History |
|-------|--------|------|--------|--------|-----------------|
| users_v2 | Admin only | Yes | Partial (name/email) | **NO** | None |
| writing_projects_v2 | **NO** (external only) | Yes | **NO** | **NO** | Table exists, never populated |
| published_content_v2 | **NO** (external only) | Yes | Yes (text+status) | **NO** | Created but **never displayed** |
| content_versions_v2 | Auto on save | **NO UI** | N/A | **NO** | N/A |
| outline_versions_v2 | **Never written** | **NO UI** | N/A | **NO** | Dead table |
| story_bible_v2 | **NO** (external only) | Yes | **NO** | **NO** | None |
| genre_config_v2 | Yes | Yes | Yes | Yes | None |
| story_arcs_v2 | **NO** | Yes | **NO** | **NO** | None |
| research_reports_v2 | **NO** (external only) | List only | **NO** | **NO** | None |
| app_config_v2 | Upsert | Yes | Upsert | **NO** | None |
| content_usage_v2 | External | **NO UI** | N/A | **NO** | N/A |
| content_index | External | **NO UI** | N/A | **NO** | N/A |

### Specific Missing Operations:

1. **Cannot delete a project** — No delete button anywhere. User is stuck with unwanted projects forever.
2. **Cannot delete content** (chapters, stories, blog posts, newsletters) — No delete operation. Published mistakes cannot be removed.
3. **Cannot edit a project** — Title, genre, status, chapter count are read-only in the UI. No edit form exists.
4. **Cannot edit or delete story bible entries** — Display-only. Users cannot correct mistakes in character descriptions.
5. **Cannot create or edit story arcs** — Users see public arcs but cannot create custom ones from the UI.
6. **Cannot view or edit research reports** — ResearchList shows topic/status in a table but rows are not clickable. No detail view exists.
7. **Cannot view version history** — Content versions are saved to `content_versions_v2` on every edit, but no UI displays them. Users cannot see previous versions or revert changes.
8. **Cannot delete user accounts** — No account deletion feature for users or admins.
9. **Cannot schedule content for publishing** — Status includes "scheduled" but no date picker or scheduling UI exists.

---

## 3. DATA INTEGRITY RISKS

### 3.1 Orphaned Chapters on Project Deletion
**Finding:** `published_content_v2.project_id` references `writing_projects_v2(id)` but the FK constraint in the schema does NOT specify `ON DELETE CASCADE`. If a project is deleted (via SQL or future UI), chapters become orphaned with a dangling `project_id`.

### 3.2 Cascade Delete Without Warning
**Finding:** If user deletion is ever implemented, the cascade chain is:
```
User Deletion → users_v2
├── genre_config_v2 (CASCADE)
├── story_arcs_v2 (CASCADE)
├── writing_projects_v2 (CASCADE)
│   ├── story_bible_v2 (CASCADE)
│   ├── outline_versions_v2 (CASCADE)
│   └── published_content_v2 (CASCADE via project FK)
│       └── content_versions_v2 (CASCADE)
├── app_config_v2 (CASCADE)
├── content_usage_v2 (CASCADE)
└── research_reports_v2 (CASCADE)
```
A single user delete wipes ALL their data permanently with no archive or recovery option. No soft-delete mechanism exists.

### 3.3 No Confirmation for Destructive Actions
**Finding:** Status changes (draft → rejected) happen on a single button click with no confirmation dialog. Genre deletion uses the browser's native `confirm()` dialog. No other destructive actions have confirmation.

### 3.4 Version History Created but Inaccessible
**Finding:** `content_versions_v2` rows are created on every save (ContentDetail.tsx L47-64) with correct version numbering, but no UI exists to view, compare, or restore versions. The user has no way to know versions exist.

### 3.5 Outline Versions Table is Dead
**Finding:** `outline_versions_v2` table exists in the schema with indexes and RLS policies, but no code in the application ever inserts a row. Outline changes on projects have zero version tracking despite the infrastructure existing.

### 3.6 discovery_question Column Missing from Database
**Finding:** `StoryArc` TypeScript type includes `discovery_question: string | null` (database.ts L39) and StoryArcBrowser.tsx renders it (L67-70), but the column does NOT exist in `story_arcs_v2` table definition (supabase_setup_v2.sql). The field silently returns undefined.

### 3.7 No Unsaved Changes Warning
**Finding:** The TipTap editor auto-saves after 2 seconds of inactivity, but if a user navigates away within those 2 seconds, changes are lost without warning. No `beforeunload` handler or route-change confirmation.

### 3.8 Content-to-Project FK May Not Cascade
**Finding:** The schema shows `project_id UUID REFERENCES writing_projects_v2(id)` without explicit CASCADE behavior. Default PostgreSQL behavior is RESTRICT, which would prevent project deletion if chapters exist — but this isn't documented or handled in the UI.

### 3.9 Admin JSONB Self-Escalation
**Finding:** Users can update their own `users_v2.preferences` JSONB via the RLS UPDATE policy. The admin check reads from `preferences->>'role'`. A user could theoretically set `{"role": "admin"}` on their own record.

---

## 4. UI/UX DEFICIENCIES

### Non-Functional Features

#### 4.1 Eve Voice Orb Does Not Work
**Finding:** Clicking the Eve microphone orb at the bottom-right produces no visible result. The EveWidget component is lazy-loaded but:
- No microphone permission prompt appears
- No connection status indicator shows on screen
- The status card (EveWidget.tsx) renders below the orb but may be hidden off-screen or behind other elements
- No error handling if the ElevenLabs agent ID is invalid or the SDK fails to connect
- User has no feedback that anything is happening

#### 4.2 Social Posts Page is a Placeholder
**Finding:** Clicking "Social Posts" in the sidebar shows "Coming soon" — a static placeholder with no functionality.

#### 4.3 Cover Art Page is a Placeholder
**Finding:** Clicking "Cover Art" shows "Coming soon" — no gallery, no image display, no functionality.

#### 4.4 Research Reports Not Clickable
**Finding:** ResearchList displays a table of reports but rows have no `onClick` handler. Users cannot view the full content of a research report. No detail page exists.

#### 4.5 No Navigation to Admin Panel
**Finding:** The sidebar shows "Admin" only if `profile?.isAdmin` is true, but the `isAdmin` property is derived from `preferences?.role === 'admin'` which is never set through any UI flow. There is no way for the first admin to become admin through the application.

#### 4.6 No Navigation Between User Settings and Admin
**Finding:** Settings and Admin are separate pages with no cross-links. The user dropdown menu links to Settings but not Admin.

### Missing UI Elements

#### 4.7 No Search Functionality
**Finding:** No search bar exists anywhere in the application. Users must scroll through lists to find content. With 23 projects and 48 drafts, this is already painful.

#### 4.8 No Bulk Actions
**Finding:** Cannot select multiple items to approve, publish, reject, or delete. Each item must be individually managed.

#### 4.9 No Content Filtering Beyond Status
**Finding:** ContentList only filters by status (draft/approved/published/rejected/scheduled). No filters for genre, project, date range, or word count.

#### 4.10 No Dark Mode Toggle
**Finding:** The app includes TailwindCSS dark mode classes (`dark:`) throughout, but no toggle button exists in the UI. Dark mode only activates via OS-level settings.

#### 4.11 No Keyboard Shortcuts
**Finding:** The editor toolbar Save button shows a tooltip "Save now (Ctrl+S)" but no actual Ctrl+S keyboard handler is registered. No other keyboard shortcuts exist.

#### 4.12 Breadcrumb Shows Raw UUIDs
**Finding:** When viewing content at `/content/6ff754f2-a48d-43cd-9b37-bebd2d14e660`, the breadcrumb displays the full UUID instead of the content title.

#### 4.13 Sidebar Doesn't Auto-Collapse on Mobile
**Finding:** `sidebarOpen` defaults to `true`. On mobile screens, the sidebar takes up full width and overlaps content until manually toggled.

### Accessibility Issues

#### 4.14 Table Rows Not Keyboard Navigable
**Finding:** Clickable table rows use `<tr onClick>` but have no `tabIndex`, `role="button"`, or `onKeyDown` handler. Keyboard-only users cannot navigate content lists.

#### 4.15 Status Badges Rely on Color Alone
**Finding:** Status badges (draft=gray, approved=blue, published=green, rejected=red) distinguish states only by color. No icon or pattern differentiation for colorblind users.

#### 4.16 Eve Status Indicator Color-Only
**Finding:** EveWidget shows a colored dot (green/yellow/brand) with no text label for screen readers or colorblind users. The text label exists but is alongside, not associated via aria.

#### 4.17 Story Bible Uses Emoji Icons
**Finding:** StoryBiblePanel uses Unicode emojis as category icons. No alt text or aria-label for screen readers.

#### 4.18 No Error Boundary
**Finding:** No React Error Boundary component exists. A single component crash (e.g., malformed outline JSONB) crashes the entire application with a white screen.

### Visual/Layout Issues

#### 4.19 Genre Delete Uses Native Browser Dialog
**Finding:** `confirm()` is used for genre deletion — unstyled, inconsistent with the app's design language.

#### 4.20 No Loading Skeletons
**Finding:** All loading states show a plain "Loading..." text string. No skeleton loaders for content, tables, or cards.

#### 4.21 No Empty State Illustrations
**Finding:** Empty states show plain text ("No projects yet.") with no illustrations or calls-to-action.

#### 4.22 No Toast Notifications
**Finding:** Status changes, saves, and errors only show inline text. No toast/snackbar notification system for global feedback.

#### 4.23 ExportDialog Doesn't Explain What Gets Exported
**Finding:** The export dialog shows page size selection but doesn't tell the user: which chapters are included, whether only published chapters are exported, or if Prologue/Epilogue are included.

---

## 5. MISSING FEATURES

### 5.1 No User Roles System
**Finding:** The application references admin vs. user roles but has no role management UI. Cannot assign roles, view roles, or create role-based permissions. The `is_admin()` function exists in SQL but the admin flag is stored in an unprotected JSONB field.

### 5.2 No Content Preview Mode
**Finding:** Content can be edited but there is no "preview" mode to see how published content would appear.

### 5.3 No Project Creation from UI
**Finding:** Projects can only be created through external systems (n8n/Eve). The UI cannot create a new writing project.

### 5.4 No Content Duplication
**Finding:** Cannot duplicate/clone a project, chapter, or any content item.

### 5.5 No Content Import
**Finding:** No way to import existing manuscripts, documents, or text files into the system.

### 5.6 No Collaborative Features
**Finding:** No multi-user collaboration on the same project. No comments, @mentions, or shared editing.

### 5.7 No Activity Log/Audit Trail
**Finding:** No record of who did what and when. No audit log table or UI.

### 5.8 No Notifications
**Finding:** No in-app notifications for completed writing tasks, status changes, or system events.

### 5.9 No API Documentation
**Finding:** No OpenAPI/Swagger documentation for the server endpoints.

### 5.10 No Onboarding Tutorial
**Finding:** First-time users see the dashboard with no guidance on how to use the application, what Eve is, or how to create content.

---

## 6. SERVER & PRODUCTION READINESS

### 6.1 No Graceful Shutdown
**Finding:** Server has no SIGTERM/SIGINT handlers. Docker restart kills connections abruptly, risking incomplete exports.

### 6.2 No Structured Logging
**Finding:** All logging uses `console.log()` and `console.error()`. No log levels, timestamps, request IDs, or structured format for production monitoring.

### 6.3 No Rate Limiting
**Finding:** No rate limiting on any endpoint. The export endpoint (CPU-intensive .docx generation) can be called unlimited times.

### 6.4 Health Check Doesn't Verify Dependencies
**Finding:** `/api/health` returns `{"status":"ok"}` without checking Supabase connectivity, environment variables, or service health.

### 6.5 Dockerfile Port Mismatch
**Finding:** Dockerfile sets `ENV PORT=3000`, but `.env.example` specifies `PORT=3001`. The server defaults to 3001 in code.

### 6.6 No Error Boundary Middleware
**Finding:** No centralized Express error handler. Uncaught errors could leak stack traces in production.

### 6.7 No Request Logging
**Finding:** No request/response logging middleware. Cannot audit data access or investigate incidents.

### 6.8 Admin Routes Return 501 Not Implemented
**Finding:** Four admin endpoints exist in the server but all return `501 Not implemented`. The client-side AdminPanel makes direct Supabase queries instead, bypassing the server entirely.

---

## 7. CODE QUALITY ISSUES

### 7.1 Silent Query Failures
**Finding:** Multiple components destructure query results without error handling:
```typescript
const { data: chapters } = useQuery({ ... }); // Error silently ignored
```
If queries fail, components show empty states instead of error messages. Users think they have no data.

### 7.2 Query Cache Key Inconsistency
**Finding:** GenreForm invalidates `['genres']` but GenreList queries with `['genres', userId]`. The invalidation may not trigger a refetch due to key mismatch.

### 7.3 Dashboard Doesn't Refresh After External Changes
**Finding:** If content is created via Eve or the chat, the dashboard counts and recent activity don't update until manual page refresh. No polling or real-time subscription.

### 7.4 Chat Messages Grow Unbounded
**Finding:** ChatDrawer's `messages` array grows indefinitely with no limit, pagination, or cleanup.

### 7.5 Content-Utils XSS Risk
**Finding:** `contentToHtml()` uses `marked.parse()` without sanitization (no DOMPurify). If content contains malicious HTML/script tags, it could execute in the browser. TipTap may sanitize on input, but the conversion happens before TipTap receives the content.

### 7.6 EveWidget Stale User ID
**Finding:** EveWidget's useEffect has an empty dependency array with eslint-disable. If the user's profile changes, the conversation continues with the old user_id.

---

## 8. RECOMMENDATIONS (Priority Order)

### Immediate (Before Any Customer Demo)
1. Add JWT auth middleware to all server endpoints
2. Fix admin role escalation vulnerability (restrict preferences update)
3. Make Eve voice orb functional with visible feedback
4. Add delete operations for content, projects, and accounts
5. Display version history in ContentDetail
6. Make research report rows clickable with detail view
7. Replace Social Posts and Cover Art placeholders with "Beta" messaging or remove from sidebar

### Short-Term (Before Launch)
8. Implement proper user roles system with dedicated column
9. Add search functionality across all list pages
10. Add confirmation dialogs for all destructive actions
11. Implement soft deletes with archive/restore
12. Add error boundaries around route components
13. Implement CORS whitelist, rate limiting, security headers
14. Add input validation on all server endpoints
15. Fix cascade delete behavior (document or add CASCADE)
16. Add `discovery_question` column to `story_arcs_v2`

### Medium-Term (Post-Launch)
17. Add pagination to all list pages
18. Implement dark mode toggle in Settings
19. Add keyboard shortcuts (Ctrl+S, Cmd+K search)
20. Add unsaved changes warning before navigation
21. Implement project creation from UI
22. Add story arc creation/editing
23. Add story bible entry editing
24. Build content metrics dashboard (content_usage_v2)
25. Add structured logging and monitoring

### Long-Term (Product Maturity)
26. E2E test suite (Playwright)
27. Content import/export (Markdown, Word)
28. Collaborative editing
29. Activity log/audit trail
30. API versioning and documentation
31. In-app notifications
32. Onboarding tutorial for new users

---

## 9. ACCEPTANCE CRITERIA NOT MET

Based on the original design specification, the following acceptance criteria are **not met**:

| Spec Requirement | Status | Issue |
|-----------------|--------|-------|
| Eve voice widget functional | FAIL | No visible response on click |
| All content types viewable and editable | PARTIAL | Research, social, cover art not viewable |
| Content library with approve/publish/reject/delete | PARTIAL | No delete operation |
| Version history viewer with diffs | FAIL | Versions created but no UI to view |
| Scheduled publishing view | FAIL | No date picker or scheduling UI |
| User roles and admin management | FAIL | No role assignment, escalation vulnerability |
| Workflow monitoring in admin | FAIL | Returns 501 Not Implemented |
| Storage usage in admin | FAIL | Returns 501 Not Implemented |
| System health in admin | FAIL | Returns 501 Not Implemented |
| Dark/light theme toggle | FAIL | No toggle in UI |
| Responsive mobile sidebar | PARTIAL | Doesn't auto-collapse on mobile |
| Word/KDP export with template | PARTIAL | Export works but doesn't use S3 template |

---

*This audit represents the critical perspective of a customer evaluating whether to purchase this product. The architecture is promising but the implementation is incomplete for production use. The security deficiencies alone would prevent acceptance.*
