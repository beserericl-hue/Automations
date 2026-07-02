import { test, expect } from '@playwright/test';
import { seedContent, getContent, deleteContent, supaGet } from '../pages/api';

/**
 * ContentDetail editor + Version History — RESULT-asserting, data-isolated.
 *
 * Editing the chapter must PERSIST (content_text changes in the DB) and snapshot a version row; the
 * VersionHistory panel must open and list those versions. Verified against editor/RichTextEditor +
 * content/VersionHistory. Seeds a disposable chapter; teardown deletes it.
 */
let contentId = '';
const MARKER = `EDITMARK-${Date.now()}`;

test.describe('ContentDetail editor + versions (result-asserting)', () => {
  test.beforeEach(async () => {
    contentId = await seedContent({
      title: `E2E Editor ${Date.now()}`,
      content_type: 'chapter',
      status: 'draft',
      content_text: 'The relay hummed in the dark. ',
    });
  });
  test.afterEach(async () => {
    if (contentId) await deleteContent(contentId);
  });

  test('typing in the editor persists content_text and adds a version snapshot', async ({ page }) => {
    await page.goto(`/content/${contentId}`);
    const editor = page.locator('.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 20_000 });

    const versionsBefore = (await supaGet('content_versions_v2', `content_id=eq.${contentId}&select=id`)).length;

    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${MARKER}`);

    // Result: content_text in the DB contains the typed marker (auto-save persisted it).
    await expect
      .poll(async () => (await getContent(contentId, 'content_text'))?.content_text?.includes(MARKER) ?? false,
        { timeout: 20_000, message: 'editor change did not persist content_text to the DB' })
      .toBe(true);

    // Result: a version snapshot row was added.
    await expect
      .poll(async () => (await supaGet('content_versions_v2', `content_id=eq.${contentId}&select=id`)).length,
        { timeout: 15_000, message: 'no content_versions_v2 snapshot was created' })
      .toBeGreaterThan(versionsBefore);
  });

  test('Version History opens and lists the saved version(s)', async ({ page }) => {
    await page.goto(`/content/${contentId}`);
    const editor = page.locator('.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    // Make an edit so at least one version exists.
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${MARKER}`);
    await expect
      .poll(async () => (await supaGet('content_versions_v2', `content_id=eq.${contentId}&select=id`)).length,
        { timeout: 20_000 })
      .toBeGreaterThan(0);

    await page.getByRole('button', { name: 'History', exact: true }).click();
    // The panel opens with a "View"/"Restore" affordance per version (proves versions rendered).
    await expect(page.getByRole('button', { name: /^(View|Restore)$/ }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  });
});
