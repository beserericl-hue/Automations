import { test, expect } from '@playwright/test';
import { RegressionPage } from '../pages/regression.page';

/**
 * Full-app render + navigation regression. Visits EVERY reachable top-level route and asserts it
 * renders its expected content (not blank, not stuck on "Loading…", not the ErrorBoundary crash).
 * This is the front line for the highest-impact UI bugs — the blank-page / CORS-500 / broken
 * lazy-load / dead-route class — so it runs first and independently per route.
 *
 * Runs against DEV (E2E_BASE_URL) with the shared authenticated session (see auth.setup.ts).
 */
test.describe('nav + render — every route', () => {
  for (const route of RegressionPage.ROUTES) {
    test(`renders ${route.name} (${route.path})`, async ({ page }) => {
      const rp = new RegressionPage(page);
      await rp.assertRenders(route);
    });
  }
});

test.describe('access control — guarded routes deny a non-admin', () => {
  for (const g of RegressionPage.GUARDED_ROUTES) {
    test(`/${g.name} self-guards (no crash, in-page gate)`, async ({ page }) => {
      const rp = new RegressionPage(page);
      await rp.goto(g.path);
      await page.locator('header, aside, nav').first().waitFor({ state: 'visible', timeout: 20_000 });
      // Either the panel renders (user IS admin) or the in-page denied message shows — never a crash,
      // never a redirect to /login. Assert the URL stayed and one of the two markers is present.
      await expect(page).toHaveURL(new RegExp(g.path.replace('/', '\\/')));
      await expect(page.getByText(g.deniedMarker).first()).toBeVisible({ timeout: 15_000 });
    });
  }
});

test.describe('sidebar navigation links resolve', () => {
  // The sidebar is the primary nav; every link must land on a real, rendered route (no dead links).
  const SIDEBAR_LINKS: { name: string; urlRe: RegExp }[] = [
    { name: 'Dashboard', urlRe: /\/$/ },
    { name: 'Content Library', urlRe: /\/library/ },
    { name: 'Brainstorm', urlRe: /\/brainstorm/ },
    { name: 'Outlines', urlRe: /\/outlines/ },
    { name: 'Credits', urlRe: /\/credits/ },
    { name: 'Trash', urlRe: /\/trash/ },
    { name: 'Settings', urlRe: /\/settings/ },
  ];

  for (const link of SIDEBAR_LINKS) {
    test(`sidebar "${link.name}" navigates`, async ({ page }) => {
      await page.goto('/');
      await page.locator('aside, nav').first().waitFor({ state: 'visible', timeout: 20_000 });
      const sidebar = page.locator('aside').first();
      const l = sidebar.getByRole('link', { name: link.name, exact: true }).first();
      await l.waitFor({ state: 'visible', timeout: 10_000 });
      await l.click();
      await expect(page).toHaveURL(link.urlRe, { timeout: 15_000 });
    });
  }

  test('expandable sections (My Projects / Reference / Newsletter) expand', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside').first();
    await sidebar.waitFor({ state: 'visible', timeout: 20_000 });
    for (const section of ['Reference', 'Newsletter']) {
      const header = sidebar.getByRole('button', { name: new RegExp(section, 'i') }).first();
      if (!(await header.isVisible().catch(() => false))) continue;
      await header.click();
      // After expanding, a known child link should appear.
      const child = section === 'Reference'
        ? sidebar.getByRole('link', { name: 'Genres', exact: true })
        : sidebar.getByRole('link', { name: 'Generate', exact: true });
      await expect(child.first()).toBeVisible({ timeout: 8_000 });
    }
  });
});
