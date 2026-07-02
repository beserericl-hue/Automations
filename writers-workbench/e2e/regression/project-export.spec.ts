import { test, expect } from '@playwright/test';
import fs from 'fs';
import { seedProject, seedContent, deleteProject } from '../pages/api';

/**
 * ProjectDetail Export → .docx — RESULT-asserting, data-isolated.
 *
 * The bar: Export must actually DOWNLOAD a non-empty .docx, not just open the dialog. Seeds a disposable
 * project with one APPROVED chapter (the export route only includes approved/published chapters), opens
 * the Export tab, and asserts the real download event + a non-trivial file. Teardown deletes everything.
 * Verified against components/projects/ProjectDetail (Export tab → ExportDialog) + server routes/export.ts.
 */
let projectId = '';

test.describe('ProjectDetail Export (result-asserting)', () => {
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Export ${Date.now()}` });
    await seedContent({
      title: 'Chapter 1 — The Signal',
      content_type: 'chapter',
      status: 'approved',
      chapter_number: 1,
      project_id: projectId,
      content_text: 'The array woke at dawn. '.repeat(120),
    });
  });
  test.afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  test('Export dialog downloads a real .docx for an approved chapter', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=export`);
    const exportBtn = page.getByRole('button', { name: /Choose Page Size & Export/i });
    await expect(exportBtn).toBeVisible({ timeout: 20_000 });
    // With an approved chapter present, the button MUST be enabled (regression guard for the
    // "disabled until an approved chapter" gate).
    await expect(exportBtn).toBeEnabled({ timeout: 15_000 });
    await exportBtn.click();

    const download = page.getByRole('button', { name: /Download .docx/i });
    await expect(download).toBeVisible({ timeout: 10_000 });

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      download.click(),
    ]);
    expect(dl.suggestedFilename()).toMatch(/\.docx$/);
    const path = await dl.path();
    const size = fs.statSync(path).size;
    // A real KDP .docx (zip package) is several KB; a stub/empty response would be tiny.
    expect(size, 'downloaded .docx must be a real, non-empty document').toBeGreaterThan(2000);
  });
});
