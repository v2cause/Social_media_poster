import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node24',
  outDir: 'dist',
  // The prompt files under prompts/ are bundled as strings; nothing reads them at runtime.
  loader: { '.md': 'text' },
});
