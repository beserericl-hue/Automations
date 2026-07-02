import { test, expect } from '@playwright/test';
import { seedProject, seedContent, seedChapterQa, latestChapterQa, getContent, deleteProject } from '../pages/api';

/**
 * Chapter repair buttons — RESULT-asserting, data-isolated. Fix Drift (chapter.repair) must clear the
 * drift (a fresh chapter_qa_v2 row with aligned=true); Rewrite-with-research (submit) must change the
 * chapter's content_text. Real engine jobs (minutes). Verified against ProjectDetail ChaptersTab
 * (ChapterFixDriftButton / useChapterRepair) + content/RewriteWithResearchModal + server content-actions.
 */
test.describe('Fix Drift (result-asserting)', () => {
  let projectId = '';
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Drift ${Date.now()}` });
    await seedContent({
      title: 'Chapter 1 — Drifted', content_type: 'chapter', status: 'draft', chapter_number: 1,
      project_id: projectId, content_text: 'Ahanu and Sokan shared the fire, though the outline named them rivals. '.repeat(40),
    });
    // Put chapter 1 into a drift state so the Fix Drift button renders.
    await seedChapterQa(projectId, 1, false);
  });
  test.afterAll(async () => { if (projectId) await deleteProject(projectId); });

  test('Fix Drift runs chapter.repair → a fresh aligned chapter_qa_v2 row', async ({ page }) => {
    test.setTimeout(360_000);
    await page.goto(`/projects/${projectId}?tab=chapters`);
    const fixBtn = page.getByRole('button', { name: /Fix Drift/i }).first();
    await expect(fixBtn, 'a drifted chapter must show Fix Drift').toBeVisible({ timeout: 20_000 });
    const seededQa = await latestChapterQa(projectId, 1);
    await fixBtn.click();

    // Result: a NEW chapter_qa_v2 row from the repair, aligned=true (drift cleared).
    await expect
      .poll(async () => {
        const qa = await latestChapterQa(projectId, 1);
        return qa && qa.id !== seededQa?.id ? qa.aligned : null;
      }, { timeout: 340_000, message: 'Fix Drift never produced a fresh aligned chapter_qa_v2 row' })
      .toBe(true);
  });
});

test.describe('Rewrite with research (result-asserting)', () => {
  let projectId = '';
  let contentId = '';
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E RWR ${Date.now()}` });
    contentId = await seedContent({
      title: 'Chapter 1 — Research', content_type: 'chapter', status: 'draft', chapter_number: 1,
      project_id: projectId, content_text: 'The legion crossed the frozen river at dawn, banners stiff with frost. '.repeat(30),
    });
  });
  test.afterAll(async () => { if (projectId) await deleteProject(projectId); });

  test('Rewrite with research submit runs chapter.repair → content_text changes', async ({ page }) => {
    test.setTimeout(420_000);
    const before = (await getContent(contentId, 'content_text'))?.content_text ?? '';
    await page.goto(`/content/${contentId}`);
    await page.getByRole('button', { name: 'Rewrite with research', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('textbox').first().fill('Ground the Roman river-crossing in real period military logistics and geography.');
    await dialog.getByRole('button', { name: /Rewrite with research|Queuing/ }).click();

    // Result: the chapter's content_text is rewritten (differs from the seed).
    await expect
      .poll(async () => {
        const now = (await getContent(contentId, 'content_text'))?.content_text ?? '';
        return now && now !== before ? now.length : 0;
      }, { timeout: 400_000, message: 'Rewrite-with-research never changed content_text' })
      .toBeGreaterThan(0);
  });
});
