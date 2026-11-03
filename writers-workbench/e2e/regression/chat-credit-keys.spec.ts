import { test, expect } from '@playwright/test';
import { supaGet } from '../pages/api';

/**
 * Chat credit keys — RESULT-asserting, against DEV. Heavy (Pass B): starts one real research job.
 *
 * The bug: the chat classifier names a research request `research_report`, which was not a key in
 * the credit table (services/credit-costs.ts), so research asked for in chat cost 0 credits while
 * the same research through Research → Run cost 2. Same for social posts, outline edits.
 *
 * PASS: a NON-superuser (a fresh trial user, so credits are really checked) asks chat for research;
 * the response says it charged the research price, the subscription balance dropped by exactly that
 * much, and the credit ledger has one usage row for it. FAIL: charged 0 / balance unchanged / no
 * ledger row — the naming gap is back.
 *
 * The user is created for the run and deleted at the end (after its research job has settled, so
 * nothing is written for a user that no longer exists).
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173';
const SUPA_URL = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/$/, '');
const SERVICE = process.env.E2E_SUPA_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON = process.env.VITE_SUPABASE_ANON_KEY || '';
const HAS_KEYS = Boolean(SUPA_URL && SERVICE && ANON && /gvbvwcnmjkdpclcisqrr/.test(SUPA_URL));
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const DEFAULT_RESEARCH_COST = 2; // DEFAULT_CREDIT_COSTS.research

function svc(): Record<string, string> {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
}

const made: Array<{ userId: string; authId: string; token: string }> = [];
const jobs: Array<{ token: string; id: string }> = [];
const DONE = /complete|error|not_found|aborted|failed/;

async function makeUser(): Promise<{ userId: string; token: string }> {
  const email = `credit-keys-e2e+${RUN}@example.com`;
  const userId = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const created = await fetch(`${SUPA_URL}/auth/v1/admin/users`, { method: 'POST', headers: svc(), body: JSON.stringify({ email, email_confirm: true }) });
  if (!created.ok) throw new Error(`create auth user: ${created.status} ${await created.text()}`);
  const auth = (await created.json()) as { id: string };
  const row = await fetch(`${SUPA_URL}/rest/v1/users_v2`, { method: 'POST', headers: { ...svc(), Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId, phone_number: userId, display_name: `Credit Keys E2E ${RUN}`, email, role: 'user', supabase_auth_uid: auth.id }) });
  if (!row.ok) throw new Error(`create users_v2: ${row.status} ${await row.text()}`);
  const link = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc(), body: JSON.stringify({ type: 'magiclink', email }) });
  const { hashed_token } = (await link.json()) as { hashed_token: string };
  const verify = await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed_token }) });
  const { access_token } = (await verify.json()) as { access_token: string };
  made.push({ userId, authId: auth.id, token: access_token });
  return { userId, token: access_token };
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/** The research price as DEV is configured: a superuser override, else the code default. */
async function researchCost(): Promise<number> {
  const rows = await supaGet<{ value: string }>('app_config_global_v2', 'key=eq.sprint8_superuser_config&select=value');
  try {
    const v = rows[0]?.value;
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    const n = parsed?.credit_costs?.research;
    if (typeof n === 'number') return n;
  } catch { /* fall through to the default */ }
  return DEFAULT_RESEARCH_COST;
}

async function balanceOf(userId: string): Promise<number> {
  const [sub] = await supaGet<{ credits_remaining: number }>('user_subscriptions', `user_id=eq.${encodeURIComponent(userId)}&select=credits_remaining`);
  return Number(sub?.credits_remaining);
}

test.describe('Chat operations are charged under the same credit key as their screen', () => {
  test.skip(!HAS_KEYS, 'needs the DEV service and anon keys');
  test.setTimeout(8 * 60_000);

  test('research asked for in chat costs what Research → Run costs, and the ledger records it', async () => {
    const expected = await researchCost();
    expect(expected, 'research must be a paid operation for this test to mean anything').toBeGreaterThan(0);

    const user = await makeUser();
    // A real, non-privileged subscriber: the free trial tier, so the credit gate is live.
    const sub = await api(user.token, 'POST', '/api/account/subscribe', { tier_name: 'trial', billing_cycle: 'none' });
    expect(sub.status, JSON.stringify(sub.json)).toBe(200);
    const before = await balanceOf(user.userId);
    expect(before).toBeGreaterThanOrEqual(expected);

    const chat = await api(user.token, 'POST', '/api/chat/proxy', {
      user_message_request: 'research the history of lighthouse keepers on the coast of Maine',
      user_id: user.userId,
    });
    expect(chat.status, JSON.stringify(chat.json).slice(0, 400)).toBe(200);
    if (chat.json.engineJob && chat.json.jobId) jobs.push({ token: user.token, id: String(chat.json.jobId) });
    // The classifier still labels it research_report (the drawer badge); what changed is its price.
    expect(chat.json.classification?.jobType).toBe('research_report');
    expect(chat.json.creditsCharged).toBe(expected);
    expect(chat.json.creditsRemaining).toBe(before - expected);

    // The balance in the database moved by exactly the research price…
    expect(await balanceOf(user.userId)).toBe(before - expected);
    // …and the ledger has exactly one usage row for it.
    const usage = await supaGet<{ amount: number; balance_after: number; description: string }>('credit_transactions',
      `user_id=eq.${encodeURIComponent(user.userId)}&transaction_type=eq.usage&select=amount,balance_after,description`);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ amount: -expected, balance_after: before - expected });
    expect(usage[0].description).toMatch(/^chat\.[a-z-]+:research_report$/);
  });
});

// Whatever a run created goes, even when the test failed half way. The research job is let settle
// (or aborted) first, so nothing is written for a user that no longer exists.
test.afterAll(async () => {
  test.setTimeout(7 * 60_000);
  for (const j of jobs) {
    let status = '';
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      status = String((await api(j.token, 'GET', `/api/jobs/engine/${j.id}/status`)).json.status ?? '');
      if (DONE.test(status)) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (!DONE.test(status)) await api(j.token, 'POST', `/api/jobs/engine/${j.id}/abort`);
  }
  for (const u of made) {
    const del = await api(u.token, 'DELETE', '/api/account', { confirmation: 'DELETE' }).catch(() => ({ status: 0 }));
    if (del.status !== 200) {
      await fetch(`${SUPA_URL}/rest/v1/users_v2?user_id=eq.${encodeURIComponent(u.userId)}`, { method: 'DELETE', headers: svc() });
      await fetch(`${SUPA_URL}/auth/v1/admin/users/${u.authId}`, { method: 'DELETE', headers: svc() });
    }
    await fetch(`${SUPA_URL}/rest/v1/research_reports_v2?user_id=eq.${encodeURIComponent(u.userId)}`, { method: 'DELETE', headers: svc() });
  }
});
