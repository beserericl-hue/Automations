import { test, expect, type Page } from '@playwright/test';
import { DEMO_USER_ID, RUN_TAG, apiClient, getToken, supaDelete, supaGet } from '../pages/api';

/**
 * Settings → Integrations (migration 043): the user's own Blotato account, LinkedIn targets and blog
 * websites. RESULT-asserting: each UI step is checked in social_channels_v2 / user_integrations_v2.
 *
 * PASS:
 *  - the screen renders every section and field; secrets are masked (password inputs, empty, only
 *    "Set · ends ••••xxxx" / "Not set" shown) and no ciphertext or secret reaches the browser;
 *  - LinkedIn targets and websites can be added, edited and removed, in the DB and on screen;
 *  - a website token is stored as AES-GCM ciphertext (v1.…), never as plaintext, and Test sends it to
 *    the endpoint in the configured header (against https://httpbin.org/anything — an echo service,
 *    never the real blog) without the response coming back to the browser;
 *  - errors show: short key, non-numeric page id, http:// endpoint, metadata-IP endpoint (SSRF),
 *    Test with nothing saved;
 *  - the table cannot be read through PostgREST with the user's own token;
 *  - another user's channel cannot be edited through the API.
 *
 * The owner's real Blotato key is never overwritten or removed: the Blotato key is only exercised
 * through paths that save nothing, and the account id is restored after the edit test.
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);
const USER = encodeURIComponent(DEMO_USER_ID);
const SUPA_URL = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/$/, '');
const ANON = process.env.VITE_SUPABASE_ANON_KEY || '';
const TAG = `${RUN_TAG}`.slice(-6);
const ECHO = 'https://httpbin.org/anything';

test.describe.configure({ mode: 'serial' });

async function open(page: Page): Promise<void> {
  await page.goto('/settings/integrations', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible({ timeout: 20_000 });
}

async function channels(): Promise<any[]> {
  return supaGet('social_channels_v2', `user_id=eq.${USER}&select=*`);
}

test.describe('Settings → Integrations (result-asserting)', () => {
  test.skip(!HAS_KEY, 'requires service key');
  const created: string[] = [];

  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => void d.accept());
  });

  test.afterAll(async () => {
    for (const ch of created) {
      await supaDelete('social_channels_v2', `user_id=eq.${USER}&channel=eq.${ch}`);
    }
  });

  test('renders every section and field, secrets masked, nothing secret sent to the browser', async ({ page }) => {
    const bodies: string[] = [];
    page.on('response', async (r) => {
      if (r.url().includes('/api/integrations')) bodies.push(await r.text().catch(() => ''));
    });
    await open(page);
    for (const id of ['blotato-section', 'linkedin-section', 'websites-section']) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('blotato-key-status')).toHaveText(/^(Not set|Set( · ends ••••.{4})?( · saved .+)?)$/);
    const key = page.getByTestId('blotato-api-key');
    await expect(key).toHaveAttribute('type', 'password');
    await expect(key).toHaveValue('');
    await expect(page.getByTestId('blotato-account-id')).toBeVisible();
    for (const b of ['blotato-save', 'blotato-test', 'li-add', 'web-add']) await expect(page.getByTestId(b)).toBeEnabled();
    // The DEV channels from the seed are listed, with their non-secret config.
    const rows = await channels();
    for (const r of rows.filter((c) => c.kind === 'linkedin')) await expect(page.getByTestId(`li-row-${r.channel}`)).toBeVisible();
    for (const r of rows.filter((c) => c.kind === 'website')) {
      await expect(page.getByTestId(`web-endpoint-${r.channel}`)).toContainText(r.config.endpoint);
      expect(r.config.auth_env, 'migration 043 drops auth_env').toBeUndefined();
    }
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toMatch(/"v1\.[A-Za-z0-9_-]+\./);
  });

  test('Blotato: a short key is refused and nothing is saved; account id edits are saved', async ({ page }) => {
    const before = (await supaGet('user_integrations_v2', `user_id=eq.${USER}&provider=eq.blotato&select=*`))[0];
    await open(page);
    await page.getByTestId('blotato-api-key').fill('short');
    await page.getByTestId('blotato-save').click();
    await expect(page.getByTestId('blotato-error')).toContainText('api_key');
    const after = (await supaGet('user_integrations_v2', `user_id=eq.${USER}&provider=eq.blotato&select=*`))[0];
    expect(after?.secret_ciphertext ?? null).toBe(before?.secret_ciphertext ?? null);

    // Account id: change, verify, restore.
    const original = String(before?.config?.account_id ?? '');
    await page.getByTestId('blotato-api-key').fill('');
    await page.getByTestId('blotato-account-id').fill(`e2e${TAG}`);
    await page.getByTestId('blotato-save').click();
    await expect.poll(async () =>
      (await supaGet('user_integrations_v2', `user_id=eq.${USER}&provider=eq.blotato&select=config`))[0]?.config?.account_id,
    { timeout: 15_000 }).toBe(`e2e${TAG}`);
    const api = await apiClient();
    try {
      const restore = await api.put('/api/integrations/blotato', { data: { account_id: original } });
      expect(restore.status(), await restore.text()).toBe(200);
    } finally {
      await api.dispose();
    }
    expect((await supaGet('user_integrations_v2', `user_id=eq.${USER}&provider=eq.blotato&select=config`))[0]?.config?.account_id).toBe(original);
  });

  test('Blotato: Test connection reports a missing key, and renders a result', async ({ page }) => {
    await open(page);
    const set = /^Set/.test((await page.getByTestId('blotato-key-status').textContent()) ?? '');
    if (!set) {
      // Real path: nothing saved → the server refuses before calling Blotato.
      await expect(page.getByTestId('blotato-remove-key')).toHaveCount(0);
      await page.getByTestId('blotato-test').click();
      await expect(page.getByTestId('blotato-error')).toContainText('No Blotato API key is saved');
    }
    // Rendering of a successful test (stubbed in the browser: no fake key is ever sent to Blotato).
    await page.route('**/api/integrations/blotato/test', (r) =>
      r.fulfill({ json: { success: true, data: { ok: true, status: 200, message: 'Connected: 1 account(s) on this Blotato key', accounts: [{ id: '9115', platform: 'linkedin', name: 'E2E' }] } } }));
    await page.getByTestId('blotato-test').click();
    await expect(page.getByTestId('blotato-test-result')).toContainText('account id 9115');
  });

  test('LinkedIn targets: add, edit, remove (and validation)', async ({ page }) => {
    const label = `E2E LI ${TAG}`;
    await open(page);
    await page.getByTestId('li-add').click();
    await page.getByTestId('li-new-label').fill(label);
    await page.getByTestId('li-new-page-id').fill('not-a-number');
    await page.getByTestId('li-new-save').click();
    await expect(page.getByTestId('li-new-error')).toContainText('page_id');
    await page.getByTestId('li-new-page-id').fill('123456789');
    await page.getByTestId('li-new-save').click();

    let row: any;
    await expect.poll(async () => {
      row = (await channels()).find((c) => c.label === label);
      return row?.config?.page_id;
    }, { timeout: 15_000 }).toBe('123456789');
    created.push(row.channel);
    expect(row).toMatchObject({ kind: 'linkedin', enabled: true });
    await expect(page.getByTestId(`li-row-${row.channel}`)).toContainText('company page 123456789');

    // Edit → personal profile, disabled.
    await page.getByTestId(`li-edit-${row.channel}`).click();
    await page.getByTestId(`li-edit-${row.channel}-personal`).check();
    await page.getByTestId(`li-edit-${row.channel}-enabled`).uncheck();
    await page.getByTestId(`li-edit-${row.channel}-save`).click();
    await expect.poll(async () => {
      const r = (await channels()).find((c) => c.channel === row.channel);
      return `${r?.enabled}|${r?.config?.page_id ?? 'none'}`;
    }, { timeout: 15_000 }).toBe('false|none');
    await expect(page.getByTestId(`li-row-${row.channel}`)).toContainText('personal profile');
    await expect(page.getByTestId(`li-row-${row.channel}`)).toContainText('off');

    // Remove.
    await page.getByTestId(`li-remove-${row.channel}`).click();
    await expect.poll(async () => (await channels()).some((c) => c.channel === row.channel), { timeout: 15_000 }).toBe(false);
    await expect(page.getByTestId(`li-row-${row.channel}`)).toHaveCount(0);
  });

  test('Websites: add with an encrypted token, test it, edit, refuse unsafe endpoints, remove', async ({ page }) => {
    const label = `E2E Blog ${TAG}`;
    const token = `e2e-dummy-token-${TAG}-ZQ42`;
    await open(page);
    await page.getByTestId('web-add').click();
    await page.getByTestId('web-new-label').fill(label);
    await page.getByTestId('web-new-endpoint').fill('http://example.com/api');
    await page.getByTestId('web-new-auth_token').fill(token);
    await page.getByTestId('web-new-save').click();
    await expect(page.getByTestId('web-new-error')).toContainText('https://');

    await page.getByTestId('web-new-endpoint').fill('https://169.254.169.254/latest/meta-data/');
    await page.getByTestId('web-new-save').click();
    await expect(page.getByTestId('web-new-error')).toContainText('Endpoint refused');
    expect((await channels()).some((c) => c.label === label)).toBe(false);

    await page.getByTestId('web-new-endpoint').fill(ECHO);
    await page.getByTestId('web-new-auth_header').fill('x-e2e-token');
    await expect(page.getByTestId('web-new-auth_token')).toHaveAttribute('type', 'password');
    await page.getByTestId('web-new-public_base').fill('https://httpbin.org/blog/');
    await page.getByTestId('web-new-author').fill('E2E Author');
    await page.getByTestId('web-new-save').click();

    let row: any;
    await expect.poll(async () => {
      row = (await channels()).find((c) => c.label === label);
      return row?.config?.endpoint;
    }, { timeout: 15_000 }).toBe(ECHO);
    created.push(row.channel);
    expect(row.config).toEqual({ endpoint: ECHO, auth_header: 'x-e2e-token', public_base: 'https://httpbin.org/blog/', author: 'E2E Author' });

    // Stored as ciphertext, never as plaintext.
    const secret = (await supaGet('user_integrations_v2', `user_id=eq.${USER}&provider=eq.website&channel=eq.${row.channel}&select=*`))[0];
    expect(secret.secret_ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(secret)).not.toContain(token);
    expect(secret.secret_last4).toBe('ZQ42');
    await expect(page.getByTestId(`web-token-status-${row.channel}`)).toContainText('ends ••••ZQ42');

    // Test: GET to the echo endpoint with the token in x-e2e-token. The echo's body (which contains
    // the token) must not come back to the browser.
    const testResponse = page.waitForResponse((r) => r.url().endsWith(`/api/integrations/websites/${row.channel}/test`));
    await page.getByTestId(`web-test-${row.channel}`).click();
    const body = await (await testResponse).text();
    expect(body).not.toContain(token);
    await expect(page.getByTestId(`web-test-result-${row.channel}`)).toContainText('Reachable (HTTP 200)');
    await expect(page.getByTestId(`web-test-result-${row.channel}`)).toContainText('x-e2e-token');

    // Edit: label + author; leaving the token blank keeps it.
    await page.getByTestId(`web-edit-${row.channel}`).click();
    await expect(page.getByTestId(`web-edit-${row.channel}-auth_token`)).toHaveValue('');
    await page.getByTestId(`web-edit-${row.channel}-label`).fill(`${label} edited`);
    await page.getByTestId(`web-edit-${row.channel}-author`).fill('');
    await page.getByTestId(`web-edit-${row.channel}-save`).click();
    await expect.poll(async () => (await channels()).find((c) => c.channel === row.channel)?.label, { timeout: 15_000 }).toBe(`${label} edited`);
    const edited = (await channels()).find((c) => c.channel === row.channel);
    expect(edited.config.author).toBeUndefined();
    const kept = (await supaGet('user_integrations_v2', `user_id=eq.${USER}&channel=eq.${row.channel}&select=secret_ciphertext`))[0];
    expect(kept.secret_ciphertext).toBe(secret.secret_ciphertext);

    // Remove: channel and its token both go.
    await page.getByTestId(`web-remove-${row.channel}`).click();
    await expect.poll(async () => (await channels()).some((c) => c.channel === row.channel), { timeout: 15_000 }).toBe(false);
    expect(await supaGet('user_integrations_v2', `user_id=eq.${USER}&channel=eq.${row.channel}&select=id`)).toEqual([]);
  });

  test('Website Test with no token saved shows the error', async ({ page }) => {
    const api = await apiClient();
    const res = await api.post('/api/integrations/websites', { data: { label: `E2E NoToken ${TAG}`, endpoint: ECHO } });
    expect(res.status(), await res.text()).toBe(201);
    const ch = (await res.json()).data.channel as string;
    created.push(ch);
    await api.dispose();
    await open(page);
    await expect(page.getByTestId(`web-token-status-${ch}`)).toHaveText('Not set');
    await page.getByTestId(`web-test-${ch}`).click();
    await expect(page.getByTestId(`web-row-error-${ch}`)).toContainText('No auth token is saved');
  });

  test('the table is not readable through PostgREST with the user\'s own token', async () => {
    test.skip(!SUPA_URL || !ANON, 'needs SUPABASE_URL + anon key');
    const token = await getToken();
    const r = await fetch(`${SUPA_URL}/rest/v1/user_integrations_v2?select=*`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    // REVOKE ALL → permission denied (401/403); either way, no rows.
    if (r.ok) expect(await r.json()).toEqual([]);
    else expect([401, 403]).toContain(r.status);
  });

  test('another user\'s channel cannot be changed through the API', async () => {
    const others = await supaGet('users_v2', `user_id=neq.${USER}&select=user_id&limit=1`);
    test.skip(!others.length, 'no second user on this database');
    const other = encodeURIComponent(others[0].user_id);
    const ch = `li_e2e_other_${TAG}`;
    const SUPA_SERVICE = process.env.E2E_SUPA_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const ins = await fetch(`${SUPA_URL}/rest/v1/social_channels_v2`, {
      method: 'POST',
      headers: { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: others[0].user_id, channel: ch, kind: 'linkedin', label: 'not yours', config: {} }),
    });
    expect(ins.status, await ins.text()).toBe(201);
    const api = await apiClient();
    try {
      expect((await api.patch(`/api/integrations/linkedin/${ch}`, { data: { label: 'hijacked' } })).status()).toBe(404);
      expect((await api.delete(`/api/integrations/linkedin/${ch}`)).status()).toBe(404);
      const list = await (await api.get('/api/integrations')).text();
      expect(list).not.toContain(ch);
      expect((await supaGet('social_channels_v2', `user_id=eq.${other}&channel=eq.${ch}&select=label`))[0]?.label).toBe('not yours');
    } finally {
      await api.dispose();
      await supaDelete('social_channels_v2', `user_id=eq.${other}&channel=eq.${ch}`);
    }
  });
});
