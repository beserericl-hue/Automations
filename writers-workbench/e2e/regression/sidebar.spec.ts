import { test, expect } from '@playwright/test';
import { seedProject, deleteProject } from '../pages/api';

/**
 * Sidebar (client/src/components/layout/Sidebar.tsx) — RESULT-asserting.
 *
 * Covers every interactive element of the sidebar chrome:
 *   - Collapse/Expand toggle changes the sidebar width (w-56 ↔ w-14) AND hides/shows the labels
 *   - Each expandable section header (My Projects / Newsletter / Reference) toggles its child links
 *   - A per-project sub-link navigates to /projects/:id (seeded project, URL asserted)
 *   - EveOrb "Talk to Eve" Close button hides the widget (the mount is covered by eve-voice-widget.spec.ts)
 *
 * Runs against DEV (E2E_BASE_URL) with the shared authenticated session.
 */

test.describe('Sidebar (result-asserting)', () => {
  test('Collapse/Expand toggle changes width and hides/shows labels', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside').first();
    await sidebar.waitFor({ state: 'visible', timeout: 20_000 });

    // Expanded on desktop: width class w-56 and text labels visible.
    await expect(sidebar).toHaveClass(/w-56/);
    const dashboardLabel = sidebar.getByText('Dashboard', { exact: true });
    await expect(dashboardLabel).toBeVisible();

    // Collapse.
    await sidebar.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(sidebar).toHaveClass(/w-14/, { timeout: 5_000 });
    await expect(sidebar).not.toHaveClass(/w-56/);
    // Labels are removed from the DOM when collapsed (open && <span>label</span>).
    await expect(dashboardLabel).toBeHidden({ timeout: 5_000 });

    // Expand again.
    await sidebar.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(sidebar).toHaveClass(/w-56/, { timeout: 5_000 });
    await expect(sidebar.getByText('Dashboard', { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test('My Projects section header toggles its child links', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside').first();
    await sidebar.waitFor({ state: 'visible', timeout: 20_000 });

    // My Projects starts expanded (projectsExpanded default true) → "All Projects" child link visible.
    const allProjects = sidebar.getByRole('link', { name: 'All Projects', exact: true });
    const header = sidebar.getByRole('button', { name: /My Projects/ });
    await expect(allProjects).toBeVisible({ timeout: 10_000 });

    // Collapse it → child hidden.
    await header.click();
    await expect(allProjects).toBeHidden({ timeout: 5_000 });

    // Expand it → child back.
    await header.click();
    await expect(allProjects).toBeVisible({ timeout: 5_000 });
  });

  test('Reference section header expands to reveal its children', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside').first();
    await sidebar.waitFor({ state: 'visible', timeout: 20_000 });

    const genres = sidebar.getByRole('link', { name: 'Genres', exact: true });
    const header = sidebar.getByRole('button', { name: /Reference/ });
    // Reference starts collapsed (referenceExpanded default false).
    await expect(genres).toBeHidden();
    await header.click();
    await expect(genres).toBeVisible({ timeout: 5_000 });
    await expect(sidebar.getByRole('link', { name: 'Story Arcs', exact: true })).toBeVisible();
    // Collapse again.
    await header.click();
    await expect(genres).toBeHidden({ timeout: 5_000 });
  });

  test('Newsletter section header expands to reveal its children', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside').first();
    await sidebar.waitFor({ state: 'visible', timeout: 20_000 });

    const generate = sidebar.getByRole('link', { name: 'Generate', exact: true });
    const header = sidebar.getByRole('button', { name: /Newsletter/ });
    await expect(generate).toBeHidden();
    await header.click();
    await expect(generate).toBeVisible({ timeout: 5_000 });
    await expect(sidebar.getByRole('link', { name: 'Templates', exact: true })).toBeVisible();
    // Collapse again.
    await header.click();
    await expect(generate).toBeHidden({ timeout: 5_000 });
  });

  test('a per-project sub-link navigates to /projects/:id', async ({ page }) => {
    const title = `E2E Sidebar Project ${Date.now()}`;
    const projectId = await seedProject({ title });
    try {
      await page.goto('/');
      const sidebar = page.locator('aside').first();
      await sidebar.waitFor({ state: 'visible', timeout: 20_000 });

      // My Projects is expanded by default. The seeded project (most-recently updated) shows as a sub-link.
      const link = sidebar.getByRole('link', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
      await expect(link.first()).toBeVisible({ timeout: 15_000 });
      await link.first().click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`), { timeout: 15_000 });
    } finally {
      await deleteProject(projectId);
    }
  });

  test('EveOrb "Talk to Eve" Close button hides the widget', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside').first();
    await sidebar.waitFor({ state: 'visible', timeout: 20_000 });

    const talk = sidebar.getByRole('button', { name: 'Talk to Eve' });
    await talk.click();
    const dialog = page.getByRole('dialog', { name: /Eve voice assistant/i });
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    await dialog.getByRole('button', { name: /Close Eve voice widget/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  });
});
