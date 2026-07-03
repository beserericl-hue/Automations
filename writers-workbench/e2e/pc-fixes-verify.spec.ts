/**
 * pc-fixes-verify — real-browser verification of the "works on Mac, broken on PC" fixes:
 *   1. Sidebar logo navigates to the dashboard (/).
 *   2. Pending Approvals renders each row's OWN edition badge (The Wasteland Wire),
 *      not the hardcoded "The Workbench" fallback.
 *   3. "Generate Cover Art" opens the prompt modal and does NOT immediately generate
 *      (no wasted image tokens before the user confirms).
 *   4. The Wasteland Wire template preview shows the rebranded masthead, not "Workbench".
 *
 * Run against DEV: E2E_BASE_URL=https://writersworkbench-develop.up.railway.app
 * These assert RENDERED RESULTS in the actual browser, per the result-assertion SOP.
 *
 * NOTE: the app holds a persistent SSE session connection, so `networkidle` never
 * fires — we wait on concrete elements instead.
 */
import { test, expect } from '@playwright/test';

test.describe('PC-parity fixes', () => {
  test('sidebar logo navigates to the dashboard', async ({ page }) => {
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    const logo = page.getByRole('link', { name: /go to dashboard/i }).first();
    await expect(logo).toBeVisible({ timeout: 20_000 });
    await logo.click();
    await expect(page).toHaveURL(/\/(dashboard)?$/);
    // Dashboard heading confirms we actually landed on home.
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('Pending Approvals shows the real edition badge, not "The Workbench"', async ({ page }) => {
    await page.goto('/newsletter/approvals', { waitUntil: 'domcontentloaded' });
    // Wait for the list to resolve (either rows or the empty state).
    const emptyState = page.getByText(/no pending approvals/i);
    const wasteland = page.getByText('The Wasteland Wire').first();
    await expect(emptyState.or(wasteland)).toBeVisible({ timeout: 20_000 });
    if (await emptyState.isVisible().catch(() => false)) {
      test.skip(true, 'no pending approvals seeded — nothing to assert');
    }
    await expect(wasteland).toBeVisible();
    await expect(page.getByText('The Workbench')).toHaveCount(0);
  });

  test('Generate Cover Art opens the modal instead of generating immediately', async ({ page }) => {
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    const proj = page.getByText('The Last Signal').first();
    await expect(proj).toBeVisible({ timeout: 20_000 });
    await proj.click();
    // Land on the project; open the Outline tab where the Book Overview lives.
    const outlineTab = page.getByRole('button', { name: /^Outline$/ })
      .or(page.getByRole('tab', { name: /Outline/ }))
      .or(page.getByText(/^Outline$/));
    await expect(outlineTab.first()).toBeVisible({ timeout: 20_000 });
    await outlineTab.first().click();
    const genBtn = page.getByRole('button', { name: /Generate Cover Art/i }).first();
    await expect(genBtn).toBeVisible({ timeout: 20_000 });
    await genBtn.click();
    // A modal with an editable prompt must appear; the button must NOT flip to "Generating…".
    await expect(page.getByRole('heading', { name: /Generate cover art/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder(/Describe the cover art/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Generating…$/ })).toHaveCount(0);
  });

  test('Wasteland Wire template preview is rebranded (no "Workbench" masthead)', async ({ page }) => {
    await page.goto('/newsletter/templates', { waitUntil: 'domcontentloaded' });
    const tpl = page.getByText(/Wasteland Wire \(default\)/i).first();
    await expect(tpl).toBeVisible({ timeout: 20_000 });
    await tpl.click();
    // Render the preview, then assert the masthead INSIDE the preview iframe: it must say
    // "Wasteland Wire" and must never say "Workbench" (the old baked-in Course Worx branding).
    const renderBtn = page.getByRole('button', { name: /Render preview/i });
    await expect(renderBtn).toBeVisible({ timeout: 20_000 });
    await renderBtn.click();
    const preview = page.frameLocator('iframe[title="Template preview"]');
    await expect(preview.getByText(/Wasteland Wire/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(preview.getByText(/Workbench/i)).toHaveCount(0);
  });
});
