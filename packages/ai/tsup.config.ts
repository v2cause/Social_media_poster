import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // The eval CLI (guide step 2.10), with the prompts bundled exactly like the package.
    'eval/run-eval': 'eval/run-eval.ts',
  },
  format: ['cjs'],
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  target: 'node24',
  outDir: 'dist',
  // The prompt files under prompts/ are bundled as strings; nothing reads them at runtime.
  loader: { '.md': 'text' },
  // Only the eval CLI reads the price book from the database; the package never imports @smp/db.
  external: ['@smp/db'],
});
