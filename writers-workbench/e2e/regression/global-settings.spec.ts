import { test, expect } from '@playwright/test';
import { apiClient, supaGet, supaDelete, supaInsert, DEMO_USER_ID, RUN_TAG } from '../pages/api';

/**
 * Global settings (item 8, migration 045) — RESULT-asserting. A setting saved in the global table
 * reaches a user with no value of their own; the user's own value in app_config_v2 wins over it;
 * removing both falls back to nothing. Every step is checked in the database, not just on screen.
 * Each test uses its own disposable key and removes it, so nothing real is touched.
 */
const GLOBAL = 'app_config_global_v2';
const USER = 'app_config_v2';

test.describe('Global settings (result-asserting)', () => {
  test('resolution is user -> global -> default, end to end through the admin API', async () => {
    const key = `e2e_global_${RUN_TAG}`;
    const api = await apiClient();
    try {
      // 1. Global value saved through the API lands in the global table.
      const put = await api.put(`/api/admin/global-config/${key}`, { data: { value: 'from-global', description: 'E2E probe' } });
      expect(put.status(), await put.text()).toBe(200);
      const [row] = await supaGet(GLOBAL, `key=eq.${key}&select=key,value,description,updated_by`);
      expect(row).toMatchObject({ key, value: 'from-global', description: 'E2E probe' });
      expect(row.updated_by).toBeTruthy();

      // 2. A user with no value of their own inherits it.
      const resolve = async () => {
        const r = await api.get(`/api/admin/global-config/resolve?keys=${key}&user_id=${encodeURIComponent(DEMO_USER_ID)}`);
        expect(r.status()).toBe(200);
        return (await r.json()).data[key];
      };
      expect(await resolve()).toEqual({ value: 'from-global', source: 'global' });

      // 3. The user's own value wins.
      await supaInsert(USER, { user_id: DEMO_USER_ID, key, value: 'from-user' });
      expect(await resolve()).toEqual({ value: 'from-user', source: 'user' });

      // 4. Remove both: nothing resolves.
      await supaDelete(USER, `key=eq.${key}`);
      const del = await api.delete(`/api/admin/global-config/${key}`);
      expect((await del.json()).data.deleted).toBe(true);
      expect(await supaGet(GLOBAL, `key=eq.${key}`)).toHaveLength(0);
      expect(await resolve()).toEqual({ value: null, source: null });
    } finally {
      await supaDelete(USER, `key=eq.${key}`);
      await supaDelete(GLOBAL, `key=eq.${key}`);
      await api.dispose();
    }
  });

  test('a secret is stored in full but never returned in full', async () => {
    const key = `e2e_secret_${RUN_TAG}`;
    const api = await apiClient();
    try {
      const put = await api.put(`/api/admin/global-config/${key}`, { data: { value: 'sk-e2e-0123456789', is_secret: true } });
      expect(put.status()).toBe(200);
      expect((await put.json()).data.value).toBe('••••6789');
      const list = (await (await api.get('/api/admin/global-config')).json()).data as any[];
      expect(list.find((r) => r.key === key)).toMatchObject({ value: '••••6789', masked: true });
      const [row] = await supaGet(GLOBAL, `key=eq.${key}&select=value,is_secret`);
      expect(row).toEqual({ value: 'sk-e2e-0123456789', is_secret: true });
    } finally {
      await supaDelete(GLOBAL, `key=eq.${key}`);
      await api.dispose();
    }
  });

  test('a bad key is refused', async () => {
    const api = await apiClient();
    const r = await api.put('/api/admin/global-config/bad%20key', { data: { value: 'x' } });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test('the Global Settings tab adds and deletes a setting, and the database follows', async ({ page }) => {
    const key = `e2e_ui_${RUN_TAG}`;
    try {
      await page.goto('/admin', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Global Settings' }).click();
      await expect(page.getByTestId('global-settings')).toBeVisible({ timeout: 20_000 });

      const form = page.getByTestId('global-settings-add');
      const inputs = form.locator('input:not([type=checkbox])');
      await inputs.nth(0).fill(key);
      await inputs.nth(1).fill('ui-value');
      await inputs.nth(2).fill('added by E2E');
      await form.getByRole('button', { name: 'Add setting' }).click();
      await expect(page.getByTestId(`global-setting-${key}`)).toContainText('ui-value', { timeout: 15_000 });
      await expect.poll(async () => (await supaGet(GLOBAL, `key=eq.${key}&select=value`))[0]?.value).toBe('ui-value');

      // Edit in place.
      const row = page.getByTestId(`global-setting-${key}`);
      await row.getByRole('button', { name: 'Edit' }).click();
      await page.getByLabel(`Value for ${key}`).fill('ui-value-2');
      await row.getByRole('button', { name: 'Save' }).click();
      await expect.poll(async () => (await supaGet(GLOBAL, `key=eq.${key}&select=value`))[0]?.value).toBe('ui-value-2');

      page.once('dialog', (d) => d.accept());
      await page.getByTestId(`global-setting-${key}`).getByRole('button', { name: 'Delete' }).click();
      await expect(page.getByTestId(`global-setting-${key}`)).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(async () => (await supaGet(GLOBAL, `key=eq.${key}`)).length).toBe(0);
    } finally {
      await supaDelete(GLOBAL, `key=eq.${key}`);
    }
  });
});
