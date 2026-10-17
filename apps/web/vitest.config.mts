import { fileURLToPath } from 'node:url';

import { baseVitestConfig } from '@smp/config/vitest';
import { mergeConfig } from 'vitest/config';

// Unit tests only; the Playwright specs under e2e/ run with `pnpm test:e2e`. "@/" resolves to
// src/ as in tsconfig.json.
export default mergeConfig(baseVitestConfig, {
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
