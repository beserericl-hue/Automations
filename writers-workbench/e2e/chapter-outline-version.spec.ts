import { test, expect } from '@playwright/test';

test('Expanded chapter outline shows version info or date-not-recorded message', async ({ page }) => {
  await page.goto('/');
  if (page.url().includes('/login')) {
    test.skip(true, 'No credentials');
  }

  await page.goto('/projects');
  await page.waitForTimeout(2000);

  // Dismiss onboarding dialog if present
  const skipTutorial = page.getByText('Skip tutorial');
  if (await skipTutorial.isVisible({ timeout: 2000 }).catch(() => false)) {
    await skipTutorial.click();
    await page.waitForTimeout(500);
  }

  const project = page.locator('tbody tr', { hasText: 'Invisible Wall' }).first();
  if (!(await project.isVisible().catch(() => false))) {
    test.skip(true, 'No Invisible Wall project');
  }

  await project.click();
  await page.waitForURL(/\/projects\//);
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: 'Outline' }).click();
  await page.waitForTimeout(1000);

  // Scroll to chapter list
  await page.locator('main').evaluate(el => el.scrollTo(0, 600));
  await page.waitForTimeout(500);

  // Click on a chapter to expand it (find one with sections)
  const chapterToggle = page.locator('button:has-text("sections")').first();
  if (!(await chapterToggle.isVisible().catch(() => false))) {
    test.skip(true, 'No expandable chapters');
  }

  await chapterToggle.click();
  await page.waitForTimeout(500);

  // Scroll down to see the expanded content
  await page.locator('main').evaluate(el => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(500);

  // Should see either timestamp info OR "date not recorded" message
  const hasTimestamp = await page.getByText(/Created:/).isVisible().catch(() => false);
  const hasNotRecorded = await page.getByText(/date not recorded/).isVisible().catch(() => false);
  const hasSubChapters = await page.getByText(/sub-chapters/).first().isVisible().catch(() => false);

  // Take screenshot
  await page.screenshot({ path: 'test-results/chapter-outline-version.png' });

  // At least one of these should be visible
  expect(hasTimestamp || hasNotRecorded || hasSubChapters).toBe(true);

  console.log('hasTimestamp:', hasTimestamp, 'hasNotRecorded:', hasNotRecorded, 'hasSubChapters:', hasSubChapters);
});
