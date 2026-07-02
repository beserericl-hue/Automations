import { test, expect } from '@playwright/test';
import { seedProject, supaGet, deleteProject } from '../pages/api';

/**
 * Story Bible panel CRUD — RESULT-asserting, data-isolated. Add Entry writes a story_bible_v2 row; Delete
 * soft-deletes it. Verified against story-bible/{StoryBiblePanel,EntryForm}.tsx. Teardown deletes project.
 */
test.describe('Story Bible CRUD (result-asserting)', () => {
  let projectId = '';
  const NAME = `E2E Character ${Date.now()}`;
  test.beforeAll(async () => { projectId = await seedProject({ title: `E2E Bible ${Date.now()}` }); });
  test.afterAll(async () => { if (projectId) await deleteProject(projectId); });

  test('Add Entry writes a story_bible_v2 row; Delete soft-deletes it', async ({ page }) => {
    await page.goto(`/projects/${projectId}/bible`);
    await page.getByRole('button', { name: /Add (First )?Entry/ }).first().click();

    await page.getByPlaceholder('e.g., Marcus Chen').fill(NAME);
    await page.getByPlaceholder(/Detailed description/).fill('A disposable regression character.');
    await page.getByRole('button', { name: /^Add Entry$/ }).click();

    // Result: the row exists (not deleted) for this project.
    await expect
      .poll(async () => (await supaGet('story_bible_v2', `project_id=eq.${projectId}&name=eq.${encodeURIComponent(NAME)}&deleted_at=is.null&select=id`)).length,
        { timeout: 15_000, message: 'story bible entry was not written to story_bible_v2' })
      .toBe(1);
    await expect(page.getByText(NAME).first()).toBeVisible({ timeout: 10_000 });

    // Delete via the UI (confirm dialog) → soft-delete.
    const entry = page.getByText(NAME).first();
    await entry.scrollIntoViewIfNeeded();
    // The entry's row exposes a Delete button; open the confirm and accept.
    await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect
      .poll(async () => (await supaGet('story_bible_v2', `project_id=eq.${projectId}&name=eq.${encodeURIComponent(NAME)}&deleted_at=is.null&select=id`)).length,
        { timeout: 15_000, message: 'story bible entry was not soft-deleted' })
      .toBe(0);
  });
});
