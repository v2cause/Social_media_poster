import { baseVitestConfig } from '@smp/config/vitest';
import { mergeConfig } from 'vitest/config';

// Runs Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE or the browser of Playwright) and Redis
// (Testcontainers), so the files run one after another.
export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
