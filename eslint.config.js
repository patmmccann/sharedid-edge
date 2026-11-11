import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', 'packages/adapters/*/deploy/**', 'packages/adapters/*/deploy-bowser/**', 'packages/adapters/*/dist-bowser/**', 'packages/adapters/*/deploy-vendor/**', 'packages/adapters/*/.sharedid-modules/**', 'packages/adapters/*/dist-snippet/**', 'packages/adapters/vercel/example/**', '**/.tsbuild/**', '**/.wrangler/**', '**/node_modules/**', 'e2e/**', 'website/**', 'consumer-types/**', '**/worker-configuration.d.ts']
  },
  js.configs.recommended,
  // The strictest type-aware presets: no `any` leaks, no floating promises, no unnecessary conditions.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'scripts/*.mjs', 'packages/*/vitest.config.ts', 'packages/*/*/vitest.config.ts', 'conformance/vitest.config.ts'],
          // One default project per package's vitest.config.ts.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 32
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true, allowTypedFunctionExpressions: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-boolean-expressions': ['error', { allowString: false, allowNumber: false, allowNullableObject: true }],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: 'error'
    }
  },
  {
    // The CLIs and runners print to stdout by design.
    files: ['packages/adapters/node/src/cli.ts', 'conformance/src/**', 'scripts/**', 'packages/*/*/scripts/**'],
    rules: { 'no-console': 'off' }
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked
  },
  {
    // JavaScript can't carry type annotations.
    files: ['**/*.js', '**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off'
    }
  },
  {
    // Build scripts run on Node.
    files: ['scripts/*.mjs', 'packages/*/*/scripts/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Request: 'readonly' } }
  }
);
