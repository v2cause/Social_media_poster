import { baseVitestConfig } from '@smp/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseVitestConfig, {
  test: {
    include: ['src/**/*.test.ts'],
  },
});
