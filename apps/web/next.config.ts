import { resolve } from 'node:path';

import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Next.js reads .env files from the app directory only. The single .env lives in the repo root.
loadEnvConfig(resolve(process.cwd(), '../..'));

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@smp/ui', '@smp/api-client', '@smp/contracts', '@smp/platform-rules'],
  // Local development only. In production a reverse proxy routes /api directly to the API.
  rewrites() {
    return Promise.resolve([
      {
        source: '/api/:path*',
        destination: `${process.env['API_INTERNAL_URL'] ?? 'http://127.0.0.1:3001'}/api/:path*`,
      },
    ]);
  },
};

export default withNextIntl(config);
