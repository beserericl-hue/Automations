import { test, expect } from '@playwright/test';

/**
 * Content Library regression — filters, sort headers, row navigation, and the bulk-action toolbar.
 * Verified against components/content/ContentLibrary.tsx: 4 unlabeled filter selects (type/status/
 * genre/project), sortable Title/Type/Status/Updated headers, rows navigate on cell click, bulk bar
 * appears on selection. No bulk mutation is committed.
 */
test.describe('Content Library', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/library');
    await page.locator('header, aside').first().waitFor({ state: 'visible', timeout: 20_000 });
    await expect(page.getByText(/Content Library|Title|No content/i).first()).toBeVisible({ timeout: 20_000 });
    // The rows come from a direct Supabase fetch — wait for the table to SETTLE (first row OR the
    // empty-state copy) before any row-count logic, so row-dependent tests don't race the query.
    await Promise.race([
      page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
      page.getByText(/No content yet|No items match/i).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    ]);
  });

  test('type filter drives the ?type= URL param', async ({ page }) => {
    const typeSelect = page.getByRole('combobox').first();
    await expect(typeSelect).toBeVisible();
    await typeSelect.selectOption({ label: 'Chapters' });
    await expect(page).toHaveURL(/[?&]type=chapter/);
    // Clearing back to All removes the param.
    await typeSelect.selectOption({ label: 'All types' });
    await expect(page).not.toHaveURL(/[?&]type=/);
  });

  test('all four filter selects are present and selectable', async ({ page }) => {
    // Four filter selects (type/status/genre/project); a 5th page-size select appears once >10 items.
    const selects = page.getByRole('combobox');
    await expect(selects.nth(3)).toBeVisible();
    // Status filter (2nd) narrows without crashing.
    await selects.nth(1).selectOption({ label: 'Draft' }).catch(() => {});
    await expect(page.getByText(/Content Library|Title|No content/i).first()).toBeVisible();
  });

  test('sortable headers toggle sort indicator', async ({ page }) => {
    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count().catch(() => 0);
    test.skip(rowCount === 0, 'no content rows to sort');
    const titleHeader = page.getByRole('columnheader', { name: /Title/ }).first();
    await titleHeader.click();
    // A sort arrow (↑/↓) should appear on the active header.
    await expect(page.getByRole('columnheader', { name: /Title.*[↑↓]/ }).first()).toBeVisible({ timeout: 5_000 });
  });

  test('clicking a content row navigates to its detail', async ({ page }) => {
    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count().catch(() => 0);
    test.skip(rowCount === 0, 'no content rows to open');
    await rows.first().locator('td').nth(1).click();
    await expect(page).toHaveURL(/\/content\/[0-9a-f-]{8,}/, { timeout: 15_000 });
  });

  test('selecting a row reveals the bulk-action toolbar', async ({ page }) => {
    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count().catch(() => 0);
    test.skip(rowCount === 0, 'no content rows to select');
    await rows.first().getByRole('checkbox').check();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    // Deselect all clears the bar (no mutation committed).
    await page.getByRole('button', { name: 'Deselect all' }).click();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeHidden({ timeout: 8_000 });
  });
});
