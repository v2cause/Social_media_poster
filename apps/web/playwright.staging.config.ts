import { defineConfig, devices } from '@playwright/test';

import base from './playwright.config';

// The smoke test of a staging from the production template (guide step 8.9, ADR 0045), from a
// machine that reaches it and its Mailpit (MAILPIT_URL, by default 127.0.0.1:8025 through the
// tunnel of docs/runbooks/deployment.md). The browser sends both names to STAGING_IP directly;
// their certificates come from Caddy's own CA there, which it does not know.
//
//   STAGING_IP=203.0.113.10 pnpm --filter @smp/web exec playwright test -c playwright.staging.config.ts
const domain = process.env['STAGING_DOMAIN'] ?? 'app.smp-staging.test';
const mediaDomain = process.env['STAGING_MEDIA_DOMAIN'] ?? 'media.smp-staging.test';
const ip = process.env['STAGING_IP'] ?? '127.0.0.1';
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  ...base,
  testMatch: 'staging.smoke.ts',
  use: { ...base.use, baseURL: `https://${domain}`, ignoreHTTPSErrors: true },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          ...(executablePath ? { executablePath } : {}),
          args: [`--host-resolver-rules=MAP ${domain} ${ip}, MAP ${mediaDomain} ${ip}`, '--no-proxy-server'],
        },
      },
    },
  ],
});
