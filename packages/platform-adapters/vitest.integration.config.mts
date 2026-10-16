import { baseVitestConfig } from '@smp/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
