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
  // tsup bundles its config next to it while it builds; lint can run at the same time.
  '**/*.bundled_*.mjs',
];

const RESTRICTED_PATTERNS = [
  {
    group: ['@smp/*/**'],
    message: 'Deep imports are not allowed. Import from the package entry point (@smp/<name>).',
  },
];
const RESTRICTED_PATHS = [
  {
    name: '@smp/db',
    importNames: ['createSystemPrismaClient'],
    message:
      'The system client bypasses row-level security. Wire it up in src/infrastructure and use it only in @SystemScope() methods.',
  },
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
        // Nest modules and decorated providers are classes without members on purpose.
        '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
        'import-x/no-cycle': 'error',
        'no-console': 'error',
        'no-restricted-imports': ['error', { paths: RESTRICTED_PATHS, patterns: RESTRICTED_PATTERNS }],
      },
    },
    {
      // The system client is wired up in the infrastructure layer only (guide step 1.3).
      files: ['**/src/infrastructure/**'],
      rules: { 'no-restricted-imports': ['error', { patterns: RESTRICTED_PATTERNS }] },
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
