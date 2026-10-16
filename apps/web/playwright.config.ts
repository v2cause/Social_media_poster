import { defineConfig, devices } from '@playwright/test';

// End-to-end tests against the running stack (guide step 1.9): `docker compose up -d --wait`,
// `pnpm db:migrate`, `pnpm build`, then API, worker (role notify) and web. Locally start them
// yourself and run `pnpm test:e2e`; E2E_BASE_URL points elsewhere if needed.
//
// The browser comes from the environment: PLAYWRIGHT_CHROMIUM_EXECUTABLE for a preinstalled
// Chromium, else Playwright's own download.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    // The API accepts writes only from APP_URL, so the host name must match it exactly.
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:3000',
    locale: 'de-DE',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: executablePath ? { executablePath } : {} },
    },
  ],
});
