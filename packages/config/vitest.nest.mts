import swc from 'unplugin-swc';
import { defineConfig, mergeConfig } from 'vitest/config';

// The package refers to its own public entry point. This is the one place where that is intended.
// eslint-disable-next-line no-restricted-imports
import { baseVitestConfig } from '@smp/config/vitest';

/**
 * Vitest preset for NestJS packages. Vitest uses esbuild, which does not emit
 * the decorator metadata that Nest needs for dependency injection; SWC does.
 */
export const nestVitestConfig = defineConfig(
  mergeConfig(baseVitestConfig, {
    plugins: [swc.vite({ module: { type: 'es6' } })],
  }),
);

export default nestVitestConfig;
