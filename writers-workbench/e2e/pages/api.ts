import { request as pwRequest, type APIRequestContext } from '@playwright/test';

/**
 * Shared API + DB helpers for the RESULT-ASSERTING regression suite.
 *
 * Every UI test proves the backing data actually changed, and isolates its own data (create a disposable
 * row, assert, hard-delete in teardown). These helpers give tests:
 *   - a bearer token for the demo user (Supabase password grant) to call the real /api routes,
 *   - a thin /api client,
 *   - direct Supabase REST (service key) to read/verify rows and to hard-delete disposable data
 *     (the /api DELETE for editions is only a SOFT delete, so teardown goes straight to the DB).
 *
 * Env (see e2e/pages README / session_context): E2E_BASE_URL, E2E_TEST_EMAIL, E2E_TEST_PASSWORD,
 * SUPABASE_URL, VITE_SUPABASE_ANON_KEY, E2E_SUPA_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY), E2E_USER_ID.
 */
export const DEMO_USER_ID = process.env.E2E_USER_ID || '+14105914612';
const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173';
const SUPA_URL = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/$/, '');
const SUPA_SERVICE = process.env.E2E_SUPA_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON = process.env.VITE_SUPABASE_ANON_KEY || '';

let _token: string | null = null;

/** Supabase password-grant access token for the demo user (cached per run). */
export async function getToken(): Promise<string> {
  if (_token) return _token;
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;
  if (!email || !password || !SUPA_URL || !ANON) {
    throw new Error('getToken needs E2E_TEST_EMAIL/PASSWORD + SUPABASE_URL + VITE_SUPABASE_ANON_KEY');
  }
  const ctx = await pwRequest.newContext();
  const res = await ctx.post(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    data: { email, password },
  });
  if (!res.ok()) throw new Error(`password grant failed: ${res.status()} ${await res.text()}`);
  const j = await res.json();
  await ctx.dispose();
  _token = j.access_token as string;
  return _token;
}

