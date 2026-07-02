import { test, expect } from '@playwright/test';
import { seedContent, getContent, deleteContent } from '../pages/api';

/**
 * ContentDetail lifecycle — RESULT-asserting, data-isolated.
 *
 * Seeds a disposable draft chapter, drives the real lifecycle buttons in the UI, and asserts the status
 * transition on the EXACT target row in the DB (not just that a button was clickable) plus the UI moving
 * to the next state's actions. Teardown deletes the row. Verified against components/content/ContentDetail
 * (POST /api/content/:id/lifecycle).
 */
let contentId = '';

test.describe('ContentDetail lifecycle (result-asserting)', () => {
  test.beforeEach(async () => {
    contentId = await seedContent({
      title: `E2E Lifecycle ${Date.now()}`,
      content_type: 'chapter',
      status: 'draft',
      content_text: 'The vault door sealed behind them. '.repeat(40),
    });
  });
  test.afterEach(async () => {
    if (contentId) await deleteContent(contentId);
  });

  test('draft → approved → published transitions are verified in the DB', async ({ page }) => {
    await page.goto(`/content/${contentId}`);
    // Draft state: Approve + Reject present.
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeVisible({ timeout: 20_000 });
    expect((await getContent(contentId, 'status'))!.status).toBe('draft');

    // Approve → DB status becomes 'approved' AND the UI advances to the approved actions.
    await approve.click();
    await expect
      .poll(async () => (await getContent(contentId, 'status'))?.status,
        { timeout: 20_000, message: 'approve did not flip status to approved in the DB' })
      .toBe('approved');
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Back to Draft/i })).toBeVisible();

    // Publish → DB status becomes 'published' AND the UI shows Unpublish.
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect
      .poll(async () => (await getContent(contentId, 'status'))?.status,
        { timeout: 20_000, message: 'publish did not flip status to published in the DB' })
      .toBe('published');
    await expect(page.getByRole('button', { name: /Unpublish/i })).toBeVisible({ timeout: 15_000 });
  });

  test('reject requires confirm and sets status to rejected in the DB', async ({ page }) => {
    await page.goto(`/content/${contentId}`);
    const reject = page.getByRole('button', { name: 'Reject', exact: true });
    await expect(reject).toBeVisible({ timeout: 20_000 });
    await reject.click();
    // Reject is a confirm action — accept the dialog.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect
      .poll(async () => (await getContent(contentId, 'status'))?.status,
        { timeout: 20_000, message: 'reject did not flip status to rejected in the DB' })
      .toBe('rejected');
  });
});
