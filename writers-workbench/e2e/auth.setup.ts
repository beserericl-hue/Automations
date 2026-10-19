import { test as setup, expect } from '@playwright/test';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '.auth', 'user.json');

/**
 * Logs in and saves the auth state for reuse by all tests.
 *
 * The product is PASSWORDLESS, so this no longer logs in with a password — there is no password
 * field in the UI and the stored passwords have been rotated to random values precisely so that the
 * Supabase password grant cannot be used as a back door. Driving the real email-code UI here would
 * mean waiting on an inbox in every CI run, so the fixture mints a session the same way the server
 * does and seeds it:
 *
 *   admin.generateLink({type:'magiclink'})  ->  hashed_token (sends no email)
 *   verifyOtp({token_hash})                 ->  a real session
 *
 * That is the identical mechanism `POST /api/auth/otp/verify` uses, so the session this produces is
 * indistinguishable from one a user gets by typing a code. The user-visible code flow is covered
 * separately and deliberately by `auth-otp.spec.ts`, which drives the actual form.
 *
 * Requires E2E_TEST_EMAIL plus SUPABASE_URL, VITE_SUPABASE_ANON_KEY and
 * SUPABASE_SERVICE_ROLE_KEY. (It used E2E_TEST_PASSWORD; that variable is now ignored.)
 */
setup('authenticate', async ({ page }) => {
  const email = process.env.E2E_TEST_EMAIL;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!email || !supabaseUrl || !anonKey || !serviceKey) {
    console.warn(
      'E2E_TEST_EMAIL / SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY not all set' +
        ' — skipping auth setup. Authenticated tests will be skipped.',
    );
    await page.context().storageState({ path: AUTH_FILE });
    return;
  }

  const session = await mintSession({ supabaseUrl, anonKey, serviceKey, email });
  await seedSession(page, supabaseUrl, session);
  await page.context().storageState({ path: AUTH_FILE });
});

/** A genuine Supabase session for `email`, with no password and no email sent. */
async function mintSession(opts: {
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
  email: string;
}): Promise<unknown> {
  const { supabaseUrl, anonKey, serviceKey, email } = opts;

  // generateLink returns the token hash and sends nothing. The link is never used as a link.
  const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!linkRes.ok) {
    throw new Error(`generate_link failed: ${linkRes.status} ${await linkRes.text()}`);
  }
  const link = (await linkRes.json()) as { hashed_token?: string };
  if (!link.hashed_token) throw new Error('generate_link returned no hashed_token');

  // Exchanged on the ANON key: the service key bypasses auth and would not yield a user session.
  const verifyRes = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.hashed_token }),
  });
  if (!verifyRes.ok) {
    throw new Error(`verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
  }
  return await verifyRes.json();
}

async function seedSession(
  page: import('@playwright/test').Page,
  supabaseUrl: string,
  session: unknown,
) {
  // supabase-js stores the session under sb-<projectRef>-auth-token in localStorage. addInitScript
  // so the value is written BEFORE the bundle's JS runs — otherwise GoTrueClient's _initialize
  // fires first against an empty localStorage and the seed arrives too late to be read.
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  const storageKey = `sb-${projectRef}-auth-token`;
  const sessionJson = JSON.stringify(session);
  await page.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // localStorage may be unavailable on about:blank; it will succeed on real navigation
      }
    },
    { key: storageKey, value: sessionJson },
  );
  await page.goto('/');
  await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 15_000 });
}
