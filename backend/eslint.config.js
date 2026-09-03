import js from '@eslint/js';
import globals from 'globals';

/**
 * ESLint flat config for the backend.
 *
 * Deliberately narrow: `eslint:recommended` plus a few rules that catch real
 * bugs in this codebase (undefined identifiers, unused variables, accidental
 * globals). Style rules are off so the linter reports problems rather than
 * opinions.
 */
export default [
  {
    ignores: ['node_modules/**', 'data/**', 'uploads/**', 'dist/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
    },
  },
];
