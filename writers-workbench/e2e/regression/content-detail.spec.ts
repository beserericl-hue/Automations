import { test, expect } from '@playwright/test';
import { WorkbenchPage } from '../pages/workbench.page';
import { RegressionPage } from '../pages/regression.page';

/**
 * ContentDetail regression — opens a real chapter and exercises the editor toolbar, Version History
 * open/close, lifecycle-action presence, and the RewriteWithResearchModal (open → validate → cancel).
 * No destructive/lifecycle commit is performed against shared DEV data.
 *
 * Verified against components/content/ContentDetail.tsx + editor/RichTextEditor + content/VersionHistory
 * + content/RewriteWithResearchModal.
 */
test.describe('ContentDetail — editor, history, lifecycle, rewrite modal', () => {
  test('editor toolbar exposes the formatting controls', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openAChapter();
    test.skip(!id, 'no chapter content available on DEV');
    // Toolbar accessible names: text-content buttons expose their glyph (B/I/H1…); icon-only buttons
    // expose their title (Bullet List, Undo…). Save shows text "Save".
    for (const name of ['B', 'I', 'H1', 'H2', 'H3', 'Bullet List', 'Numbered List', 'Blockquote', 'Undo', 'Redo', 'Save']) {
      await expect(
        page.getByRole('button', { name, exact: true }).first(),
        `editor toolbar is missing the "${name}" control`,
      ).toBeVisible({ timeout: 15_000 });
    }
    // The contenteditable body is present.
    await expect(page.getByRole('textbox').first()).toBeVisible();
  });

  test('lifecycle actions are present for the chapter status', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openAChapter();
    test.skip(!id, 'no chapter content available');
    // At least one lifecycle action must exist (which one depends on status). Delete is always present.
    await expect(page.getByRole('button', { name: 'Delete', exact: true }).first()).toBeVisible({ timeout: 15_000 });
    const anyLifecycle = page.getByRole('button', {
      name: /^(Approve|Publish|Reject|Back to Draft|Unpublish|Publish Now|Unschedule)$/,
    });
    await expect(anyLifecycle.first()).toBeVisible({ timeout: 15_000 });
  });

  test('Version History opens and closes', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openAChapter();
    test.skip(!id, 'no chapter content available');
    const historyBtn = page.getByRole('button', { name: 'History', exact: true });
    await expect(historyBtn).toBeVisible({ timeout: 15_000 });
    await historyBtn.click();
    await expect(page.getByRole('button', { name: 'Close', exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(historyBtn).toBeVisible({ timeout: 10_000 });
  });

  test('Rewrite with research modal opens, validates min length, and cancels', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openAChapter();
    test.skip(!id, 'no chapter content available');
    const trigger = page.getByRole('button', { name: 'Rewrite with research', exact: true }).first();
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // Submit is disabled until research focus ≥ 10 chars.
    const submit = dialog.getByRole('button', { name: /Rewrite with research|Queuing/ });
    await expect(submit).toBeDisabled();
    await dialog.getByRole('textbox').first().fill('reconcile the timeline discrepancy in chapter three');
    await expect(submit).toBeEnabled();
    // Citation-mode radios present.
    await expect(dialog.getByRole('radio', { name: /Auto/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Invisible/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Inline/ })).toBeVisible();
    // Cancel without submitting.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  });
});