/** An APIRequestContext that hits the DEV server /api with the demo user's bearer token. */
export async function apiClient(): Promise<APIRequestContext> {
  const token = await getToken();
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

// --------------------------------------------------------------------------- Supabase REST (service key)
function supaHeaders() {
  if (!SUPA_URL || !SUPA_SERVICE) throw new Error('SUPABASE_URL + E2E_SUPA_SERVICE_KEY required for DB verify');
  return { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` };
}

/** GET rows from a table. `query` is a raw PostgREST query string (e.g. "id=eq.x&select=*"). */
// NOTE: use Node's global fetch (not Playwright's request context) for Supabase REST. The new
// `sb_secret_…` service keys are rejected ("Forbidden use of secret API key in browser") when the client
// looks like a browser, which Playwright's APIRequestContext does. Node fetch sends a non-browser UA.
export async function supaGet<T = any>(table: string, query: string): Promise<T[]> {
  const url = `${SUPA_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: supaHeaders() });
  if (!res.ok) {
    throw new Error(`supaGet ${res.status} ${table}?${query} :: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as T[];
}

/** DELETE rows from a table matching the raw PostgREST filter (hard delete — teardown only). */
export async function supaDelete(table: string, filter: string): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: { ...supaHeaders(), Prefer: 'return=minimal' },
  });
}

/** URL-encode the demo phone user id for a PostgREST eq filter (raw '+' decodes to a space → 0 rows). */
export function eqUser(): string {
  return `user_id=eq.${encodeURIComponent(DEMO_USER_ID)}`;
}

// --------------------------------------------------------------------------- disposable projects
export async function seedProject(fields: { title: string; genre_slug?: string; outline?: Record<string, unknown> }): Promise<string> {
  const row = {
    user_id: DEMO_USER_ID,
    title: fields.title,
    genre_slug: fields.genre_slug ?? 'post-apocalyptic',
    outline: fields.outline ?? {},
    project_type: 'book',
    status: 'in_progress',
  };
  const res = await fetch(`${SUPA_URL}/rest/v1/writing_projects_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`seedProject ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const [created] = (await res.json()) as Array<{ id: string }>;
  return created.id;
}

export async function deleteProject(id: string): Promise<void> {
  await supaDelete('generated_images_v2', `project_id=eq.${id}`);
  await supaDelete('published_content_v2', `project_id=eq.${id}`);
  await supaDelete('story_bible_v2', `project_id=eq.${id}`);
  await supaDelete('writing_projects_v2', `id=eq.${id}`);
}

// --------------------------------------------------------------------------- disposable images
export async function seedImage(projectId: string, imageType: string, storagePath?: string): Promise<string> {
  const res = await fetch(`${SUPA_URL}/rest/v1/generated_images_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: DEMO_USER_ID, project_id: projectId, image_type: imageType,
      storage_path: storagePath ?? `${DEMO_USER_ID}/e2e-${imageType}-${Math.floor(Math.random() * 1e9)}.png`,
      original_prompt: 'disposable regression image', genre_slug: 'post-apocalyptic', image_format: 'png',
      generation_model: 'e2e', metadata: { title: `E2E ${imageType}` },
    }),
  });
  if (!res.ok) throw new Error(`seedImage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

// --------------------------------------------------------------------------- disposable research
export async function seedResearch(topic: string, genre = 'post-apocalyptic'): Promise<string> {
  const res = await fetch(`${SUPA_URL}/rest/v1/research_reports_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: DEMO_USER_ID, topic, genre_slug: genre, status: 'complete',
      content: `# ${topic}\n\nDisposable regression research report. `.repeat(20) }),
  });
  if (!res.ok) throw new Error(`seedResearch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}
export async function deleteResearch(id: string): Promise<void> {
  await supaDelete('research_report_projects_v2', `report_id=eq.${id}`);
  await supaDelete('research_reports_v2', `id=eq.${id}`);
}

/** Link a research report to a project (research_report_projects_v2) so it shows in that project's Research tab. */
export async function linkResearchToProject(reportId: string, projectId: string): Promise<void> {
  const res = await fetch(`${SUPA_URL}/rest/v1/research_report_projects_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: DEMO_USER_ID, report_id: reportId, project_id: projectId }),
  });
  if (!res.ok) throw new Error(`linkResearchToProject ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// --------------------------------------------------------------------------- disposable social posts
export async function seedSocialPost(fields: {
  projectId: string;
  platform: 'twitter' | 'linkedin' | 'instagram' | 'facebook';
  postText: string;
  hashtags?: string[];
  status?: string;
}): Promise<string> {
  const res = await fetch(`${SUPA_URL}/rest/v1/social_posts_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: DEMO_USER_ID, project_id: fields.projectId, platform: fields.platform,
      post_text: fields.postText, hashtags: fields.hashtags ?? [], status: fields.status ?? 'draft', metadata: {},
    }),
  });
  if (!res.ok) throw new Error(`seedSocialPost ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

// --------------------------------------------------------------------------- disposable story-bible entries
export async function seedBibleEntry(fields: {
  projectId: string;
  name: string;
  description: string;
  entryType?: string;
  chapterIntroduced?: number;
}): Promise<string> {
  const res = await fetch(`${SUPA_URL}/rest/v1/story_bible_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: DEMO_USER_ID, project_id: fields.projectId, entry_type: fields.entryType ?? 'character',
      name: fields.name, description: fields.description, chapter_introduced: fields.chapterIntroduced ?? 1, metadata: {},
    }),
  });
  if (!res.ok) throw new Error(`seedBibleEntry ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

// --------------------------------------------------------------------------- disposable token usage (Cost tab)
/** Insert a token_usage_v2 row tagged with a project_id so the project-scoped Cost tab has data to render. */
export async function seedTokenUsage(projectId: string): Promise<string> {
  const res = await fetch(`${SUPA_URL}/rest/v1/token_usage_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: DEMO_USER_ID, workflow_name: 'E2E Cost Regression', model: 'e2e-model',
      input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.0123,
      metadata: { project_id: projectId },
    }),
  });
  if (!res.ok) throw new Error(`seedTokenUsage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

/** Insert a private story arc directly (story_arcs_v2) for EDIT tests. Returns its id. */
export async function seedStoryArc(fields: { name: string; description: string; promptText?: string }): Promise<string> {
  const res = await fetch(`${SUPA_URL}/rest/v1/story_arcs_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: DEMO_USER_ID, name: fields.name, description: fields.description,
      prompt_text: fields.promptText ?? 'Structure the story in five disposable beats: [beat1]…[beat5].',
    }),
  });
  if (!res.ok) throw new Error(`seedStoryArc ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

/** Insert a private genre directly (genre_config_v2) for EDIT tests. Returns its id. */
export async function seedGenre(fields: {
  genreName: string; genreSlug: string; description: string; guidelines?: string;
}): Promise<string> {
  const res = await fetch(`${SUPA_URL}/rest/v1/genre_config_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: DEMO_USER_ID, genre_name: fields.genreName, genre_slug: fields.genreSlug,
      description: fields.description, writing_guidelines: fields.guidelines ?? 'Tone: disposable. Regression only.',
      keywords: ['disposable'], rss_feed_urls: [], source_urls: [], subreddit_names: [], goodreads_shelves: [], active: true,
    }),
  });
  if (!res.ok) throw new Error(`seedGenre ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

// --------------------------------------------------------------------------- disposable content rows
/** Insert a disposable published_content_v2 row (owned by the demo user) and return its id. */
export async function seedContent(fields: {
  title: string;
  content_type?: string;
  status?: string;
  content_text?: string;
  project_id?: string | null;
  chapter_number?: number | null;
  genre_slug?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const row = {
    user_id: DEMO_USER_ID,
    title: fields.title,
    content_type: fields.content_type ?? 'chapter',
    status: fields.status ?? 'draft',
    content_text: fields.content_text ?? 'Disposable regression content. '.repeat(20),
    genre_slug: fields.genre_slug ?? 'post-apocalyptic',
    project_id: fields.project_id ?? null,
    chapter_number: fields.chapter_number ?? null,
    metadata: fields.metadata ?? {},
  };
  const res = await fetch(`${SUPA_URL}/rest/v1/published_content_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`seedContent ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const [created] = (await res.json()) as Array<{ id: string }>;
  return created.id;
}

/** Read a single content row's fields (for before/after result assertions). */
/** Seed a chapter_qa_v2 row (used to put a chapter into a known drift state so Fix Drift renders). */
export async function seedChapterQa(projectId: string, chapterNumber: number, aligned: boolean): Promise<string> {
  const res = await fetch(`${SUPA_URL}/rest/v1/chapter_qa_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: DEMO_USER_ID, project_id: projectId, chapter_number: chapterNumber, aligned,
      drift_report: { aligned, character_drift: aligned ? 0 : 2 }, status: 'ok', word_count: 500,
    }),
  });
  if (!res.ok) throw new Error(`seedChapterQa ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

/** Latest chapter_qa_v2 row for a project+chapter (for asserting a repair/QA result). */
export async function latestChapterQa(projectId: string, chapterNumber: number): Promise<any | null> {
  const rows = await supaGet('chapter_qa_v2',
    `project_id=eq.${projectId}&chapter_number=eq.${chapterNumber}&order=created_at.desc&limit=1&select=id,aligned,created_at,status`);
  return rows[0] ?? null;
}

export async function getContent(id: string, select = 'id,status,content_text,metadata'): Promise<any | null> {
  const rows = await supaGet('published_content_v2', `id=eq.${id}&select=${select}`);
  return rows[0] ?? null;
}

export async function deleteContent(id: string): Promise<void> {
  await supaDelete('content_versions_v2', `content_id=eq.${id}`);
  await supaDelete('published_content_v2', `id=eq.${id}`);
}

/** Hard-delete a disposable newsletter edition and ALL its children (teardown; bypasses the soft delete). */
export async function hardDeleteEdition(id: string): Promise<void> {
  await supaDelete('newsletter_approvals_v2', `edition_id=eq.${encodeURIComponent(id)}`);
  await supaDelete('newsletter_sends_v2', `edition_id=eq.${encodeURIComponent(id)}`);
  await supaDelete('newsletter_subscribers_v2', `edition_id=eq.${encodeURIComponent(id)}`);
  await supaDelete('newsletter_feed_sources_v2', `edition_id=eq.${encodeURIComponent(id)}`);
  await supaDelete('newsletter_templates_v2', `edition_id=eq.${encodeURIComponent(id)}`);
  await supaDelete('newsletter_editions_v2', `id=eq.${encodeURIComponent(id)}`);
}


// --------------------------------------------------------------------------- newsletter (agent C helpers)

/** Insert a disposable newsletter_templates_v2 row (owned by the demo user) and return its id. */
export async function seedTemplate(fields: {
  edition_id: string;
  name: string;
  html?: string;
  is_default?: boolean;
  active?: boolean;
  sample_data?: Record<string, unknown>;
}): Promise<string> {
  const row = {
    user_id: DEMO_USER_ID,
    edition_id: fields.edition_id,
    name: fields.name,
    source_type: 'user',
    html: fields.html ?? '<!doctype html><html><body><h1>{{title}}</h1><p>Seed template.</p></body></html>',
    sample_data: fields.sample_data ?? { title: 'Seed title' },
    is_default: fields.is_default ?? false,
    active: fields.active ?? true,
  };
  const res = await fetch(`${SUPA_URL}/rest/v1/newsletter_templates_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`seedTemplate ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

export async function deleteTemplate(id: string): Promise<void> {
  await supaDelete('newsletter_templates_v2', `id=eq.${encodeURIComponent(id)}`);
}

/** Insert a disposable newsletter_feed_sources_v2 row and return its id. */
export async function seedFeed(fields: {
  edition_id: string;
  name: string;
  url?: string;
  url_type?: string;
  active?: boolean;
}): Promise<string> {
  const row = {
    edition_id: fields.edition_id,
    user_id: DEMO_USER_ID,
    name: fields.name,
    url: fields.url ?? `https://example.com/e2e-feed-${Math.floor(Math.random() * 1e9)}.xml`,
    url_type: fields.url_type ?? 'rss',
    fetch_interval_minutes: 240,
    active: fields.active ?? true,
  };
  const res = await fetch(`${SUPA_URL}/rest/v1/newsletter_feed_sources_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`seedFeed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

/** Insert a disposable newsletter_sends_v2 row (owned by the demo user) and return its id. */
export async function seedSend(fields: {
  edition_id: string;
  subject: string;
  status?: string;
  html_body?: string;
  markdown_body?: string;
  send_date?: string;
}): Promise<string> {
  const row = {
    user_id: DEMO_USER_ID,
    edition_id: fields.edition_id,
    subject: fields.subject,
    preheader: 'Disposable regression send',
    status: fields.status ?? 'sent',
    send_date: fields.send_date ?? new Date().toISOString().slice(0, 10),
    html_body: fields.html_body ?? '<!doctype html><html><body><h1>E2E send body</h1><p>Rendered HTML for the regression detail view.</p></body></html>',
    markdown_body: fields.markdown_body ?? '# E2E send\n\nDisposable markdown source for the regression detail view.',
  };
  const res = await fetch(`${SUPA_URL}/rest/v1/newsletter_sends_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`seedSend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<{ id: string }>)[0].id;
}

export async function deleteSend(id: string): Promise<void> {
  await supaDelete('newsletter_sends_v2', `id=eq.${encodeURIComponent(id)}`);
}

/** Insert a disposable OPEN newsletter_approvals_v2 row (owned by the demo user) and return {id, token}. */
export async function seedApproval(fields: {
  edition_id: string;
  stage?: 'stories' | 'subject_line';
  payload?: Record<string, unknown>;
}): Promise<{ id: string; token: string }> {
  // Token must satisfy the server's ^[A-Za-z0-9_-]{20,128}$ (ApprovalTokenParamSchema).
  const token = `e2etok${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 40)
    .padEnd(24, 'x');
  const stage = fields.stage ?? 'stories';
  const payload = fields.payload ?? (stage === 'stories'
    ? { top_selected_stories: [{ title: 'E2E disposable story headline' }] }
    : { subject_line: 'E2E disposable subject line' });
  const row = {
    token,
    user_id: DEMO_USER_ID,
    edition_id: fields.edition_id,
    execution_id: `e2e-exec-${Date.now()}`,
    // A resume_url the server can't reach → resolveApproval persists the decision FIRST,
    // then the n8n resume POST fails → status 502 "resume_failed". The decision/resolved_at
    // IS written to the DB regardless; that persisted result is what the test asserts.
    resume_url: 'https://n8n.agileadautomation.com/__e2e_resume_will_not_exist',
    stage,
    payload,
    expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
  };
  const res = await fetch(`${SUPA_URL}/rest/v1/newsletter_approvals_v2`, {
    method: 'POST',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`seedApproval ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const [created] = (await res.json()) as Array<{ id: string; token: string }>;
  return { id: created.id, token: created.token };
}

export async function deleteApproval(id: string): Promise<void> {
  await supaDelete('newsletter_approvals_v2', `id=eq.${encodeURIComponent(id)}`);
}

/** Seed a project already soft-deleted (deleted_at set) so TrashView renders it. Returns its id. */
export async function seedTrashedProject(title: string): Promise<string> {
  const id = await seedProject({ title });
  await fetch(`${SUPA_URL}/rest/v1/writing_projects_v2?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...supaHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  return id;
}

/** Read a project's deleted_at (null once restored). */
export async function projectDeletedAt(id: string): Promise<string | null | undefined> {
  const rows = await supaGet('writing_projects_v2', `id=eq.${id}&select=deleted_at`);
  return rows[0]?.deleted_at;
}
