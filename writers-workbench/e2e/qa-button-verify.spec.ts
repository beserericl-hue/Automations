import { test, expect } from '@playwright/test';

test('Q/A button triggers without error', async ({ page }) => {
  await page.goto('/');
  if (page.url().includes('/login')) {
    test.skip(true, 'No credentials');
  }

  await page.goto('/library?type=chapter');
  await page.waitForTimeout(2000);

  const invisibleWallRow = page.locator('table tbody tr', { hasText: 'The Door' }).first();
  const fallbackRow = page.locator('table tbody tr').first();
  const targetRow = (await invisibleWallRow.isVisible().catch(() => false)) ? invisibleWallRow : fallbackRow;
  if (!(await targetRow.isVisible().catch(() => false))) {
    test.skip(true, 'No chapters found');
  }

  await targetRow.locator('td').nth(1).click();
  await page.waitForURL(/\/content\//, { timeout: 5000 });
  await page.waitForTimeout(2000);

  const qaButton = page.getByRole('button', { name: /Run Q\/A Check/i });
  await expect(qaButton).toBeVisible({ timeout: 5000 });
  await qaButton.click();
  await page.waitForTimeout(5000);

  const errorMsg = page.getByText('Failed to start Q/A check');
  const isErrorVisible = await errorMsg.isVisible().catch(() => false);
  expect(isErrorVisible).toBe(false);

  const successMsg = page.getByText('Q/A check started');
  const isSuccess = await successMsg.isVisible().catch(() => false);
  expect(isSuccess).toBe(true);
});

test('Outline tab shows version number and updated date', async ({ page }) => {
  await page.goto('/');
  if (page.url().includes('/login')) {
    test.skip(true, 'No credentials');
  }

  await page.goto('/projects');
  await page.waitForTimeout(2000);
  const projectLink = page.locator('tbody tr', { hasText: 'Invisible Wall' }).first();
  if (!(await projectLink.isVisible().catch(() => false))) {
    test.skip(true, 'The Invisible Wall project not found');
  }

  await projectLink.click();
  await page.waitForURL(/\/projects\//);
  await page.waitForTimeout(1000);

  // Verify project header shows version badge and dates
  const header = page.locator('main');
  await expect(header.getByText(/Created \d/)).toBeVisible({ timeout: 5000 });
  await expect(header.getByText(/Updated \d/)).toBeVisible({ timeout: 5000 });

  // Click Outline tab
  await page.getByRole('button', { name: 'Outline' }).click();
  await page.waitForTimeout(1000);

  // Scroll down to the chapter list area
  await page.locator('main').evaluate(el => el.scrollTo(0, 500));
  await page.waitForTimeout(500);

  // Verify "Outline updated:" timestamp is visible in the chapter list header
  await expect(page.getByText(/Outline updated:/)).toBeVisible({ timeout: 5000 });

  // Verify version badge is visible (e.g. "v27")
  const versionBadge = page.getByText(/^v\d+$/);
  await expect(versionBadge).toBeVisible({ timeout: 5000 });

  // Verify "prior revisions" text is visible (may appear in both Book Overview and Chapters header)
  await expect(page.getByText(/prior revision/).first()).toBeVisible({ timeout: 5000 });

  // Take screenshot for verification
  await page.screenshot({ path: 'test-results/outline-version-info.png' });
});

test('Content detail shows created date, updated date, and ID', async ({ page }) => {
  await page.goto('/');
  if (page.url().includes('/login')) {
    test.skip(true, 'No credentials');
  }

  await page.goto('/library?type=chapter');
  await page.waitForTimeout(2000);

  const row = page.locator('table tbody tr', { hasText: 'The Door' }).first();
  if (!(await row.isVisible().catch(() => false))) {
    test.skip(true, 'No chapters found');
  }

  await row.locator('td').nth(1).click();
  await page.waitForURL(/\/content\//, { timeout: 5000 });
  await page.waitForTimeout(2000);

  // Verify created date, updated date, and ID badge
  const header = page.locator('main');
  await expect(header.getByText(/Created \d/)).toBeVisible({ timeout: 5000 });
  await expect(header.getByText(/Updated \d/)).toBeVisible({ timeout: 5000 });
  await expect(header.getByText(/^ID: [a-f0-9]{8}$/)).toBeVisible({ timeout: 5000 });
});

test('Write button opens command dialog with optional notes', async ({ page }) => {
  await page.goto('/');
  if (page.url().includes('/login')) {
    test.skip(true, 'No credentials');
  }

  await page.goto('/projects');
  await page.waitForTimeout(2000);
  const projectLink = page.locator('tbody tr', { hasText: 'Invisible Wall' }).first();
  if (!(await projectLink.isVisible().catch(() => false))) {
    test.skip(true, 'The Invisible Wall project not found');
  }

  await projectLink.click();
  await page.waitForURL(/\/projects\//);
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: 'Outline' }).click();
  await page.waitForTimeout(1000);

  // Find action buttons on chapter rows (not tab buttons)
  // Use a more specific selector — chapter row buttons have border-indigo or border-green classes
  const actionBtn = page.locator('button:text-is("Write"), button:text-is("Rewrite"), button:text-is("Re-outline")').first();
  // Scroll the main content area down
  await page.locator('main').evaluate(el => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(500);
  if (!(await actionBtn.isVisible().catch(() => false))) {
    test.skip(true, 'No action buttons found');
  }

  await actionBtn.scrollIntoViewIfNeeded();
  await actionBtn.click({ force: true });
  await page.waitForTimeout(1000);

  // Verify dialog opened — look for the instructions label
  const label = page.getByText('Additional instructions for the AI');
  await expect(label).toBeVisible({ timeout: 3000 });

  // Verify textarea is inside the dialog overlay
  const dialogTextarea = page.getByPlaceholder('e.g.');
  await expect(dialogTextarea).toBeVisible();

  // Verify "Send without notes" button
  const sendWithoutNotes = page.getByRole('button', { name: 'Send without notes' });
  await expect(sendWithoutNotes).toBeVisible();

  // Verify Cancel button
  const cancelBtn = page.locator('.fixed').getByRole('button', { name: 'Cancel' });
  await expect(cancelBtn).toBeVisible();

  // Test cancel closes dialog
  await cancelBtn.click();
  await page.waitForTimeout(500);
  await expect(label).not.toBeVisible();
});

test('Rewrite button in Chapters tab opens command dialog', async ({ page }) => {
  await page.goto('/');
  if (page.url().includes('/login')) {
    test.skip(true, 'No credentials');
  }

  await page.goto('/projects');
  await page.waitForTimeout(2000);
  const projectLink = page.locator('tbody tr', { hasText: 'Invisible Wall' }).first();
  if (!(await projectLink.isVisible().catch(() => false))) {
    test.skip(true, 'The Invisible Wall project not found');
  }

  await projectLink.click();
  await page.waitForURL(/\/projects\//);
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: 'Chapters' }).click();
  await page.waitForTimeout(1000);

  const rewriteBtn = page.getByRole('button', { name: 'Rewrite' }).first();
  if (!(await rewriteBtn.isVisible().catch(() => false))) {
    test.skip(true, 'No Rewrite buttons');
  }

  await rewriteBtn.click();
  await page.waitForTimeout(500);

  // Verify dialog opened
  const label = page.getByText('Additional instructions for the AI');
  await expect(label).toBeVisible({ timeout: 3000 });

  // Type notes
  const dialogTextarea = page.getByPlaceholder('e.g.');
  await dialogTextarea.fill('Research the constitutional cases Lucia argues about so the facts are correct');
  await page.waitForTimeout(300);

  // Verify send button shows correct label
  const sendBtn = page.getByRole('button', { name: 'Rewrite Chapter' });
  await expect(sendBtn).toBeVisible();

  // Cancel without sending
  await page.locator('.fixed').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(500);
  await expect(label).not.toBeVisible();
});
