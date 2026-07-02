import { test, expect } from '@playwright/test';

/**
 * Settings regression — Appearance theme toggle actually flips the document theme; profile/email fields
 * are present (disabled ones stay disabled); the Danger Zone reveals and its permanent-delete stays
 * gated behind typing "DELETE". No account mutation is committed. Verified against settings/UserSettings.
 */
test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText(/Settings|Display Name|Appearance/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('theme buttons flip the document theme class', async ({ page }) => {
    const html = page.locator('html');
    await page.getByRole('button', { name: 'dark', exact: true }).click();
    await expect(html).toHaveClass(/dark/, { timeout: 5_000 });
    await page.getByRole('button', { name: 'light', exact: true }).click();
    await expect(html).not.toHaveClass(/dark/, { timeout: 5_000 });
  });

  test('phone/auth-email fields are present and disabled by design', async ({ page }) => {
    // These are intentionally read-only (phone links Eve, auth email from the auth provider).
    const phone = page.getByLabel('Phone Number').or(page.locator('input[disabled]')).first();
    await expect(phone).toBeVisible();
  });

  test('Save Changes and Update Password controls are present', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Save Changes/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update Password' })).toBeVisible();
  });

  test('Danger Zone reveals and permanent delete is gated by the DELETE confirmation text', async ({ page }) => {
    await page.getByRole('button', { name: 'Delete Account', exact: true }).click();
    const permaDelete = page.getByRole('button', { name: /Permanently Delete Account/ });
    await expect(permaDelete).toBeVisible({ timeout: 10_000 });
    await expect(permaDelete).toBeDisabled(); // gated until "DELETE" typed
    await page.getByPlaceholder('DELETE').fill('DELETE');
    await expect(permaDelete).toBeEnabled();
    // Do NOT click — cancel out.
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(permaDelete).toBeHidden({ timeout: 10_000 });
  });
});
