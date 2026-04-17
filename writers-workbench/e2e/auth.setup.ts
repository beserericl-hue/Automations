import { test as setup, expect } from '@playwright/test';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '.auth', 'user.json');

/**
 * Logs in via the UI and saves the auth state for reuse by all tests.
 *
 * Requires E2E_TEST_EMAIL and E2E_TEST_PASSWORD env vars.
 * If not set, tests that require auth will be skipped.
 */
setup('authenticate', async ({ page }) => {
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;

  if (!email || !password) {
    console.warn('E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping auth setup. Authenticated tests will be skipped.');
    // Save empty storage state so dependent tests know auth is unavailable
    await page.context().storageState({ path: AUTH_FILE });
    return;
  }

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Wait for redirect to dashboard after successful login
  await page.waitForURL('/', { timeout: 15_000 });
  await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 10_000 });

  // Save signed-in state
  await page.context().storageState({ path: AUTH_FILE });
});
