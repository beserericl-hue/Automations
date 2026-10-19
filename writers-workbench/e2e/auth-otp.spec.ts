import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

/**
 * The user-visible passwordless login, driven through the actual form.
 *
 * `auth.setup.ts` mints a session directly so the other specs do not wait on an inbox; this spec
 * exists so the thing a real person does — type an email, read a code, type the code — is covered
 * somewhere. It cannot read the user's mail, so it writes a code it already knows the plaintext of
 * straight into `user_login_tokens_v2` with the service key, exactly as `/otp/request` would, and
 * then types it. Everything after that point is the real path: the real form, the real
 * `/otp/verify`, the real session exchange, the real app.
 *
 * Runs unauthenticated (no storageState), because the point is the login screen.
 */

const EMAIL = process.env.E2E_TEST_EMAIL;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const configured = Boolean(EMAIL && SUPABASE_URL && SERVICE_KEY);

/** Put a code we know into the login-token table, the way /otp/request does. */
async function seedCode(email: string, code: string): Promise<void> {
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_login_tokens_v2`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY!,
      authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      email: email.toLowerCase(),
      code_hash: createHash('sha256').update(code, 'utf8').digest('hex'),
      expires_at: expires,
      request_ip: 'e2e',
    }),
  });
  if (!res.ok) throw new Error(`could not seed a login code: ${res.status} ${await res.text()}`);
}

test.describe('passwordless sign-in', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(() => {
    test.skip(!configured, 'Needs E2E_TEST_EMAIL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  });

  test('offers no password field at all', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Forgot password?')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /email me a code/i })).toBeVisible();
  });

  test('asks for a code after an email is submitted', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL!);
    await page.getByRole('button', { name: /email me a code/i }).click();
    await expect(page.getByLabel('6-digit code')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(new RegExp(`sent a code to ${EMAIL}`, 'i'))).toBeVisible();
  });

  test('rejects a wrong code without saying which part was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL!);
    await page.getByRole('button', { name: /email me a code/i }).click();
    await expect(page.getByLabel('6-digit code')).toBeVisible({ timeout: 15_000 });

    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page.getByText(/that code is not valid/i)).toBeVisible({ timeout: 15_000 });
    // Still on the login screen, and the box is cleared for a retype.
    await expect(page.getByLabel('6-digit code')).toHaveValue('');
  });

  test('signs in with a valid code and lands in the app', async ({ page }) => {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL!);
    await page.getByRole('button', { name: /email me a code/i }).click();
    await expect(page.getByLabel('6-digit code')).toBeVisible({ timeout: 15_000 });

    // Seeded AFTER the request, so this is the newest row — which is the one /otp/verify reads.
    await seedCode(EMAIL!, code);

    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: /^sign in$/i }).click();

    await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 30_000 });
  });

  test('a used code cannot be used again', async ({ page }) => {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL!);
    await page.getByRole('button', { name: /email me a code/i }).click();
    await expect(page.getByLabel('6-digit code')).toBeVisible({ timeout: 15_000 });
    await seedCode(EMAIL!, code);
    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 30_000 });

    // Sign out, then try the same code a second time.
    await page.context().clearCookies();
    await page.evaluate(() => window.localStorage.clear());
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL!);
    await page.getByRole('button', { name: /email me a code/i }).click();
    await expect(page.getByLabel('6-digit code')).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page.getByText(/that code is not valid/i)).toBeVisible({ timeout: 15_000 });
  });
});
