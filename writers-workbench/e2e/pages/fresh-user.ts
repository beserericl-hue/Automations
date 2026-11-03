/**
 * A fresh, non-privileged DEV user for specs that must see credits really checked and charged (an
 * admin/superuser is exempt). Created with the service key, signed in by a minted magic link (the
 * accounts are passwordless), put on the trial plan, and deleted by `cleanupFreshUsers()`.
 *
 * DEV only: refuses any Supabase that is not gvbvwcnmjkdpclcisqrr.
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173';
const SUPA_URL = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/$/, '');
const SERVICE = process.env.E2E_SUPA_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON = process.env.VITE_SUPABASE_ANON_KEY || '';
export const HAS_DEV_KEYS = Boolean(SUPA_URL && SERVICE && ANON && /gvbvwcnmjkdpclcisqrr/.test(SUPA_URL));

export function svcHeaders(): Record<string, string> {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
}

export interface FreshUser { userId: string; authId: string; email: string; token: string; refresh: string; session: unknown }
const made: FreshUser[] = [];

/** Sign a browser page in as this user (supabase-js reads the session from localStorage on boot). */
export async function signInPage(page: import('@playwright/test').Page, user: FreshUser): Promise<void> {
  const key = `sb-${new URL(SUPA_URL).hostname.split('.')[0]}-auth-token`;
  await page.addInitScript(({ k, v }) => { try { window.localStorage.setItem(k, v); } catch { /* about:blank */ } }, { k: key, v: JSON.stringify(user.session) });
}

export async function makeFreshUser(tag: string): Promise<FreshUser> {
  if (!HAS_DEV_KEYS) throw new Error('DEV keys missing (or not DEV)');
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const email = `${tag}-e2e+${run}@example.com`;
  const userId = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const created = await fetch(`${SUPA_URL}/auth/v1/admin/users`, { method: 'POST', headers: svcHeaders(), body: JSON.stringify({ email, email_confirm: true }) });
  if (!created.ok) throw new Error(`create auth user: ${created.status} ${await created.text()}`);
  const auth = (await created.json()) as { id: string };
  const row = await fetch(`${SUPA_URL}/rest/v1/users_v2`, { method: 'POST', headers: { ...svcHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId, phone_number: userId, display_name: `${tag} E2E ${run}`, email, role: 'user', supabase_auth_uid: auth.id }) });
  if (!row.ok) throw new Error(`create users_v2: ${row.status} ${await row.text()}`);
  const link = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svcHeaders(), body: JSON.stringify({ type: 'magiclink', email }) });
  const { hashed_token } = (await link.json()) as { hashed_token: string };
  const verify = await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed_token }) });
  const session = (await verify.json()) as { access_token: string; refresh_token: string };
  const user = { userId, authId: auth.id, email, token: session.access_token, refresh: session.refresh_token, session };
  made.push(user);
  const sub = await userApi(user, 'POST', '/api/account/subscribe', { tier_name: 'trial', billing_cycle: 'none' });
  if (sub.status !== 200) throw new Error(`trial subscribe: ${sub.status} ${JSON.stringify(sub.json)}`);
  return user;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function userApi(user: Pick<FreshUser, 'token'>, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

export async function balanceOf(userId: string): Promise<number> {
  const r = await fetch(`${SUPA_URL}/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=credits_remaining`, { headers: svcHeaders() });
  const [sub] = (await r.json()) as Array<{ credits_remaining: number }>;
  return Number(sub?.credits_remaining);
}

/** Set a fresh user's balance directly (DEV test fixture; the ledger is not involved). */
export async function setBalance(userId: string, credits: number): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH', headers: { ...svcHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify({ credits_remaining: credits }),
  });
}

/** A project + one chapter owned by the user, for the priced chapter ops. */
export async function seedChapter(user: FreshUser): Promise<{ projectId: string; contentId: string }> {
  const p = await fetch(`${SUPA_URL}/rest/v1/writing_projects_v2`, { method: 'POST', headers: { ...svcHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: user.userId, title: `Pricing E2E ${Date.now().toString(36)}`, genre_slug: 'post-apocalyptic', project_type: 'book', status: 'in_progress',
      outline: { chapters: [{ chapter_number: 1, title: 'The Salt Road', summary: 'Mara crosses the salt flats with the last water.' }] } }) });
  if (!p.ok) throw new Error(`seed project: ${p.status} ${await p.text()}`);
  const [project] = (await p.json()) as Array<{ id: string }>;
  const text = 'Mara walked the salt road at dawn. The water skins hung heavy on her shoulders, and she counted every step. '
    + 'Behind her the town burned low. Ahead the flats shone white and empty, and somewhere past them the river still ran.';
  const c = await fetch(`${SUPA_URL}/rest/v1/published_content_v2`, { method: 'POST', headers: { ...svcHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: user.userId, project_id: project.id, content_type: 'chapter', chapter_number: 1, title: 'The Salt Road', content_text: text, status: 'draft', genre_slug: 'post-apocalyptic', metadata: {} }) });
  if (!c.ok) throw new Error(`seed chapter: ${c.status} ${await c.text()}`);
  const [content] = (await c.json()) as Array<{ id: string }>;
  return { projectId: project.id, contentId: content.id };
}

/** Delete every user this run made (account delete cancels any Stripe subscription first). */
export async function cleanupFreshUsers(): Promise<void> {
  for (const u of made.splice(0)) {
    const del = await userApi(u, 'DELETE', '/api/account', { confirmation: 'DELETE' }).catch(() => ({ status: 0 }));
    if (del.status !== 200) {
      for (const t of ['published_content_v2', 'writing_projects_v2', 'research_reports_v2']) {
        await fetch(`${SUPA_URL}/rest/v1/${t}?user_id=eq.${encodeURIComponent(u.userId)}`, { method: 'DELETE', headers: svcHeaders() });
      }
      await fetch(`${SUPA_URL}/rest/v1/users_v2?user_id=eq.${encodeURIComponent(u.userId)}`, { method: 'DELETE', headers: svcHeaders() });
      await fetch(`${SUPA_URL}/auth/v1/admin/users/${u.authId}`, { method: 'DELETE', headers: svcHeaders() });
    }
  }
}
