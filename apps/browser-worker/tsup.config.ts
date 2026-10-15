import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  sourcemap: true,
  clean: true,
  target: 'node24',
  outDir: 'dist',
});
