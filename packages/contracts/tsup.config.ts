import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2023',
  outDir: 'dist',
  // The legal texts under src/legal/ are bundled as strings; nothing reads files at runtime.
  loader: { '.md': 'text' },
});
