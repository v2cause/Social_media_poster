import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest preset. Each package extends it in its own vitest.config.ts.
 *
 * `passWithNoTests` keeps `pnpm test` green in packages whose test suites are
 * still to be written. Use cases must still get unit tests (see the guide, B.1).
 */
export const baseVitestConfig = defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});

export default baseVitestConfig;
