import createEslintConfig from './eslint.config.js';

// This package's own sources are plain JS and TS without a project graph,
// so the type-aware rules stay off here. Consumers use the typed preset.
export default createEslintConfig({ tsconfigRootDir: import.meta.dirname, typed: false });
