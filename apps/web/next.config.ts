import { resolve } from 'node:path';

import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

import { SECURITY_HEADERS } from './src/security/content-security-policy';

// Next.js reads .env files from the app directory only. The single .env lives in the repo root.
// Next.js has already loaded (and cached) the environment of the app directory when this file
// runs, so the reload has to be forced; without it the call returns the cache and does nothing.
loadEnvConfig(resolve(process.cwd(), '../..'), process.env['NODE_ENV'] !== 'production', console, true);

// Captured once, so the rewrite does not depend on later reloads of the environment.
const apiInternalUrl = process.env['API_INTERNAL_URL'];

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  // No framework fingerprint in the response headers.
  poweredByHeader: false,
  transpilePackages: ['@smp/ui', '@smp/api-client', '@smp/contracts', '@smp/platform-rules'],
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: [...SECURITY_HEADERS] }]);
  },
  // Local development only. Rewrites are resolved at build time, so the rewrite exists only when
  // API_INTERNAL_URL is set then (from the root .env). Docker builds have no .env and leave it
  // out; there a reverse proxy routes /api directly to the API, as in production.
  rewrites() {
    return Promise.resolve(
      apiInternalUrl ? [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }] : [],
    );
  },
};

export default withNextIntl(config);
