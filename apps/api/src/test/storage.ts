/**
 * Test storage factory.
 *
 * The same suites run against every adapter: that is the entire point of the
 * ports (docs/architecture.md §5). Which adapter is chosen comes from
 * `TEST_STORAGE`, so no test file knows or cares.
 */
import { createMemoryStorage, createPostgresStorage, type Storage } from '../storage'
import { createPool } from '../db/pool'
import { migrate } from '../db/migrate'

const TABLES = ['sessions', 'password_resets', 'devices', 'subscriptions', 'identities', 'users']

let postgres: Storage | null = null

export function activeDriver(): 'memory' | 'postgres' {
  return process.env.TEST_STORAGE === 'postgres' ? 'postgres' : 'memory'
}

export async function createTestStorage(): Promise<Storage> {
  if (activeDriver() === 'memory') return createMemoryStorage()

  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString) {
    throw new Error('TEST_STORAGE=postgres requires TEST_DATABASE_URL')
  }

  if (!postgres) {
    // Migrate once per process; every test then starts from empty tables.
    const pool = createPool({ connectionString })
    await migrate(pool)
    await pool.end()
    postgres = await createPostgresStorage({ connectionString, migrateOnBoot: false })
  }

  await truncate(connectionString)
  return {
    stores: postgres.stores,
    healthy: postgres.healthy,
    // The pool is shared across tests; closing it here would break the next one.
    close: async () => undefined,
  }
}

async function truncate(connectionString: string): Promise<void> {
  const pool = createPool({ connectionString, maxConnections: 1 })
  try {
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
  } finally {
    await pool.end()
  }
}

export async function closeTestStorage(): Promise<void> {
  await postgres?.close()
  postgres = null
}
