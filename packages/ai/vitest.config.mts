import { baseVitestConfig } from '@smp/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseVitestConfig, {
  // Prompt files are imported as text, like the text loader of the tsup build.
  plugins: [
    {
      name: 'prompt-text',
      transform(code: string, id: string) {
        return id.endsWith('.md') ? { code: `export default ${JSON.stringify(code)};`, map: null } : null;
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'eval/**/*.test.ts'],
  },
});
