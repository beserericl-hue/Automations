import { test, expect } from '@playwright/test';
import { seedTrashedProject, projectDeletedAt, deleteProject } from '../pages/api';

test.describe.configure({ mode: 'serial' });

/**
 * TrashView (/trash) — RESULT-asserting, data-isolated.
 *
 * Seeds a project with deleted_at set (so it lands in Trash), then drives Restore → ConfirmDialog
 * → confirm and proves writing_projects_v2.deleted_at is cleared in the DB. Teardown hard-deletes
 * the disposable project.
 */
const STAMP = Date.now();
let projectId = '';
const title = `E2E Trash ${STAMP}`;

test.describe('Trash restore (result-asserting)', () => {
  test.beforeAll(async () => {
    projectId = await seedTrashedProject(title);
    // Sanity: it is actually soft-deleted before we start.
    expect(await projectDeletedAt(projectId)).toBeTruthy();
  });

  test.afterAll(async () => {
    if (projectId) await deleteProject(projectId).catch(() => {});
  });

  test('Restore → confirm clears deleted_at in the DB', async ({ page }) => {
    await page.goto('/trash');
    await expect(page.getByRole('heading', { name: /^Trash$/ })).toBeVisible({ timeout: 20_000 });

    // Our soft-deleted project is listed.
    const card = page.locator('div', { hasText: title }).filter({ has: page.getByRole('button', { name: /^Restore$/ }) }).first();
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 });

    // Click the row's Restore → a ConfirmDialog appears.
    await card.getByRole('button', { name: /^Restore$/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByText(/Restore Project/i)).toBeVisible();

    // Confirm the restore.
    await dialog.getByRole('button', { name: /^Restore$/ }).click();

    // DB result: deleted_at is cleared.
    await expect
      .poll(async () => await projectDeletedAt(projectId),
        { timeout: 15_000, message: 'Restore did not clear writing_projects_v2.deleted_at' })
      .toBeNull();
  });
});
