import type { Env } from '../env'
import { createMemoryStorage } from './memory'
import { createPostgresStorage } from './postgres'
import type { Storage } from './ports'

export * from './ports'
export { createMemoryStores, createMemoryStorage } from './memory'
export { createPostgresStores, createPostgresStorage } from './postgres'

export async function createStorage(env: Env): Promise<Storage> {
  if (env.STORAGE_DRIVER === 'memory') {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'STORAGE_DRIVER=memory is not usable in production: every account would be lost on restart.',
      )
    }
    return createMemoryStorage()
  }

  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required when STORAGE_DRIVER=postgres.')

  return createPostgresStorage({
    connectionString: env.DATABASE_URL,
    maxConnections: env.DATABASE_MAX_CONNECTIONS,
    migrateOnBoot: env.DATABASE_MIGRATE_ON_BOOT,
  })
}
