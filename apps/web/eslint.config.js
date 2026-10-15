'use strict';

const createEslintConfig = require('@smp/config/eslint');

module.exports = createEslintConfig({ tsconfigRootDir: __dirname, web: true });
