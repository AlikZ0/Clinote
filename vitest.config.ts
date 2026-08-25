import { defineConfig } from 'vitest/config'

/**
 * One suite for the whole workspace. Each project keeps its own root so that a
 * package's tests never resolve another package's files by accident.
 *
 * The API suite runs once per storage adapter. The PostgreSQL project only
 * exists when a database is configured — CI always sets `TEST_DATABASE_URL`,
 * so the adapter is never left untested there, and a machine without a
 * database still gets a fast, green run.
 */
const projects: (string | Record<string, unknown>)[] = [
  'packages/*',
  'apps/web',
  {
    extends: 'apps/api/vitest.config.ts',
    root: 'apps/api',
    test: {
      name: 'api:memory',
      env: {
        TEST_STORAGE: 'memory',
        // Present only when an S3-compatible service is configured; the object
        // store suite skips itself otherwise.
        ...(process.env.TEST_S3_ENDPOINT ? { TEST_S3_ENDPOINT: process.env.TEST_S3_ENDPOINT } : {}),
        ...(process.env.TEST_SMTP_HOST ? { TEST_SMTP_HOST: process.env.TEST_SMTP_HOST } : {}),
      },
    },
  },
]

if (process.env.TEST_DATABASE_URL) {
  projects.push({
    extends: 'apps/api/vitest.config.ts',
    root: 'apps/api',
    test: {
      name: 'api:postgres',
      env: { TEST_STORAGE: 'postgres', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
      // One database, shared tables: parallel files would truncate each other.
      fileParallelism: false,
    },
  })
}

export default defineConfig({ test: { projects } })
