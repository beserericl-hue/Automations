import { test, expect } from '@playwright/test';
import { seedResearch, supaGet, deleteResearch } from '../pages/api';

/**
 * Research list + detail + delete — RESULT-asserting, data-isolated. Seeds a report, opens it, and deletes
 * it via the UI (soft-delete → deleted_at). Verified against research/{ResearchList,ResearchDetail}.tsx.
 */
test.describe('Research (result-asserting)', () => {
  let id = '';
  const TOPIC = `E2E Research ${Date.now()}`;
  test.beforeAll(async () => { id = await seedResearch(TOPIC); });
  test.afterAll(async () => { if (id) await deleteResearch(id); });

  test('open a report, then delete it (deleted_at set in DB)', async ({ page }) => {
    await page.goto('/research');
    const row = page.getByRole('button', { name: `Open research report ${TOPIC}` });
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Open → detail route renders the report.
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/research/${id}`), { timeout: 15_000 });
    await expect(page.getByText(TOPIC).first()).toBeVisible({ timeout: 15_000 });

    // Back to list, delete via the row's Delete → ConfirmDialog.
    await page.goto('/research');
    const row2 = page.locator('tr', { hasText: TOPIC }).first();
    await expect(row2).toBeVisible({ timeout: 15_000 });
    await row2.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect
      .poll(async () => (await supaGet('research_reports_v2', `id=eq.${id}&select=deleted_at`))[0]?.deleted_at,
        { timeout: 15_000, message: 'Delete did not set deleted_at on the research report' })
      .not.toBeNull();
  });
});
