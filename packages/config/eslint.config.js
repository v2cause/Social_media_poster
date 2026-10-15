'use strict';

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const importX = require('eslint-plugin-import-x');
const globals = require('globals');

const TS_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const JS_FILES = ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'];
const WEB_FILES = ['**/*.tsx', '**/*.jsx'];
const IGNORES = [
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/node_modules/**',
  '**/src/generated/**',
];

// import-x only knows plain JavaScript extensions by default. Without the TypeScript ones,
// import-no-cycle never sees the imports between .ts files.
const importResolver = importX.createNodeResolver({
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
  // NodeNext-style specifiers such as "./b.js" point at TypeScript sources.
  extensionAlias: { '.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs'], '.cjs': ['.cts', '.cjs'] },
});

/**
 * Builds the flat ESLint config that every workspace package uses.
 *
 * @param {{ tsconfigRootDir: string, typed?: boolean, web?: boolean }} options
 *   typed: enable type-aware rules (needs a tsconfig for each linted file)
 *   web: add React and Next.js rules for .tsx and .jsx files
 */
function createEslintConfig({ tsconfigRootDir, typed = true, web = false }) {
  // These rules need type information, so they are only enabled for typed linting.
  const typeAwareRules = typed
    ? {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
      }
    : {};

  const config = tseslint.config(
    { ignores: IGNORES },
    js.configs.recommended,
    {
      files: JS_FILES,
      languageOptions: { globals: globals.node },
    },
    {
      files: TS_FILES,
      extends: [typed ? tseslint.configs.strictTypeChecked : tseslint.configs.strict],
      languageOptions: typed ? { parserOptions: { projectService: true, tsconfigRootDir } } : {},
      plugins: { 'import-x': importX },
      settings: {
        'import-x/extensions': ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
        'import-x/resolver-next': [importResolver],
      },
      rules: {
        ...typeAwareRules,
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
        ],
        'import-x/no-cycle': 'error',
        'no-console': 'error',
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@smp/*/**'],
                message: 'Deep imports are not allowed. Import from the package entry point (@smp/<name>).',
              },
            ],
          },
        ],
      },
    },
    {
      // Tool configuration files may load other workspace presets by subpath.
      files: ['**/*.config.*', '**/eslint.config.*'],
      rules: { 'no-restricted-imports': 'off' },
    },
  );

  if (web) {
    const reactHooks = require('eslint-plugin-react-hooks');
    const nextPlugin = require('@next/eslint-plugin-next');
    config.push({
      files: WEB_FILES,
      languageOptions: { globals: globals.browser },
      plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
      rules: {
        ...reactHooks.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
      },
    });
  }

  return config;
}

module.exports = createEslintConfig;
