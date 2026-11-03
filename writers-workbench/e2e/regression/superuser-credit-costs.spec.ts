import { test, expect } from '@playwright/test';
import { apiClient } from '../pages/api';

/**
 * Superuser → System Config → credit costs — RESULT-asserting, against DEV (the E2E user is a
 * superuser). Light: reads, and a save that changes no price.
 *
 * PASS: the panel shows an input for EVERY key the server's credit table has (not the old fixed 8),
 * including the ones priced on 2026-11-03 (Q/A, repair, humanize per 100 words); a negative or
 * fractional value blocks Save; the server refuses an unknown key and a negative price; saving the
 * table unchanged reports that no price changed (so this spec never alters DEV pricing).
 */
test.describe('Superuser credit costs panel', () => {
  test('lists every credit key, validates, and saves', async ({ page }) => {
    const api = await apiClient();
    const cfg = await (await api.get('/api/superuser/config')).json();
    const catalog = cfg.data.credit_cost_catalog as Array<{ key: string; default: number; unit?: string }>;
    expect(catalog.length).toBeGreaterThan(8);
    for (const k of ['qa_chapter', 'repair_chapter', 'humanize_passage', 'chat_generic', 'brainstorm_story']) {
      expect(catalog.map((c) => c.key)).toContain(k);
    }
    expect(Object.keys(cfg.data.credit_costs).sort()).toEqual(catalog.map((c) => c.key).sort());

    // The server is the last line: unknown keys and negatives are refused.
    expect((await api.put('/api/superuser/config', { data: { credit_costs: { not_a_key: 1 } } })).status()).toBe(400);
    expect((await api.put('/api/superuser/config', { data: { credit_costs: { qa_chapter: -1 } } })).status()).toBe(400);
    await api.dispose();

    await page.goto('/superuser', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'System Config' }).click();
    await expect(page.getByTestId('credit-costs')).toBeVisible({ timeout: 20_000 });
    for (const c of catalog) {
      await expect(page.getByTestId(`cost-${c.key}`)).toHaveValue(String(cfg.data.credit_costs[c.key]));
    }
    await expect(page.getByText(/humanize_passage, per 100 words/)).toBeVisible();

    const qa = page.getByTestId('cost-qa_chapter');
    const original = await qa.inputValue();
    await qa.fill('-3');
    await expect(page.getByRole('button', { name: 'Save Configuration' })).toBeDisabled();
    await qa.fill('2.5');
    await expect(page.getByRole('button', { name: 'Save Configuration' })).toBeDisabled();
    await qa.fill(original);
    await page.getByRole('button', { name: 'Save Configuration' }).click();
    await expect(page.getByRole('status')).toContainText('no price changed', { timeout: 15_000 });
  });
});
