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
  await supaDelete('newsletter_subscribers_v2', `edition_id=eq.${encodeURIComponent(id)}`);
  await supaDelete('newsletter_feed_sources_v2', `edition_id=eq.${encodeURIComponent(id)}`);
  await supaDelete('newsletter_templates_v2', `edition_id=eq.${encodeURIComponent(id)}`);
  await supaDelete('newsletter_editions_v2', `id=eq.${encodeURIComponent(id)}`);
}
