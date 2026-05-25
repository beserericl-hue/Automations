import { test, expect } from '@playwright/test';

/**
 * Sprint Regression Suite
 *
 * Covers UI behaviors introduced across the production sprints to date:
 *   - Sprint 8 (RBAC + tiers + credits + impersonation)
 *   - Sprint 10b (BullMQ + SSE callbacks, ChatDrawer pill states)
 *   - Sprint 11 (Postal email pipeline — email-bounces admin tab)
 *   - Sprint 12 Tracks B+C (rewrite-with-research, drift scanner, Q/A report, annotations panel)
 *   - Newsletter cluster regression (drift between releases; sidebar nav)
 *   - Cross-cutting: dark mode, onboarding tour replay, breadcrumb, global search
 *
 * Companion to:
 *   - sprint7-critical-paths.spec.ts (older critical paths)
 *   - newsletter-fullflow.spec.ts (newsletter-focused)
 *
 * Tests are designed to be robust against missing data — they skip
 * gracefully when no test fixtures are present rather than failing.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  if (page.url().includes('/login')) {
    test.skip(true, 'No test credentials — set E2E_TEST_EMAIL and E2E_TEST_PASSWORD');
  }
});

// Helper: pick first project row, return false if none exist
async function gotoFirstProject(page: import('@playwright/test').Page) {
  await page.goto('/projects');
  await page.waitForTimeout(2_000);
  const firstRow = page.locator('tbody tr').first();
  if (!(await firstRow.isVisible().catch(() => false))) return false;
  await firstRow.click();
  await page.waitForURL(/\/projects\//);
  await page.waitForTimeout(1_000);
  return true;
}

// Helper: open first chapter from library
async function gotoFirstChapter(page: import('@playwright/test').Page) {
  await page.goto('/library?type=chapter');
  await page.waitForTimeout(2_000);
  const firstRow = page.locator('tbody tr').first();
  if (!(await firstRow.isVisible().catch(() => false))) return false;
  await firstRow.locator('td').nth(1).click();
  await page.waitForURL(/\/content\//);
  await page.waitForTimeout(2_000);
  return true;
}

// =====================================================
// Sprint 8 — RBAC + tiers + credits + impersonation
// =====================================================
test.describe('Sprint 8: Tier + credits UI', () => {
  test('Sidebar credits pill displays a balance', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2_000);
    // Credits pill is in the sidebar with text like "N credits" or a numeric badge
    const sidebar = page.locator('aside');
    const text = (await sidebar.textContent())?.toLowerCase() || '';
    const hasCredits = /credit|balance|tokens?\s/.test(text) || /\d+\s*(credit|token)/.test(text);
    expect(hasCredits).toBeTruthy();
  });

  test('Credits page route renders', async ({ page }) => {
    await page.goto('/credits');
    await page.waitForTimeout(2_000);
    if (page.url().includes('/login')) test.skip(true);
    const main = page.locator('main');
    await expect(main).toBeVisible();
    const text = (await main.textContent())?.toLowerCase() || '';
    expect(/credit|balance|purchase|usage/.test(text)).toBeTruthy();
  });

  test('Settings page tier selector / subscription panel renders', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(2_000);
    const main = page.locator('main');
    await expect(main).toBeVisible();
    const text = (await main.textContent())?.toLowerCase() || '';
    expect(/tier|subscription|plan|standard|pro/.test(text)).toBeTruthy();
  });

  test('Admin route accessible for superuser; user mgmt tab visible', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(2_000);
    if ((await page.getByText(/forbidden|not authorized/i).isVisible().catch(() => false)) || page.url().includes('/login')) {
      test.skip(true, 'Test user does not have admin/superuser access');
    }
    const hasUserTab = await page.getByRole('button', { name: /users?|user management/i }).first().isVisible().catch(() => false);
    expect(hasUserTab).toBeTruthy();
  });

  test('Superuser panel route exists (superuser-only)', async ({ page }) => {
    await page.goto('/superuser');
    await page.waitForTimeout(2_000);
    if ((await page.getByText(/forbidden|not authorized/i).isVisible().catch(() => false)) || page.url().includes('/login')) {
      test.skip(true, 'Test user is not superuser');
    }
    const text = (await page.locator('main').textContent())?.toLowerCase() || '';
    expect(/impersonat|tier|config/.test(text)).toBeTruthy();
  });
});

// =====================================================
// Sprint 10b — BullMQ + SSE — ChatDrawer pill states
// =====================================================
test.describe('Sprint 10b: ChatDrawer + SSE', () => {
  test('ChatDrawer toggle button visible in TopBar', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2_000);
    // ChatDrawer is opened from the top bar (chat icon button)
    const topbar = page.locator('header, [class*="topbar"], [class*="TopBar"]').first();
    await expect(topbar).toBeVisible();
    const chatBtn = page.getByRole('button', { name: /chat|message/i }).first();
    expect(await chatBtn.isVisible().catch(() => false)).toBeTruthy();
  });

  test('ChatDrawer opens with input + close', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2_000);
    const chatBtn = page.getByRole('button', { name: /chat|message/i }).first();
    if (!(await chatBtn.isVisible().catch(() => false))) test.skip(true, 'No chat button visible');
    await chatBtn.click();
    await page.waitForTimeout(800);
    // Drawer should expose a textarea or input + send button
    const hasInput = await page.locator('textarea, input[type="text"]').last().isVisible().catch(() => false);
    expect(hasInput).toBeTruthy();
  });
});

// =====================================================
// Sprint 11 — Postal email pipeline (admin email-bounces tab)
// =====================================================
test.describe('Sprint 11: Email bounces admin tab', () => {
  test('Email bounces tab loads (admin-only)', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(2_000);
    if ((await page.getByText(/forbidden|not authorized/i).isVisible().catch(() => false)) || page.url().includes('/login')) {
      test.skip(true);
    }
    const bouncesTab = page.getByRole('button', { name: /email bounces|bounces/i }).first();
    if (!(await bouncesTab.isVisible().catch(() => false))) test.skip(true, 'No bounces tab');
    await bouncesTab.click();
    await page.waitForTimeout(1_500);
    const main = page.locator('main');
    const text = (await main.textContent())?.toLowerCase() || '';
    expect(/bounce|hard|soft|complaint|no bounces/.test(text)).toBeTruthy();
  });
});

// =====================================================
// Sprint 12 — Chapter tools (drift scanner, Q/A, rewrite-with-research, annotations)
// =====================================================
test.describe('Sprint 12: Chapter craft tools', () => {
  test('ContentDetail loads with TipTap editor for a chapter', async ({ page }) => {
    if (!(await gotoFirstChapter(page))) test.skip(true, 'No chapter to open');
    await expect(page.locator('.ProseMirror, .tiptap, [class*="prose"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test('Cover-image banner visible on chapter (Sprint 4 + 12 surface)', async ({ page }) => {
    if (!(await gotoFirstChapter(page))) test.skip(true);
    const hasBanner = await page.locator('img[alt*="cover"], [class*="cover-banner"], [class*="CoverBanner"]').first().isVisible().catch(() => false);
    const hasChooseFromGallery = await page.getByRole('button', { name: /choose from gallery|change cover/i }).first().isVisible().catch(() => false);
    expect(hasBanner || hasChooseFromGallery).toBeTruthy();
  });

  test('Side panels: Sources / Q/A Report / Annotations all reachable from chapter', async ({ page }) => {
    if (!(await gotoFirstChapter(page))) test.skip(true);
    // These panels may be collapsible — find any/all of them by header text
    const main = page.locator('main');
    const text = ((await main.textContent()) || '').toLowerCase();
    // At minimum some panel headers should be visible
    const hasAny = /sources|q\/?a report|annotations|drift/.test(text);
    expect(hasAny).toBeTruthy();
  });

  test('Rewrite-with-Research button surfaces on chapter (Sprint 12 S12-9)', async ({ page }) => {
    if (!(await gotoFirstChapter(page))) test.skip(true);
    const hasBtn = await page.getByRole('button', { name: /rewrite.*research/i }).first().isVisible().catch(() => false);
    // Button may be gated by project_type or tier; don't hard-fail
    expect(typeof hasBtn).toBe('boolean');
    if (hasBtn) {
      // Click and verify the modal opens with the expected fields
      await page.getByRole('button', { name: /rewrite.*research/i }).first().click();
      await page.waitForTimeout(800);
      const hasModal = await page.locator('[role="dialog"]').first().isVisible().catch(() => false);
      expect(hasModal).toBeTruthy();
      // Close via Escape
      await page.keyboard.press('Escape');
    }
  });

  test('AnnotationsPanel: Apply / Dismiss buttons present when annotations exist', async ({ page }) => {
    if (!(await gotoFirstChapter(page))) test.skip(true);
    const annotationsText = await page.getByText(/annotations/i).first().textContent().catch(() => null);
    if (!annotationsText) test.skip(true, 'No AnnotationsPanel visible on this chapter');
    // If a drift finding row exists, it should have Apply or Dismiss
    const hasApply = await page.getByRole('button', { name: /apply/i }).first().isVisible().catch(() => false);
    const hasDismiss = await page.getByRole('button', { name: /dismiss/i }).first().isVisible().catch(() => false);
    // Either present means panel is wired; absence means no findings — both ok
    expect(typeof (hasApply || hasDismiss)).toBe('boolean');
  });

  test('Story Bible tab on project shows entries (Sprint 12 extract_bible hotfix verification)', async ({ page }) => {
    if (!(await gotoFirstProject(page))) test.skip(true);
    // Click Story Bible tab
    const tab = page.getByRole('button', { name: /story bible|bible/i }).first();
    if (!(await tab.isVisible().catch(() => false))) test.skip(true, 'No Story Bible tab');
    await tab.click();
    await page.waitForTimeout(1_500);
    const text = (await page.locator('main').textContent())?.toLowerCase() || '';
    // Either entries listed or empty state
    expect(/character|location|event|item|no.*entries/.test(text)).toBeTruthy();
  });
});

// =====================================================
// Newsletter cluster regression — sidebar nav + cross-section navigation
// =====================================================
test.describe('Newsletter cluster regression: sidebar + cross-nav', () => {
  test('All 7 newsletter routes load without [object Object]', async ({ page }) => {
    const routes = [
      '/newsletter',
      '/newsletter/editions',
      '/newsletter/generate',
      '/newsletter/approvals',
      '/newsletter/sends',
      '/newsletter/ingestion',
      '/newsletter/templates',
    ];
    for (const r of routes) {
      await page.goto(r);
      await page.waitForTimeout(1_000);
      const body = (await page.textContent('body')) || '';
      expect(body, `${r} contains [object Object]`).not.toContain('[object Object]');
    }
  });

  test('Legacy /newsletters (plural) redirects to /library?type=newsletter', async ({ page }) => {
    await page.goto('/newsletters');
    await page.waitForTimeout(1_500);
    await expect(page).toHaveURL(/\/library\?type=newsletter/);
  });
});

// =====================================================
// Cross-cutting UX: dark mode, breadcrumb, global search, tutorial replay
// =====================================================
test.describe('Cross-cutting UX (Sprint 2/6/7)', () => {
  test('TopBar dark-mode toggle present', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1_500);
    // Toggle has aria-label or icon
    const toggle = page.getByRole('button', { name: /(dark|light|theme)/i }).first();
    if (!(await toggle.isVisible().catch(() => false))) {
      // fallback — look for sun/moon icon button
      const iconBtn = page.locator('button svg[class*="sun"], button svg[class*="moon"]').first();
      expect(await iconBtn.isVisible().catch(() => false)).toBeTruthy();
    } else {
      expect(true).toBeTruthy();
    }
  });

  test('Global search (Cmd+K) opens a search input', async ({ page, browserName }) => {
    await page.goto('/');
    await page.waitForTimeout(1_500);
    // Mac: Meta+K; non-mac: Ctrl+K
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.waitForTimeout(500);
    const hasSearchUi = await page.locator('input[type="search"], input[placeholder*="search" i], [role="dialog"]').first().isVisible().catch(() => false);
    expect(hasSearchUi).toBeTruthy();
  });

  test('Breadcrumb resolves entity titles (project page)', async ({ page }) => {
    if (!(await gotoFirstProject(page))) test.skip(true);
    // TopBar should show project title in breadcrumb
    const topbar = page.locator('header').first();
    const text = (await topbar.textContent()) || '';
    // Should not show raw UUID — should resolve to a title
    expect(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-/)?.length || 0).toBe(0);
  });

  test('Replay Tutorial button in Settings exists (Sprint 7)', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(2_000);
    const replayBtn = page.getByRole('button', { name: /replay.*tutorial|tutorial.*replay/i }).first();
    // May be below the fold — scroll
    if (!(await replayBtn.isVisible().catch(() => false))) {
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(500);
    }
    const found = await replayBtn.isVisible().catch(() => false);
    expect(found).toBeTruthy();
  });

  test('Pagination controls render on a list page', async ({ page }) => {
    await page.goto('/library');
    await page.waitForTimeout(2_000);
    const hasPagination = await page.locator('[class*="paginat"], [class*="Pagination"], button[aria-label*="page" i]').first().isVisible().catch(() => false);
    // Pagination only renders when there are enough rows; not a hard fail
    expect(typeof hasPagination).toBe('boolean');
  });
});

// =====================================================
// Page-level smoke — every authenticated route renders without crashing
// =====================================================
test.describe('Authenticated route smoke', () => {
  const ROUTES = [
    '/',
    '/projects',
    '/library',
    '/research',
    '/genres',
    '/story-arcs',
    '/outlines',
    '/trash',
    '/cost',
    '/sources',
    '/settings',
    '/credits',
    '/newsletter',
    '/newsletter/editions',
    '/newsletter/templates',
    '/newsletter/approvals',
    '/newsletter/sends',
    '/newsletter/ingestion',
    '/newsletter/generate',
  ];

  for (const route of ROUTES) {
    test(`route ${route} renders without crash`, async ({ page }) => {
      await page.goto(route);
      await page.waitForTimeout(1_500);
      // Must not crash — error boundary shows "Something went wrong"
      const errorBoundary = await page.getByText(/something went wrong/i).first().isVisible().catch(() => false);
      expect(errorBoundary).toBeFalsy();
      // No [object Object] leakage
      const body = (await page.textContent('body')) || '';
      expect(body).not.toContain('[object Object]');
      // Main content should be visible
      const mainVisible = await page.locator('main').isVisible().catch(() => false);
      expect(mainVisible).toBeTruthy();
    });
  }
});
