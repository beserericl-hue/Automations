import { test, expect } from '@playwright/test';

test('Art tab images load as valid images in the browser', async ({ page }) => {
  await page.goto('/');
  if (page.url().includes('/login')) {
    test.skip(true, 'No credentials');
  }

  await page.goto('/projects');
  await page.waitForTimeout(2000);
  const project = page.locator('tbody tr', { hasText: 'Invisible Wall' }).first();
  if (!(await project.isVisible().catch(() => false))) {
    test.skip(true, 'No Invisible Wall project');
  }

  await project.click();
  await page.waitForURL(/\/projects\//);
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: 'Art' }).click();
  await page.waitForTimeout(3000);

  const imgInfo = await page.evaluate(() => {
    const imgs = document.querySelectorAll('main img');
    return Array.from(imgs).map(img => ({
      src: img.src.substring(0, 150),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      complete: img.complete,
    }));
  });

  console.log('Images found:', imgInfo.length);
  for (const img of imgInfo) {
    console.log('  src:', img.src);
    console.log('  size:', img.naturalWidth, 'x', img.naturalHeight);
    console.log('  loaded:', img.naturalWidth > 0);
  }

  await page.screenshot({ path: 'test-results/art-tab-final.png' });

  expect(imgInfo.length).toBeGreaterThan(0);
  const loaded = imgInfo.filter(i => i.naturalWidth > 0);
  expect(loaded.length).toBeGreaterThan(0);
});
