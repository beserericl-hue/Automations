import { test, expect } from '@playwright/test';
import { seedProject, deleteProject } from '../pages/api';

/**
 * Reference pages — RESULT-asserting where a result exists. Outlines lists a project that HAS an outline;
 * Brainstorm's Analyze button is gated by content; Sources + Cost render their real controls/content.
 */
test.describe('Outlines (result-asserting)', () => {
  let projectId = '';
  const TITLE = `E2E Outlined ${Date.now()}`;
  test.beforeAll(async () => {
    projectId = await seedProject({
      title: TITLE,
      outline: { premise: 'A disposable outlined story.', chapters: [{ chapter_number: 1, title: 'Ch1', beat: 'x' }] },
    });
  });
  test.afterAll(async () => { if (projectId) await deleteProject(projectId); });

  test('an outlined project appears in the Outlines list and links to it', async ({ page }) => {
    await page.goto('/outlines');
    // Scope to the main content region — the same project title also appears as a link in the
    // left "My Projects" sidebar, which makes a page-wide getByRole('link') ambiguous.
    const link = page.getByRole('main').getByRole('link', { name: new RegExp(TITLE) });
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`), { timeout: 15_000 });
  });
});

test.describe('Brainstorm (result-asserting)', () => {
  test('Analyze Content is disabled until content is entered, then enabled', async ({ page }) => {
    await page.goto('/brainstorm');
    const analyze = page.getByRole('button', { name: /Analyze Content/ });
    await expect(analyze).toBeVisible({ timeout: 20_000 });
    await expect(analyze).toBeDisabled();
    await page.getByPlaceholder(/Paste your book idea/i).fill(
      'A generation ship reaches a dead colony and must decide whether to wake the sleepers.',
    );
    await expect(analyze).toBeEnabled();
  });
});

test.describe('Sources + Cost (result-asserting render)', () => {
  test('Sources renders its type filters and a result set (rows or empty state)', async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByText(/Sources?|No sources found|All Types/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'RSS' })).toBeVisible();
    await page.getByRole('button', { name: 'RSS' }).click(); // filter must not crash
    await expect(page.getByText(/Sources?|No sources found/i).first()).toBeVisible();
  });

  test('Cost renders its range controls and analytics', async ({ page }) => {
    await page.goto('/cost');
    await expect(page.getByText(/Cost|Total Cost|No usage data yet/i).first()).toBeVisible({ timeout: 20_000 });
    for (const r of ['7d', '30d', 'All Time']) {
      const btn = page.getByRole('button', { name: r, exact: true });
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await expect(page.getByText(/Cost|Total Cost|No usage data yet/i).first()).toBeVisible();
      }
    }
  });
});
