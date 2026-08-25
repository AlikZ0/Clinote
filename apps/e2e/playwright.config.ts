/**
 * End-to-end tests (product spec §79, §80).
 *
 * These run against the **built** bundle, not the dev server: the Content
 * Security Policy, the service worker and the precache manifest only exist in a
 * production build, and each of them has already broken the app once in a way
 * no unit test could have caught.
 *
 * The API runs on in-memory adapters. Not to be quick — to be hermetic: a suite
 * that shares a database with a developer's own dev server fails for reasons
 * that have nothing to do with the code.
 */
import { defineConfig, devices } from '@playwright/test'

const API_PORT = 3141
const WEB_PORT = 3142

/**
 * Both on `localhost`, deliberately.
 *
 * The refresh cookie is `SameSite=Strict`, and `127.0.0.1` and `localhost` are
 * different sites to a browser even though they are the same machine. Splitting
 * them here would break session restore in the tests for a reason that has
 * nothing to do with the product — and would hide the real requirement, which
 * is that the API is served same-site with the app (docs/deployment.md §9).
 */
export const API_URL = `http://localhost:${API_PORT}`
export const WEB_URL = `http://localhost:${WEB_PORT}`

export default defineConfig({
  testDir: './tests',
  // Each spec drives its own accounts and its own IndexedDB; nothing is shared,
  // so files can run together.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  /**
   * Capped on purpose, and low.
   *
   * These tests are dominated by key stretching, not by the network: setting up
   * or unlocking encryption runs 600,000 rounds of PBKDF2 *in the browser*, and
   * registration runs Argon2id on the API. Both are slow because they are meant
   * to be. Run four of these at once on a laptop and tests start failing for
   * want of CPU, which teaches nobody anything.
   */
  workers: 2,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Generous, for the same reason the worker count is small: a single unlock
  // is seconds of deliberate work.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    /** The functional suite: every flow, once. */
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    /**
     * The mobile matrix (§80): each phone's viewport and touch settings, which
     * catches layout, tap targets and the bottom navigation — plus the offline
     * core, because that is where a phone differs most.
     *
     * Deliberately not the whole suite three times: running the same account
     * flows again on a narrower screen costs minutes and finds nothing. It is
     * also not Safari, and `docs/testing.md` says what that leaves untested.
     */
    {
      name: 'iphone',
      testMatch: /(mobile|local-first)\.spec\.ts/,
      use: { ...devices['iPhone 14'], browserName: 'chromium' },
    },
    {
      name: 'android',
      testMatch: /(mobile|local-first)\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
  ],

  webServer: [
    {
      command: `node --import tsx ../api/src/server.ts`,
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        TRUST_PROXY: '0',
        LOG_LEVEL: 'silent',
        JWT_SECRET: 'e2e-secret-that-is-long-enough-for-the-schema',
        STORAGE_DRIVER: 'memory',
        /**
         * Object storage is the one dependency a stand-in cannot fake: the
         * device uploads to it directly, so the URL has to be real. MinIO from
         * `pnpm db:up` when it is there, and the backup spec skips when it is
         * not.
         */
        ...(process.env.E2E_S3_ENDPOINT
          ? {
              OBJECT_STORE_DRIVER: 's3',
              S3_ENDPOINT: process.env.E2E_S3_ENDPOINT,
              S3_BUCKET: process.env.E2E_S3_BUCKET ?? 'clinote-backups',
              S3_ACCESS_KEY_ID: process.env.E2E_S3_ACCESS_KEY_ID ?? 'clinote',
              S3_SECRET_ACCESS_KEY: process.env.E2E_S3_SECRET_ACCESS_KEY ?? 'clinote-secret',
              S3_FORCE_PATH_STYLE: 'true',
            }
          : { OBJECT_STORE_DRIVER: 'memory' }),
        EMAIL_DRIVER: 'memory',
        BILLING_PROVIDER: 'manual',
        BILLING_WEBHOOK_SECRET: 'e2e-webhook-secret-value',
        BILLING_CHECKOUT_BASE_URL: `${WEB_URL}/billing/checkout`,
        WEB_ORIGIN: WEB_URL,
        COOKIE_SECURE: 'false',
      },
    },
    {
      /**
       * Built once, then served as static files — the same thing a CDN or an
       * installed PWA would serve.
       */
      command: `pnpm --filter @clinote/web build:e2e && node --import tsx support/staticServer.ts ../web/.output/public ${WEB_PORT}`,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'production',
        NUXT_PUBLIC_API_BASE_URL: `${API_URL}/api/v1`,
        // Backups are uploaded to object storage by the device itself, so its
        // origin has to be in the policy. Absent when no store is configured.
        ...(process.env.E2E_S3_ENDPOINT
          ? { NUXT_PUBLIC_STORAGE_ORIGIN: process.env.E2E_S3_ENDPOINT }
          : {}),
      },
    },
  ],
})
