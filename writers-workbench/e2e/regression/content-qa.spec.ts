import { test, expect } from '@playwright/test';
import { seedProject, seedContent, getContent, deleteProject } from '../pages/api';

/**
 * ContentDetail Run Q/A — RESULT-asserting, data-isolated. The bar: after the queued Q/A job finishes,
 * the report must DISPLAY its checks AND metadata.qa_report.checks must exist in the DB (not stay on
 * "No consistency report available"). Seeds a disposable project + chapter; teardown deletes them.
 * Real LLM job — generous timeout.
 */
let projectId = '';
let contentId = '';

test.describe('ContentDetail Run Q/A (result-asserting)', () => {
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E QA ${Date.now()}` });
    contentId = await seedContent({
      title: 'Chapter 1 — Contact',
      content_type: 'chapter',
      status: 'draft',
      chapter_number: 1,
      project_id: projectId,
      content_text: 'Mara watched the signal resolve into a voice she had not heard in twenty years. '.repeat(30),
    });
  });
  test.afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  test('Run Q/A produces a report with checks (DB + display)', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/content/${contentId}`);

    const run = page.getByRole('button', { name: /Run Q\/A Check/i });
    await expect(run, 'chapter must expose a Run Q/A Check button').toBeVisible({ timeout: 20_000 });
    await run.click();

    // DB result: metadata.qa_report.checks appears after the job finishes.
    await expect
      .poll(async () => {
        const row = await getContent(contentId, 'metadata');
        const checks = row?.metadata?.qa_report?.checks;
        return Array.isArray(checks) ? checks.length : 0;
      }, { timeout: 270_000, message: 'Q/A job never wrote metadata.qa_report.checks' })
      .toBeGreaterThan(0);

    // UI result: the report DISPLAYS (not the empty state).
    await page.reload();
    await expect(page.getByText(/Q\/A Consistency Report/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/No consistency report available/i)).toHaveCount(0);
  });
});
