import { test, expect } from '@playwright/test';
import { seedContent, getContent, deleteContent } from '../pages/api';

/**
 * Content Library bulk actions — RESULT-asserting, data-isolated. Seeds two disposable draft rows, selects
 * them in the UI, runs Bulk Approve, and asserts BOTH rows flip to 'approved' in the DB. Teardown deletes.
 * Verified against components/content/ContentLibrary.tsx (bulk approve → status update).
 */
let idA = '';
let idB = '';
const tagA = `E2E Bulk A ${Date.now()}`;
const tagB = `E2E Bulk B ${Date.now()}`;

test.describe('Content Library bulk actions (result-asserting)', () => {
  test.beforeAll(async () => {
    idA = await seedContent({ title: tagA, content_type: 'blog_post', status: 'draft' });
    idB = await seedContent({ title: tagB, content_type: 'blog_post', status: 'draft' });
  });
  test.afterAll(async () => {
    if (idA) await deleteContent(idA);
    if (idB) await deleteContent(idB);
  });

  test('bulk Approve flips both selected rows to approved in the DB', async ({ page }) => {
    await page.goto('/library');
    // Newest rows (my two) sort to the top; wait for the table to settle.
    await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 20_000 });

    for (const tag of [tagA, tagB]) {
      const row = page.locator('tr', { hasText: tag }).first();
      await expect(row, `seeded row "${tag}" must be listed`).toBeVisible({ timeout: 15_000 });
      await row.getByRole('checkbox').check();
    }

    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeVisible({ timeout: 10_000 });
    await approve.click();

    for (const id of [idA, idB]) {
      await expect
        .poll(async () => (await getContent(id, 'status'))?.status,
          { timeout: 20_000, message: `bulk approve did not set ${id} to approved` })
        .toBe('approved');
    }
  });
});
