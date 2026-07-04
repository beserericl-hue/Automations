import { test, expect } from '@playwright/test';
import { WorkbenchPage } from '../pages/workbench.page';
import { RegressionPage } from '../pages/regression.page';

/**
 * ProjectDetail regression — opens a real project and exercises all 9 tabs + the non-destructive
 * controls (Edit form open/cancel, Export dialog open/cancel or correctly-disabled). Destructive
 * actions (Delete Project) are asserted present + open-the-confirm-then-cancel only; never committed.
 *
 * Verified against components/projects/ProjectDetail.tsx (tab set is URL-driven ?tab=).
 */
const TAB_MARKERS: Record<string, RegExp> = {
  Overview: /Premise|Chapters Written|Total Words|Genre|Themes|Characters/i,
  Outline: /No outline yet|Book Overview|Expand all|Chapter/i,
  Chapters: /No chapters written yet|QA|Rewrite|prev|Chapter/i,
  'Story Bible': /No story bible entries yet|Characters|Locations|Events/i,
  Art: /Cover Art|No images yet|All Types/i,
  Social: /Social Media|No social posts yet|All Platforms/i,
  Research: /No research reports yet|Expand all|Research/i,
  Cost: /Cost|Total Cost|No usage data yet/i,
  Export: /Choose Page Size|No chapters are approved|Export/i,
};

test.describe('ProjectDetail — all tabs + controls', () => {
  test('every tab renders its content', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openProjectByTitle('The Last Signal');
    test.skip(!id, 'no projects available on DEV to open');

    for (const [tab, marker] of Object.entries(TAB_MARKERS)) {
      await wb.openProjectTab(tab);
      // ProjectDetail content is NOT inside <main>; assert against the whole body.
      await expect(
        page.getByText(marker).first(),
        `Project tab "${tab}" did not render its expected content ${marker}`,
      ).toBeVisible({ timeout: 20_000 });
    }
  });

  test('Edit form opens and cancels without saving', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openProjectByTitle('The Last Signal');
    test.skip(!id, 'no projects available');
    const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
    await edit.click();
    // ProjectEditForm has a Save Changes + Cancel; assert it appeared then cancel.
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeHidden({ timeout: 10_000 });
  });

  test('Export tab: dialog opens (or button correctly disabled when nothing approved)', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openProjectByTitle('The Last Signal');
    test.skip(!id, 'no projects available');
    await wb.openProjectTab('Export');
    const exportBtn = page.getByRole('button', { name: /Choose Page Size & Export/ });
    await expect(exportBtn).toBeVisible({ timeout: 15_000 });
    if (await exportBtn.isDisabled()) {
      // Disabled is valid — must be accompanied by the explanatory copy.
      await expect(page.getByText(/No chapters are approved\/published yet/i)).toBeVisible();
    } else {
      await exportBtn.click();
      // ExportDialog: Page Size select (default 6x9) + Download .docx + Cancel.
      await expect(page.getByRole('button', { name: /Download .docx/ })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('combobox').first()).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).first().click();
      await expect(page.getByRole('button', { name: /Download .docx/ })).toBeHidden({ timeout: 10_000 });
    }
  });

  test('Delete Project opens the confirm dialog and cancels (no delete)', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const rp = new RegressionPage(page);
    const id = await wb.openProjectByTitle('The Last Signal');
    test.skip(!id, 'no projects available');
    const del = page.getByRole('button', { name: 'Delete Project' });
    await expect(del).toBeVisible({ timeout: 10_000 });
    await rp.assertDialogOpensAndCloses(() => del.click(), page.getByRole('dialog'));
    // Still on the project after cancelling.
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{8,}/);
  });
});
