import { nestVitestConfig } from '@smp/config/vitest-nest';
import { mergeConfig } from 'vitest/config';

// Boots the worker against Testcontainers (Redis, Mailpit). SWC emits the decorator metadata
// that Nest's dependency injection needs.
export default mergeConfig(nestVitestConfig, {
  test: {
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
