import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { config } from 'dotenv';

config(); // Load .env into process.env

const AUTH_FILE = path.join(__dirname, 'e2e', '.auth', 'user.json');

// E2E_BASE_URL overrides the local dev server target. Used to capture user-
// manual screenshots against PROD/DEV without spinning up a local Vite server.
// When set, the local webServer block is skipped so Playwright doesn't try
// to npm run dev:client.
const REMOTE_BASE_URL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: REMOTE_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Headless Chromium's default UA contains "HeadlessChrome" which some
    // edge layers (Cloudflare etc.) treat as a bot and block. When capturing
    // against deployed URLs, present as a regular Chrome desktop.
    ...(REMOTE_BASE_URL
      ? {
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        }
      : {}),
  },
  projects: [
    // Auth setup — runs first, saves session state
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    // Unauthenticated tests (login page, redirects)
    {
      name: 'chromium-noauth',
      testMatch: /login\.spec\.ts|sprint2-navigation\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Authenticated tests — depend on setup, reuse saved auth state
    {
      name: 'chromium',
      testMatch: /authenticated\.spec\.ts|sprint3-crud\.spec\.ts|sprint5-observability\.spec\.ts|sprint7-critical-paths\.spec\.ts|qa-button-verify\.spec\.ts|image-debug\.spec\.ts|chapter-outline-version\.spec\.ts|capture-manual-screenshots\.spec\.ts|newsletter-fullflow\.spec\.ts|sprint-regression-suite\.spec\.ts|video-broll\.spec\.ts|regression\/.*\.spec\.ts/,
      // Sign-out revokes the SHARED Supabase session server-side, which 401s every other authenticated
      // test in the same run. It's verified in its own dedicated 'signout' project (runs last, re-mints).
      testIgnore: /regression\/topbar-signout\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_FILE,
      },
    },
    // Sign-out — isolated project (revokes the shared Supabase session, so it must NOT run alongside
    // other authenticated tests). Run explicitly: `npx playwright test --project=signout`.
    {
      name: 'signout',
      testMatch: /regression\/topbar-signout\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_FILE },
    },
    // Firefox — unauthenticated only (authenticated covered by chromium)
    {
      name: 'firefox',
      testMatch: /login\.spec\.ts|sprint2-navigation\.spec\.ts/,
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  ...(REMOTE_BASE_URL
    ? {}
    : {
        // Two-process startup: Vite on 5173 (served to the browser) AND the
        // Express server on 3001 (Vite proxies /api/* to it). Without Express
        // running, anything that hits /api/health / /api/credits returns 404
        // from Vite's catch-all and the authenticated suite breaks.
        webServer: [
          {
            command: 'npm run dev:client',
            url: 'http://localhost:5173',
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
          },
          {
            command: 'npm run dev:server',
            url: 'http://localhost:3001/api/health',
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
          },
        ],
      }),
});
