import { test, expect } from '@playwright/test';
import { seedProject, deleteProject } from '../pages/api';

/**
 * TopBar (client/src/components/layout/TopBar.tsx) — RESULT-asserting.
 *
 * Covers every interactive element in the global top chrome EXCEPT sign-out (that ends the session and
 * lives in topbar-signout.spec.ts so it can't strand the shared auth state for other tests):
 *   - Search toggle button + Cmd+K open the search panel
 *   - Typing a unique seeded title returns a result that navigates to /projects/:id (URL asserted)
 *   - Dark-mode toggle flips <html>.dark BOTH directions
 *   - Chat toggle opens the ChatDrawer
 *   - User menu opens → Settings link navigates to /settings
 *   - Breadcrumb Home link → /
 *
 * Runs against DEV (E2E_BASE_URL) with the shared authenticated session.
 */

const searchBtn = 'button[title="Search (Cmd+K)"]';
const chatBtn = 'button[title="Chat with Author Agent"]';
const darkToggle = 'header button[aria-label^="Switch to"]';

test.describe('TopBar (result-asserting)', () => {
  test('Search toggle button opens the search panel', async ({ page }) => {
    await page.goto('/');
    await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });

    const input = page.getByPlaceholder('Search projects, content, research...');
    await expect(input).toBeHidden();
    await page.locator(searchBtn).click();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toBeFocused();
  });

  test('Cmd+K opens the search panel', async ({ page }) => {
    await page.goto('/');
    await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });

    const input = page.getByPlaceholder('Search projects, content, research...');
    await expect(input).toBeHidden();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(input).toBeVisible({ timeout: 10_000 });
  });

  test('searching a seeded project returns a result that navigates to /projects/:id', async ({ page }) => {
    const title = `E2E TopBar Search ${Date.now()}`;
    const projectId = await seedProject({ title });
    try {
      await page.goto('/');
      await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });

      await page.locator(searchBtn).click();
      const input = page.getByPlaceholder('Search projects, content, research...');
      await expect(input).toBeVisible({ timeout: 10_000 });
      await input.fill(title);

      // The result button carries the seeded title; clicking it must navigate to the project detail page.
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const result = page.getByRole('button', { name: new RegExp(escaped) });
      await expect(result.first()).toBeVisible({ timeout: 15_000 });
      await result.first().click();

      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`), { timeout: 15_000 });
    } finally {
      await deleteProject(projectId);
    }
  });

  test('Dark-mode toggle flips <html>.dark in BOTH directions', async ({ page }) => {
    await page.goto('/');
    await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });

    const html = page.locator('html');
    const isDark = async () => ((await html.getAttribute('class')) ?? '').includes('dark');
    const toggle = page.locator(darkToggle);

    const before = await isDark();
    await toggle.click();
    await expect.poll(isDark, { timeout: 5_000, message: 'first toggle did not flip <html>.dark' }).toBe(!before);
    await toggle.click();
    await expect.poll(isDark, { timeout: 5_000, message: 'second toggle did not restore <html>.dark' }).toBe(before);
  });

  test('Chat toggle opens the ChatDrawer', async ({ page }) => {
    await page.goto('/');
    await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });

    // The drawer heading is always mounted; the panel just translates off-screen (translate-x-full) when
    // closed. The reliable "open" signals are: the modal backdrop overlay mounts (open && <div .../>) and
    // the panel gets translate-x-0. Assert the closed→open transition via both.
    const panel = page.locator('div.fixed.right-0.top-0', { hasText: 'Chat with Author Agent' }).first();
    const overlay = page.locator('div.fixed.inset-0.z-40.bg-black\\/20');
    await expect(panel).toHaveClass(/translate-x-full/);
    await expect(overlay).toHaveCount(0);

    await page.locator(chatBtn).click();

    await expect(panel).toHaveClass(/translate-x-0/, { timeout: 10_000 });
    await expect(overlay).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 10_000 });
  });

  test('User menu opens → Settings link navigates to /settings', async ({ page }) => {
    await page.goto('/');
    await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });

    // The user-menu trigger is the last button on the right (avatar + display name). Open the menu.
    const userBtn = page.locator('header').getByRole('button').last();
    await userBtn.click();
    const settings = page.locator('header').getByRole('link', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible({ timeout: 10_000 });
    await settings.click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 15_000 });
  });

  test('Breadcrumb Home link navigates to /', async ({ page }) => {
    // Start on a non-root route so navigating Home is a real transition.
    await page.goto('/settings');
    await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });

    const home = page.locator('header nav').getByRole('link', { name: 'Home', exact: true });
    await expect(home).toBeVisible({ timeout: 10_000 });
    await home.click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  });
});
