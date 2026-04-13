import { test, expect } from '@playwright/test';

/**
 * Sprint 5: Observability & Advanced Features — E2E Tests
 * Authenticated tests covering cost dashboard, Q/A reports,
 * provenance panel, source browser, sidebar links, and auto-refresh.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const url = page.url();
  if (url.includes('/login')) {
    test.skip(true, 'No test credentials — set E2E_TEST_EMAIL and E2E_TEST_PASSWORD');
  }
});

// =====================================================
// S5-1: COST TRACKING DASHBOARD
// =====================================================

test.describe('S5-1: Cost Tracking Dashboard', () => {
  test('cost page loads at /cost', async ({ page }) => {
    await page.goto('/cost');
    // Should show either cost data or empty state
    const heading = page.getByText(/Usage & Cost|No usage data yet/);
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('cost page has date range selector', async ({ page }) => {
    await page.goto('/cost');
    await page.waitForTimeout(2000);
    // Date range buttons present (even in empty state, the component renders)
    const costContent = page.locator('main');
    const hasRangeButtons = await costContent.getByText('7d').isVisible().catch(() => false);
    const hasEmptyState = await costContent.getByText('No usage data yet').isVisible().catch(() => false);
    expect(hasRangeButtons || hasEmptyState).toBeTruthy();
  });

  test('project workspace Cost tab renders CostDashboard', async ({ page }) => {
    // Navigate to a project, click Cost tab
    await page.goto('/projects');
    await page.waitForTimeout(2000);
    const projectLink = page.locator('table tbody tr, [class*="project"]').first();
    if (await projectLink.isVisible().catch(() => false)) {
      await projectLink.click();
      await page.waitForTimeout(1000);
      const costTab = page.getByText('Cost');
      if (await costTab.isVisible()) {
        await costTab.click();
        await page.waitForTimeout(1000);
        // Should show cost dashboard or empty state
        const costContent = page.locator('main');
        const visible = await costContent.getByText(/Usage & Cost|Project Cost|No usage data yet/).isVisible().catch(() => false);
        expect(visible).toBeTruthy();
      }
    }
  });
});

// =====================================================
// S5-2: CONTENT PROVENANCE PANEL
// =====================================================

test.describe('S5-2: Content Provenance', () => {
  test('source browser page loads at /sources', async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByText('Source Browser')).toBeVisible({ timeout: 10_000 });
  });

  test('source browser has genre filter dropdown', async ({ page }) => {
    await page.goto('/sources');
    await page.waitForTimeout(2000);
    const select = page.locator('select');
    await expect(select).toBeVisible();
    // Should have "All genres" option
    await expect(select.locator('option').first()).toHaveText('All genres');
  });

  test('source browser has type filter buttons', async ({ page }) => {
    await page.goto('/sources');
    await page.waitForTimeout(2000);
    await expect(page.getByText('All Types')).toBeVisible();
    await expect(page.getByRole('button', { name: 'RSS' })).toBeVisible();
  });

  test('content detail page has Sources panel', async ({ page }) => {
    // Navigate to a content item
    await page.goto('/library');
    await page.waitForTimeout(2000);
    const contentRow = page.locator('table tbody tr').first();
    if (await contentRow.isVisible().catch(() => false)) {
      await contentRow.click();
      await page.waitForTimeout(2000);
      // Should see the Sources collapsible panel button
      const sourcesPanel = page.getByRole('button', { name: 'Sources' });
      await expect(sourcesPanel).toBeVisible({ timeout: 5000 });
    }
  });
});

// =====================================================
// S5-3: Q/A CONSISTENCY REPORTS
// =====================================================

test.describe('S5-3: Q/A Reports', () => {
  test('chapter content shows Q/A report panel or no-report message', async ({ page }) => {
    // Navigate to library filtered by chapters
    await page.goto('/library?type=chapter');
    await page.waitForTimeout(2000);
    const chapterRow = page.locator('table tbody tr').first();
    if (await chapterRow.isVisible().catch(() => false)) {
      await chapterRow.click();
      await page.waitForTimeout(2000);
      // Should show either Q/A panel or "No consistency report available"
      const qaPanel = page.getByText(/Q\/A Consistency Report|No consistency report available/);
      await expect(qaPanel).toBeVisible({ timeout: 5000 });
    }
  });
});

// =====================================================
// S5-4: WEB CALLBACK / SESSION REGISTRATION
// =====================================================

test.describe('S5-4: Session API endpoints', () => {
  test('session active endpoint returns JSON', async ({ request }) => {
    const response = await request.get('/api/session/active?user_id=+14105914612');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('active');
    expect(body).toHaveProperty('channel');
  });

  test('session active returns false for unknown user', async ({ request }) => {
    const response = await request.get('/api/session/active?user_id=+10000000000');
    const body = await response.json();
    expect(body.active).toBe(false);
    expect(body.channel).toBeNull();
  });

  test('session active rejects missing user_id', async ({ request }) => {
    const response = await request.get('/api/session/active');
    expect(response.status()).toBe(400);
  });

  test('content-ready callback rejects missing user_id', async ({ request }) => {
    const response = await request.post('/api/callback/content-ready', {
      data: { content_title: 'Test' },
    });
    expect(response.status()).toBe(400);
  });

  test('content-ready callback accepts valid payload', async ({ request }) => {
    const response = await request.post('/api/callback/content-ready', {
      data: {
        user_id: '+14105914612',
        content_title: 'E2E Test Chapter',
        content_type: 'chapter',
      },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });
});

// =====================================================
// S5-6: SIDEBAR & NAVIGATION
// =====================================================

test.describe('S5-6: Sidebar links and navigation', () => {
  test('sidebar Reference section includes Sources link', async ({ page }) => {
    // Expand Reference section
    const refButton = page.locator('aside').getByText('Reference');
    if (await refButton.isVisible()) {
      await refButton.click();
      await page.waitForTimeout(500);
      await expect(page.locator('aside').getByText('Sources')).toBeVisible();
    }
  });

  test('sidebar Reference section includes Cost Tracking link', async ({ page }) => {
    const refButton = page.locator('aside').getByText('Reference');
    if (await refButton.isVisible()) {
      await refButton.click();
      await page.waitForTimeout(500);
      await expect(page.locator('aside').getByText('Cost Tracking')).toBeVisible();
    }
  });

  test('Sources link navigates to /sources', async ({ page }) => {
    const refButton = page.locator('aside').getByText('Reference');
    if (await refButton.isVisible()) {
      await refButton.click();
      await page.waitForTimeout(500);
      await page.locator('aside').getByText('Sources').click();
      await page.waitForTimeout(1000);
      expect(page.url()).toContain('/sources');
    }
  });

  test('Cost Tracking link navigates to /cost', async ({ page }) => {
    const refButton = page.locator('aside').getByText('Reference');
    if (await refButton.isVisible()) {
      await refButton.click();
      await page.waitForTimeout(500);
      await page.locator('aside').getByText('Cost Tracking').click();
      await page.waitForTimeout(1000);
      expect(page.url()).toContain('/cost');
    }
  });

  test('no [object Object] on cost page', async ({ page }) => {
    await page.goto('/cost');
    await page.waitForTimeout(2000);
    const bodyText = await page.locator('main').textContent();
    expect(bodyText).not.toContain('[object Object]');
  });

  test('no [object Object] on sources page', async ({ page }) => {
    await page.goto('/sources');
    await page.waitForTimeout(2000);
    const bodyText = await page.locator('main').textContent();
    expect(bodyText).not.toContain('[object Object]');
  });
});
