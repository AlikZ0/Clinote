/** `pnpm --filter @clinote/api migrate` */
import { loadEnv } from '../env'
import { createPool } from './pool'
import { migrate } from './migrate'

const env = loadEnv()
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const pool = createPool({ connectionString: env.DATABASE_URL })
try {
  const result = await migrate(pool)
  console.warn(
    result.applied.length > 0
      ? `Applied: ${result.applied.join(', ')}`
      : 'Database is already up to date.',
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
} finally {
  await pool.end()
}
