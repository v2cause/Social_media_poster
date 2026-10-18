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
    // Each package keeps its own module cache. Vitest clears the cache when the lockfile changed,
    // and packages whose tests start at the same time would clear one shared directory at once.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});

export default baseVitestConfig;
