import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The local core is deliberately framework-agnostic: plain TypeScript, no Nuxt
 * auto-imports, no Vue. That lets it be tested against a real IndexedDB
 * implementation without booting Nuxt, which keeps the suite fast enough to run
 * on every save.
 */
export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: [
      'database/**/*.test.ts',
      'services/**/*.test.ts',
      'utils/**/*.test.ts',
      'api/**/*.test.ts',
      'i18n/**/*.test.ts',
      // Build-time helpers: plain functions, worth the same scrutiny as the
      // code they protect.
      'build/**/*.test.ts',
    ],
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
})
