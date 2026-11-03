import { test, expect, type Page } from '@playwright/test';
import { supaGet, eqUser, RUN_TAG, seedProject, deleteProject, seedResearch, deleteResearch } from '../pages/api';

/**
 * Dashboard + ProjectList — RESULT-asserting. The StatCards and the sidebar's My Projects badge must
 * show counts that match the DB, and the project rows must navigate. Verified against
 * components/dashboard/Dashboard.tsx, layout/Sidebar.tsx and projects/ProjectList.
 *
 * Self-sufficient and safe beside concurrent specs: it adds its own project and research report (so
 * the counts must move to include them), and compares each screen read against DB counts taken
 * immediately before AND after it. Other specs in the same pass create and delete projects, content
 * and research for this user; when the DB changes during a read the attempt is repeated, so a match
 * is always "the screen equals the DB at that moment", never a stale snapshot.
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);

type Counts = { projects: number; drafts: number; published: number; research: number };

async function dbCounts(): Promise<Counts> {
  const [projects, drafts, published, research] = await Promise.all([
    supaGet('writing_projects_v2', `${eqUser()}&deleted_at=is.null&select=id`),
    supaGet('published_content_v2', `${eqUser()}&status=eq.draft&deleted_at=is.null&select=id`),
    supaGet('published_content_v2', `${eqUser()}&status=eq.published&deleted_at=is.null&select=id`),
    supaGet('research_reports_v2', `${eqUser()}&deleted_at=is.null&select=id`),
  ]);
  return { projects: projects.length, drafts: drafts.length, published: published.length, research: research.length };
}

/** StatCard: <div card><div header><p>LABEL</p><icon></div><p class=text-3xl>VALUE</p></div>. */
async function uiCounts(page: Page): Promise<Counts> {
  const value = (label: string) =>
    page.locator('main').getByText(label, { exact: true }).first().locator('xpath=../following-sibling::p');
  // Wait until every card holds a number (not the '...' loading or '!' error placeholder).
  for (const label of ['Projects', 'Drafts', 'Published', 'Research']) {
    await expect(value(label)).toHaveText(/^\d+$/, { timeout: 20_000 });
  }
  const n = async (label: string) => Number((await value(label).textContent())?.trim());
  return { projects: await n('Projects'), drafts: await n('Drafts'), published: await n('Published'), research: await n('Research') };
}

async function sidebarProjectCount(page: Page): Promise<number> {
  const header = page.locator('aside').getByRole('button', { name: /My Projects/ });
  await expect(header).toHaveText(/My Projects\s*\d+/, { timeout: 20_000 });
  return Number(((await header.textContent()) ?? '').match(/(\d+)/)?.[1] ?? -1);
}

test.describe('Dashboard (result-asserting)', () => {
  test.describe('counts', () => {
    test.skip(!HAS_KEY, 'requires service key');
    let projectId = '';
    let researchId = '';
    test.beforeAll(async () => {
      projectId = await seedProject({ title: `E2E Dash ${RUN_TAG}` });
      researchId = await seedResearch(`E2E Dash ${RUN_TAG}`);
    });
    test.afterAll(async () => {
      if (projectId) await deleteProject(projectId);
      if (researchId) await deleteResearch(researchId);
    });

    test('StatCards and the My Projects badge reflect real DB counts', async ({ page }) => {
      test.setTimeout(120_000);
      // The fixtures are live rows of this user, so the DB counts below include them.
      expect((await supaGet('writing_projects_v2', `id=eq.${projectId}&deleted_at=is.null&select=id`)).length).toBe(1);
      expect((await supaGet('research_reports_v2', `id=eq.${researchId}&deleted_at=is.null&select=id`)).length).toBe(1);

      let last = '';
      await expect(async () => {
        const before = await dbCounts();
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(/Welcome back|Recent Activity/i).first()).toBeVisible({ timeout: 20_000 });
        const ui = await uiCounts(page);
        const sidebar = await sidebarProjectCount(page);
        const after = await dbCounts();
        last = JSON.stringify({ before, ui, sidebar, after });
        // Another spec changed this user's rows during the read: not a comparison, try again.
        expect(after, `DB changed during the read; retrying. ${last}`).toEqual(before);
        expect(ui, `StatCards do not match the DB. ${last}`).toEqual(after);
        expect(sidebar, `My Projects badge does not match the DB project count. ${last}`).toBe(after.projects);
      }).toPass({ timeout: 100_000, intervals: [2_000, 3_000, 5_000] });
    });
  });

  // Opens a row for a project of its own. It clicked the first row, which is the most recently
  // updated project: during Pass A that is another spec's disposable fixture, and when that spec's
  // teardown deleted it between the list render and the click, the detail page said "Project not found".
  test.describe('project row', () => {
    test.skip(!HAS_KEY, 'requires service key');
    let projectId = '';
    const title = `E2E Dash Row ${RUN_TAG}`;
    test.beforeAll(async () => { projectId = await seedProject({ title }); });
    test.afterAll(async () => { if (projectId) await deleteProject(projectId); });

    test('a project row opens its detail page', async ({ page }) => {
      await page.goto('/projects');
      const row = page.getByRole('button', { name: `Open project ${title}`, exact: true });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}(\\?|$)`), { timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    });
  });
});
