import { test, expect } from '@playwright/test';
import { supaGet, eqUser } from '../pages/api';

/**
 * Dashboard + ProjectList — RESULT-asserting. The StatCards must show counts that match the DB, and the
 * project rows must navigate. Verified against components/dashboard/Dashboard.tsx + projects/ProjectList.
 */
test.describe('Dashboard (result-asserting)', () => {
  test('StatCards reflect real DB counts', async ({ page }) => {
    // Ground truth from the DB.
    const projects = await supaGet('writing_projects_v2', `${eqUser()}&deleted_at=is.null&select=id`);
    const research = await supaGet('research_reports_v2', `${eqUser()}&deleted_at=is.null&select=id`);

    await page.goto('/');
    await expect(page.getByText(/Welcome back|Recent Activity/i).first()).toBeVisible({ timeout: 20_000 });

    // The Projects and Research stat cards should render numbers matching the DB (allow the card to settle).
    // StatCard: <div card><div header><p>LABEL</p><icon></div><p class=text-3xl>VALUE</p></div>.
    // The VALUE p is the sibling of the header div — reach it from the label p via ../following-sibling::p.
    const cardValue = (label: string) =>
      page.locator('main').getByText(label, { exact: true }).first().locator('xpath=../following-sibling::p');
    const readCount = async (label: string) => {
      const t = (await cardValue(label).textContent().catch(() => '')) ?? '';
      const m = t.match(/(\d+)/);
      return m ? Number(m[1]) : -1;
    };
    await expect.poll(() => readCount('Projects'),
      { timeout: 15_000, message: 'Projects StatCard count never matched the DB' }).toBe(projects.length);
    await expect.poll(() => readCount('Research'),
      { timeout: 15_000, message: 'Research StatCard count never matched the DB' }).toBe(research.length);
  });

  test('a project row opens its detail page', async ({ page }) => {
    await page.goto('/projects');
    const row = page.getByRole('button', { name: /^Open project / }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{8,}/, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible({ timeout: 15_000 });
  });
});
