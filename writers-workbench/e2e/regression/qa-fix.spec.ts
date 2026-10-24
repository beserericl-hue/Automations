import { test, expect } from '@playwright/test';
import { deleteProject, seedContent, seedProject } from '../pages/api';

/**
 * Q/A tab + "Rewrite to fix Q/A" — the feature added after a user found the Q/A Consistency Report had
 * no way to act on a flagged finding (and Q/A wasn't discoverable).
 *
 * PASS: the project Q/A tab renders every chapter with craft-QA scores; a chapter with a flagged check
 *       shows a "Rewrite to fix Q/A" button; clicking it queues an engine job (button → Rewriting…).
 * FAIL: no Q/A tab, no scores, no fix button, or the click doesn't dispatch.
 *
 * The full multi-minute rewrite completion is not awaited here (dispatch is the data-path proof); the
 * heavy content-change is covered by the chapter.repair path in content-repair.spec.ts.
 *
 * Its own data. It used to point at The Last Signal's chapter 3 and click the fix there — which
 * started a real rewrite of that chapter, which fixed the flagged check, so the next run found
 * nothing flagged and failed. A test that consumes its fixture passes once. Each run now seeds a
 * disposable project and chapter with one flagged check, and deletes both.
 */
const FLAGGED_REPORT = {
  qa_report: {
    generated_at: new Date(Date.now() - 3600_000).toISOString(),
    checks: [
      { name: 'Character consistency', status: 'PASS', details: 'seeded' },
      { name: 'Timeline continuity', status: 'FAIL', details: 'seeded: the dates in scene two contradict chapter one' },
    ],
  },
};

test.describe('Project Q/A tab + Rewrite to fix Q/A', () => {
  test.describe.configure({ mode: 'serial' });
  let projectId = '';
  let contentId = '';
  const title = `E2E QA Fix ${Date.now()}`;

  test.beforeAll(async () => {
    projectId = await seedProject({ title });
    contentId = await seedContent({
      title: 'Chapter 1 — The Relay',
      content_type: 'chapter',
      status: 'draft',
      chapter_number: 1,
      project_id: projectId,
      content_text: 'Mara climbed to the relay at dusk and listened for the voice that had no business being there. '.repeat(25),
      metadata: FLAGGED_REPORT,
    });
  });

  test.afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  test('the Q/A Consistency Report panel on a chapter exposes the fix action', async ({ page }) => {
    await page.goto(`/content/${contentId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Q\/A Consistency Report/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Rewrite to fix Q\/A/i }).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Q/A tab lists chapters with their report and a fix button for a flagged chapter', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=qa`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20_000 });

    // The grid renders the seeded chapter with its consistency result.
    await expect(page.getByText(/Craft QA/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('1/2 passed · 1 flagged')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'Chapter 1 — The Relay' })).toBeVisible();

    // Clicking the fix dispatches an engine job (button flips to Rewriting…). The rewrite itself is
    // not awaited; it runs on this disposable chapter, which is deleted afterwards.
    const fixBtn = page.getByRole('button', { name: /Rewrite to fix Q\/A/i }).first();
    await expect(fixBtn).toBeVisible({ timeout: 20_000 });
    await fixBtn.click();
    await expect(page.getByRole('button', { name: /Rewriting…/i }).first()).toBeVisible({ timeout: 20_000 });
  });
});
