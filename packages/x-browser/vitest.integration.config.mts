import { baseVitestConfig } from '@smp/config/vitest';
import { mergeConfig } from 'vitest/config';

// Runs the flows in Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE or the browser of Playwright)
// against the DOM fixtures of test/fixtures.
export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
