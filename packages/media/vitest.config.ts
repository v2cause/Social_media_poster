import { baseVitestConfig } from '@smp/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // sharp encodes 12-megapixel photos here; next to other suites on a busy runner that takes
    // longer than the default of five seconds.
    testTimeout: 30_000,
  },
});
