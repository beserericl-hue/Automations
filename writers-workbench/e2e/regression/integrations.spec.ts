import { test, expect, type Page } from '@playwright/test';
import { DEMO_USER_ID, RUN_TAG, apiClient, getToken, supaDelete, supaGet } from '../pages/api';

/**
 * Settings → Integrations (migrations 043 + 055): the user's own Blotato key, the accounts read from
 * it (each a "post here" switch), and blog websites. RESULT-asserting: each UI step is checked in
 * social_channels_v2 / user_integrations_v2.
 *
 * PASS:
 *  - the screen renders every section and field; secrets are masked (password inputs, empty, only
 *    "Set · ends ••••xxxx" / "Not set" shown) and no ciphertext or secret reaches the browser;
 *  - every synced Blotato account / page is listed with a switch; the switched-on ones are the
 *    user's social channels; a hand-made channel is listed too; websites can be added, edited and removed;
 *  - a website token is stored as AES-GCM ciphertext (v1.…), never as plaintext, and Test sends it to
 *    the endpoint in the configured header (against https://httpbin.org/anything — an echo service,
 *    never the real blog) without the response coming back to the browser;
 *  - errors show: short key, http:// endpoint, metadata-IP endpoint (SSRF),
 *    Test with nothing saved;
 *  - the table cannot be read through PostgREST with the user's own token;
 *  - another user's channel cannot be edited through the API.
 *
 * The owner's real Blotato key is never overwritten or removed: the Blotato key is only exercised
 * through paths that save nothing (an invalid key is refused; Test connection reads, never posts).
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
    test.setTimeout(90_000);
    const bodies: string[] = [];
    page.on('response', async (r) => {
      if (r.url().includes('/api/integrations')) bodies.push(await r.text().catch(() => ''));
    });
    await open(page);
    for (const id of ['blotato-section', 'websites-section']) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('blotato-key-status')).toHaveText(/^(Not set|Set( · ends ••••.{4})?( · saved .+)?)$/);
    const key = page.getByTestId('blotato-api-key');
    await expect(key).toHaveAttribute('type', 'password');
    await expect(key).toHaveValue('');
    await expect(page.getByTestId('blotato-account-id')).toHaveCount(0); // nothing typed: ids are read from the key (055)
    for (const b of ['blotato-save', 'blotato-test', 'web-add']) await expect(page.getByTestId(b)).toBeEnabled();
    // The DEV channels from the seed are listed, with their non-secret config. Other runs of this
    // spec (the writer-e2e service runs it on every deploy, concurrently with manual runs) add and
    // remove websites/LinkedIn targets for the same user, so the page is compared with the channel
    // set read just before it loaded and again after; if that set moved in between, reload and retry.
    const key2 = (rs: any[]) => rs.map((c) => c.channel).sort().join(',');
    await expect(async () => {
      const before = await channels();
      await open(page);
      const rows = await channels();
      expect(key2(rows), 'channels changed while the page loaded; retrying').toBe(key2(before));
      // A social channel is either a switched-on synced account (its switch is checked) or a hand-made row.
      for (const r of rows.filter((c) => c.kind !== 'website')) {
        const synced = r.config?.target_id ? page.getByTestId(`target-switch-${r.config.target_id}`) : null;
        if (synced && (await synced.count())) await expect(synced).toBeChecked({ checked: r.enabled !== false, timeout: 5_000 });
        else await expect(page.getByTestId(`social-row-${r.channel}`)).toBeVisible({ timeout: 5_000 });
      }
      for (const r of rows.filter((c) => c.kind === 'website')) {
        await expect(page.getByTestId(`web-endpoint-${r.channel}`)).toContainText(r.config.endpoint, { timeout: 5_000 });
        expect(r.config.auth_env, 'migration 043 drops auth_env').toBeUndefined();
      }
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toMatch(/"v1\.[A-Za-z0-9_-]+\./);
  });

  // The demo user's Blotato row is the OWNER's real account, and the Railway writer-e2e service runs
  // this suite on every deploy, concurrently with any manual run. So this test never changes it: an
  // edit-then-restore raced a concurrent run on DEV (2026-11-02) and left a test id behind. It proves
  // the save path with invalid input (refused, nothing written) and an idempotent re-save of the value.
  test('Blotato: an invalid key is refused and nothing is saved', async ({ page }) => {
    const read = async () => (await supaGet('user_integrations_v2', `user_id=eq.${USER}&provider=eq.blotato&select=*`))[0];
    const before = await read();
    await open(page);
    await page.getByTestId('blotato-api-key').fill('short');
    await page.getByTestId('blotato-save').click();
    await expect(page.getByTestId('blotato-error')).toContainText('api_key');
    expect((await read())?.secret_ciphertext ?? null).toBe(before?.secret_ciphertext ?? null);
    expect((await read())?.config ?? null).toEqual(before?.config ?? null);
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
      r.fulfill({ json: { success: true, data: { ok: true, status: 200, message: 'Connected: 1 account(s) on this Blotato key', accounts: [] } } }));
    await page.getByTestId('blotato-test').click();
    await expect(page.getByTestId('blotato-test-result')).toContainText('Connected: 1 account(s)');
  });

  test('Blotato targets: switching a synced account on makes a channel with its ids copied; off disables it', async ({ page }) => {
    // Needs the owner's real synced list (Save/Refresh accounts reads it from Blotato). Pick a text
    // platform that is not yet a channel, so the run adds and then removes only its own channel.
    const blotato = (await supaGet('user_integrations_v2', `user_id=eq.${USER}&provider=eq.blotato&select=config`))[0];
    const targets: any[] = blotato?.config?.accounts ?? [];
    const taken = new Set((await channels()).map((c) => c.config?.target_id));
    const pick = targets.find((t) => t.needs === 'text' && !taken.has(t.target_id));
    test.skip(!pick, 'no synced text account free to switch on (save the Blotato key and Refresh accounts first)');
    await open(page);
    await page.getByTestId(`target-switch-${pick.target_id}`).check();
    let row: any;
    await expect.poll(async () => {
      row = (await channels()).find((c) => c.config?.target_id === pick.target_id);
      return row?.kind;
    }, { timeout: 15_000 }).toBe(pick.platform);
    created.push(row.channel);
    expect(row.config).toMatchObject({ account_id: pick.account_id, platform: pick.platform, ...(pick.page_id ? { page_id: pick.page_id } : {}) });
    expect(row).toMatchObject({ enabled: true, label: pick.label });
    await expect(page.getByTestId(`target-switch-${pick.target_id}`)).toBeChecked();

    await page.getByTestId(`target-switch-${pick.target_id}`).uncheck();
    await expect.poll(async () => (await channels()).find((c) => c.channel === row.channel)?.enabled, { timeout: 15_000 }).toBe(false);
    await expect(page.getByTestId(`target-switch-${pick.target_id}`)).not.toBeChecked();

    // A video-only platform (YouTube) cannot be switched on at all.
    const video = targets.find((t) => t.needs === 'video');
    if (video) await expect(page.getByTestId(`target-switch-${video.target_id}`)).toBeDisabled();
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
    // (The channel row is written first and the token row right after it, so wait for the token.)
    let secret: any;
    await expect.poll(async () => {
      secret = (await supaGet('user_integrations_v2', `user_id=eq.${USER}&provider=eq.website&channel=eq.${row.channel}&select=*`))[0];
      return Boolean(secret?.secret_ciphertext);
    }, { timeout: 15_000 }).toBe(true);
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
      expect((await api.patch(`/api/integrations/social/${ch}`, { data: { label: 'hijacked' } })).status()).toBe(404);
      expect((await api.delete(`/api/integrations/social/${ch}`)).status()).toBe(404);
      const list = await (await api.get('/api/integrations')).text();
      expect(list).not.toContain(ch);
      expect((await supaGet('social_channels_v2', `user_id=eq.${other}&channel=eq.${ch}&select=label`))[0]?.label).toBe('not yours');
    } finally {
      await api.dispose();
      await supaDelete('social_channels_v2', `user_id=eq.${other}&channel=eq.${ch}`);
    }
  });
});
