import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { config } from 'dotenv';

config(); // Load .env into process.env

const AUTH_FILE = path.join(__dirname, 'e2e', '.auth', 'user.json');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
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
      testMatch: /authenticated\.spec\.ts|sprint3-crud\.spec\.ts|sprint5-observability\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_FILE,
      },
    },
    // Firefox — unauthenticated only (authenticated covered by chromium)
    {
      name: 'firefox',
      testMatch: /login\.spec\.ts|sprint2-navigation\.spec\.ts/,
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  webServer: {
    command: 'npm run dev:client',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
