import { baseVitestConfig } from '@smp/config/vitest';
import { mergeConfig } from 'vitest/config';

// Unit tests only; the Playwright specs under e2e/ run with `pnpm test:e2e`.
export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts'],
  },
});
