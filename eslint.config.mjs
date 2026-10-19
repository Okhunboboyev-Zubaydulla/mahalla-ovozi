// ESLint 9 flat config — monorepo baseline (non-type-aware; see plan S1)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';

// Browser + Node globals baseline, kept explicit to avoid an extra dependency.
const globals = {
  window: 'readonly',
  document: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  navigator: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  AbortSignal: 'readonly',
  AbortController: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
};

// Derive jsx-a11y recommended rules, demoted to warnings (non-blocking baseline).
const a11yRules = Object.fromEntries(
  Object.keys(jsxA11y.flatConfigs.recommended.rules ?? {}).map((name) => [name, 'warn']),
);

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '**/stats.*',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/backend/**',
      'tests/e2e/**',
      'apps/web/tests/e2e/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals,
    },
    rules: {
      // TypeScript already reports undefined identifiers; no-undef misfires on type names.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-empty': 'warn',
      'prefer-const': 'warn',
    },
  },
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      ...a11yRules,
    },
  },
  {
    files: ['apps/web/src/**/*.{tsx,jsx}'],
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['**/*.config.{ts,js,mjs}', 'scripts/**/*.{ts,js,mjs}', '**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals, __dirname: 'readonly', require: 'readonly', module: 'readonly' },
    },
  },
);
