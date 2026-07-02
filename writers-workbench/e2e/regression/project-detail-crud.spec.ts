import { test, expect } from '@playwright/test';
import { seedProject, supaGet, deleteProject } from '../pages/api';

/**
 * ProjectDetail Edit + Delete — RESULT-asserting, data-isolated. Edit Save persists the new title to
 * writing_projects_v2; Delete Project soft-deletes (deleted_at set) and navigates away. Verified against
 * ProjectDetail + ProjectEditForm.
 */
test.describe('ProjectDetail Edit + Delete (result-asserting)', () => {
  let projectId = '';
  test.beforeEach(async () => { projectId = await seedProject({ title: `E2E PD ${Date.now()}` }); });
  test.afterEach(async () => { if (projectId) await deleteProject(projectId); });

  test('Edit form Save persists the new title to writing_projects_v2', async ({ page }) => {
    const newTitle = `E2E PD Renamed ${Date.now()}`;
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const titleInput = page.getByPlaceholder('Project title');
    await expect(titleInput).toBeVisible({ timeout: 10_000 });
    await titleInput.fill(newTitle);
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect
      .poll(async () => (await supaGet('writing_projects_v2', `id=eq.${projectId}&select=title`))[0]?.title,
        { timeout: 15_000, message: 'Edit Save did not persist the new title' })
      .toBe(newTitle);
  });

  test('Delete Project soft-deletes the row and navigates to /projects', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: 'Delete Project' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: /Delete Project/i }).click();

    await expect(page).toHaveURL(/\/projects\/?$/, { timeout: 15_000 });
    await expect
      .poll(async () => (await supaGet('writing_projects_v2', `id=eq.${projectId}&select=deleted_at`))[0]?.deleted_at,
        { timeout: 15_000, message: 'Delete Project did not set deleted_at' })
      .not.toBeNull();
  });
});
