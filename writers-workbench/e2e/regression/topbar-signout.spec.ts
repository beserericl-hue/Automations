import { test, expect } from '@playwright/test';

/**
 * TopBar sign-out — RESULT-asserting, ISOLATED.
 *
 * Sign-out ends the session (clears Supabase auth) so it MUST live in its own file: after it runs, the
 * shared authenticated storage state in this browser context is gone. Playwright gives each test file a
 * fresh context seeded from the saved auth state, so isolating it here prevents the logout from stranding
 * other authenticated specs.
 *
 * Asserts the REAL result: the User menu → Sign out redirects to /login and the auth landing renders.
 */
test.describe('TopBar sign-out (isolated — ends the session)', () => {
  test('User menu → Sign out logs out and redirects to /login', async ({ page }) => {
    await page.goto('/');
    await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });

    // Open the user menu (last button on the top-right: avatar + display name).
    await page.locator('header').getByRole('button').last().click();
    const signOut = page.locator('header').getByRole('button', { name: 'Sign out', exact: true });
    await expect(signOut).toBeVisible({ timeout: 10_000 });
    await signOut.click();

    // Session cleared → app routes an unauthenticated user to /login.
    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: /sign in/i }).first()).toBeVisible({ timeout: 15_000 });
  });
});
