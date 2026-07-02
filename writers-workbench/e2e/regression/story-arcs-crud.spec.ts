import { test, expect } from '@playwright/test';
import { supaGet, supaDelete } from '../pages/api';

/**
 * Story Arcs CRUD — RESULT-asserting, data-isolated.
 *
 * Creates a custom arc via the UI form and asserts the story_arcs_v2 row actually exists; then deletes it
 * via the UI (hard delete) and asserts the row is gone. Teardown removes any leftover by name.
 * Verified against components/story-arcs/{StoryArcBrowser,StoryArcForm}.tsx.
 */
const ARC_NAME = `E2E Arc ${Date.now()}`;

test.describe('Story Arcs CRUD (result-asserting)', () => {
  test.afterAll(async () => {
    await supaDelete('story_arcs_v2', `name=eq.${encodeURIComponent(ARC_NAME)}`);
  });

  test('create writes a story_arcs_v2 row; delete removes it', async ({ page }) => {
    await page.goto('/story-arcs');
    await expect(page.getByText(/arcs? available|Story Arc/i).first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: /Create Custom Arc|Create Your First Arc/ }).first().click();
    await page.getByPlaceholder('e.g., Five-Act Tragedy').fill(ARC_NAME);
    await page.getByPlaceholder(/Brief description/).fill('A disposable regression arc.');
    await page.getByPlaceholder(/prompt template/i).fill('Structure the story in five disposable beats: [beat1]…[beat5].');
    await page.getByRole('button', { name: /Create Arc/ }).click();

    // DB result: the row exists.
    await expect
      .poll(async () => (await supaGet('story_arcs_v2', `name=eq.${encodeURIComponent(ARC_NAME)}&select=id`)).length,
        { timeout: 15_000, message: 'story arc was not written to story_arcs_v2' })
      .toBe(1);
    // UI result: the arc appears in the browser.
    await expect(page.getByText(ARC_NAME).first()).toBeVisible({ timeout: 10_000 });

    // Delete via the UI (custom arcs are hard-deleted) and assert the row is gone.
    await page.getByText(ARC_NAME).first().click(); // expand the card → reveals Edit/Delete
    const del = page.getByRole('button', { name: 'Delete', exact: true }).first();
    await expect(del).toBeVisible({ timeout: 10_000 });
    await del.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect
      .poll(async () => (await supaGet('story_arcs_v2', `name=eq.${encodeURIComponent(ARC_NAME)}&select=id`)).length,
        { timeout: 15_000, message: 'story arc row was not deleted' })
      .toBe(0);
  });
});
