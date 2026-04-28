import { test as setup, expect } from '@playwright/test';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '.auth', 'user.json');

/**
 * Logs in and saves the auth state for reuse by all tests.
 *
 * Two paths:
 *   1. Default (local dev) — drives the actual UI login form.
 *   2. Remote capture (E2E_BASE_URL set) — calls Supabase password-grant
 *      directly and seeds localStorage. PROD/DEV bundles sometimes can't
 *      reach Supabase from headless Chromium ("Failed to fetch") even though
 *      the same fetch works from a real browser; the API path is more
 *      reliable for screenshot capture against deployed URLs.
 *
 * Requires E2E_TEST_EMAIL and E2E_TEST_PASSWORD env vars.
 */
setup('authenticate', async ({ page }) => {
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;

  if (!email || !password) {
    console.warn('E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping auth setup. Authenticated tests will be skipped.');
    await page.context().storageState({ path: AUTH_FILE });
    return;
  }

  if (process.env.E2E_BASE_URL) {
    await authenticateViaApi(page, email, password);
  } else {
    await authenticateViaUi(page, email, password);
  }

  await page.context().storageState({ path: AUTH_FILE });
});

async function authenticateViaUi(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  // exact: true — the password show/hide toggle button's aria-label is
  // "Show password" / "Hide password", which would otherwise match too.
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForURL('/', { timeout: 15_000 });
  await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 10_000 });
}

async function authenticateViaApi(page: import('@playwright/test').Page, email: string, password: string) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set for API auth path');
  }

  // Token grant via Supabase REST.
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Supabase password grant failed: ${res.status} ${await res.text()}`);
  }
  const session = await res.json();

  // supabase-js stores the session under sb-<projectRef>-auth-token in
  // localStorage. Use addInitScript so the value is written BEFORE any of
  // the bundle's JS runs (otherwise GoTrueClient's _initialize fires first
  // with an empty localStorage and the seed arrives too late to be read).
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  const storageKey = `sb-${projectRef}-auth-token`;
  const sessionJson = JSON.stringify(session);
  await page.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // localStorage may be unavailable on about:blank; will succeed on real navigation
      }
    },
    { key: storageKey, value: sessionJson },
  );
  await page.goto('/');
  await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 15_000 });
}
