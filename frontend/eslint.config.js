import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint flat config for the frontend.
 *
 * `eslint:recommended` plus the standard browser global set. The rules that
 * matter here are the ones that catch real bugs: undefined identifiers,
 * duplicate object keys, and comparisons that can never be true. Style rules
 * stay off so the linter reports problems rather than opinions.
 */
export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'public/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.jsx'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      // Stale closures and mutating state during render are the two bugs this
      // codebase is most exposed to, so the hooks rules are worth their noise.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
