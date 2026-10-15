import swc from 'unplugin-swc';
import { defineConfig, mergeConfig } from 'vitest/config';

import { baseVitestConfig } from './vitest.base.mjs';

/**
 * Vitest preset for NestJS packages. Vitest uses esbuild, which does not emit
 * the decorator metadata that Nest needs for dependency injection; SWC does.
 */
export const nestVitestConfig = defineConfig(
  mergeConfig(baseVitestConfig, {
    plugins: [swc.vite({ module: { type: 'commonjs' } })],
  }),
);

export default nestVitestConfig;
