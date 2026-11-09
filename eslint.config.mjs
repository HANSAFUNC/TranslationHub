import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config. Correctness rules plus a few hygiene rules.
 * Type-aware linting is handled separately by `pnpm typecheck` (tsc --noEmit).
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      'LocaleHub_Agent_开发交付包/**',
      '.demo-workspace*/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortSignal: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        global: 'readonly',
        React: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Vendored shadcn/ui registry files: kept byte-identical to upstream so that
    // `shadcn add --diff` stays clean. They are already reviewed upstream.
    files: ['apps/web/src/components/ui/**/*.tsx'],
    rules: {
      eqeqeq: 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
