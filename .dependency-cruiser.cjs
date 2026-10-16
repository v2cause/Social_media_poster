/** Architecture rules from docs/ARCHITECTURE.md, section 2.1. Checked in CI by `pnpm check:deps`. */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Modules must not depend on each other in a cycle.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-do-not-import-apps',
      severity: 'error',
      comment: 'Apps depend on packages, never the other way round.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'core-is-framework-free',
      severity: 'error',
      comment: 'The core context may depend only on zod and uuidv7 from npm. Tests may use vitest.',
      from: { path: '^packages/core/', pathNot: '^packages/core/test/|\\.test\\.ts$' },
      // pnpm resolves packages into node_modules/.pnpm/<name>@<version>/node_modules/<name>.
      to: {
        path: '^node_modules/',
        pathNot: ['^node_modules/(zod|uuidv7)/', '^node_modules/\\.pnpm/(zod|uuidv7)@'],
      },
    },
    {
      name: 'domain-imports-nothing',
      severity: 'error',
      comment: 'Domain code stays pure: it imports nothing from its own context either.',
      from: { path: '^packages/core/src/[^/]+/domain/' },
      to: { pathNot: '^packages/core/src/[^/]+/domain/' },
    },
    {
      name: 'application-uses-domain-and-ports-only',
      severity: 'error',
      comment: 'Use cases depend on the domain and on ports, never on adapters or other layers.',
      from: { path: '^packages/core/src/[^/]+/application/' },
      to: {
        path: '^packages/core/src/[^/]+/',
        pathNot: '^packages/core/src/[^/]+/(domain|ports|application)/',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|\\.next|generated|out|coverage)/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['types', 'module', 'main'],
      conditionNames: ['import', 'require', 'types', 'default'],
    },
  },
};
