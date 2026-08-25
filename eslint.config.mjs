import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * Workspace lint rules.
 *
 * Beyond ordinary hygiene, a few rules encode architectural invariants that are
 * otherwise only enforced by review (see docs/architecture.md §2):
 *  - no `localStorage` for domain data (product spec §85)
 *  - no plan-id branching in the UI (product spec §45)
 *  - no `console` in shipped code paths
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/coverage/**',
      'pnpm-lock.yaml',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message:
            'Domain data belongs in IndexedDB (docs/local-first.md §9). Only tiny UI preferences may use localStorage, with an explicit eslint-disable and a comment.',
        },
      ],
    },
  },

  // Vue single-file components
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
    },
    rules: {
      // Nuxt auto-imports and single-word page names are idiomatic here.
      'vue/multi-word-component-names': 'off',
      // TypeScript already resolves identifiers, and Nuxt auto-imports mean
      // `no-undef` produces only false positives inside SFCs.
      'no-undef': 'off',
    },
  },

  // The UI must never branch on a plan id; it asks FeatureAccessService.
  {
    files: ['apps/web/**/*.{ts,vue}'],
    ignores: ['apps/web/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'BinaryExpression[operator=/^[=!]==?$/] > Literal[value=/^(free|pro|business)$/]',
          message:
            'Do not branch on a plan id (product spec §45). Use useFeatureAccess().canUse(<feature>).',
        },
      ],
    },
  },

  // Tests may be noisier.
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  prettier,
)
