import { baseVitestConfig } from '@smp/config/vitest';
import { mergeConfig } from 'vitest/config';

// The unit tests here need no decorator metadata, so the base preset is enough. Tests that
// bootstrap Nest modules with dependency injection use the Nest preset from @smp/config/vitest-nest.
export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
