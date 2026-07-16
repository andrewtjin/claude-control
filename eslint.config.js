// Flat ESLint config for the whole workspace.
// Rationale: type-aware linting catches the async/credential-handling mistakes that
// plain lint misses, but we scope it to package src/ so config files stay lint-light.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/*.tsbuildinfo', 'coverage/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused vars are errors, but allow the `_`-prefix escape hatch for intentional gaps.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Floating promises are the daemon's #1 latent-bug source (fire-and-forget IO).
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Credentials/JSON come in as `unknown`; force explicit narrowing rather than `any` leaks.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Tests exercise error paths and fixtures; relax the strictest ergonomics there.
    files: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
