import { test, expect } from '@playwright/test';
import { supaGet } from '../pages/api';

/**
 * CR-001 W9 — what the ENGINE wrote, read back on screen. The other specs check that the engine
 * persists rows, or that the UI renders rows the test inserted; this one opens a project the engine
 * wrote end to end (The Ossuary: outline, 96 chapters, story bible, chapter research) and checks that
 * each artifact the database holds is the one the screen shows.
 *
 * PASS: for each tab, a value read from the DB for this project is visible in that tab.
 */
const PROJECT_ID = 'a1bfb2cf-2949-4d29-80d2-e8b785c6bdae';
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);

test.describe('Engine-written project renders (CR-001 W9)', () => {
  test.skip(!HAS_KEY, 'requires service key');

  test('outline: the engine outline\'s chapter titles are listed', async ({ page }) => {
    const [p] = await supaGet<any>('writing_projects_v2', `id=eq.${PROJECT_ID}&select=outline`);
    const titles = (p?.outline?.chapters ?? []).map((c: any) => String(c.title ?? '')).filter((t: string) => t.length > 3);
    expect(titles.length).toBeGreaterThan(10);
    await page.goto(`/projects/${PROJECT_ID}?tab=outline`, { waitUntil: 'domcontentloaded' });
    for (const t of [titles[0], titles[Math.floor(titles.length / 2)]]) {
      await expect(page.getByText(t, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    }
  });

  test('chapters: the engine-written chapters are the ones listed', async ({ page }) => {
    const rows = await supaGet<any>('published_content_v2',
      `project_id=eq.${PROJECT_ID}&content_type=eq.chapter&deleted_at=is.null&select=title,chapter_number&order=chapter_number.asc&limit=3`);
    expect(rows.length).toBeGreaterThan(0);
    await page.goto(`/projects/${PROJECT_ID}?tab=chapters`, { waitUntil: 'domcontentloaded' });
    for (const r of rows) {
      await expect(page.getByText(String(r.title), { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    }
  });

  test('story bible: a live engine entry is shown', async ({ page }) => {
    const live = await supaGet<any>('story_bible_v2',
      `project_id=eq.${PROJECT_ID}&entry_type=eq.character&deleted_at=is.null&select=name&order=name.asc&limit=1`);
    expect(live.length).toBe(1);
    await page.goto(`/projects/${PROJECT_ID}?tab=bible`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(String(live[0].name), { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  });

  test('research: the chapter research the engine filed for this project is listed', async ({ page }) => {
    const links = await supaGet<any>('research_report_projects_v2', `project_id=eq.${PROJECT_ID}&select=report_id&limit=200`);
    const ids = links.map((l: any) => l.report_id);
    expect(ids.length).toBeGreaterThan(0);
    const reports = await supaGet<any>('research_reports_v2',
      `id=in.(${ids.join(',')})&deleted_at=is.null&select=topic&order=created_at.desc&limit=1`);
    expect(reports.length).toBe(1);
    await page.goto(`/projects/${PROJECT_ID}?tab=research`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(String(reports[0].topic), { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  });
});
