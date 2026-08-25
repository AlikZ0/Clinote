/**
 * PostgreSQL connection.
 *
 * A single pool per process. Adapters take the pool as a dependency rather
 * than reaching for a module-level singleton, so tests can point them at a
 * throwaway database.
 */
import pg from 'pg'

const { Pool, types } = pg

/**
 * `timestamptz` comes back as an ISO string, not a Date.
 *
 * Every timestamp in this system is an ISO string end to end (the ports, the
 * API contract, the sync envelopes). Converting to Date here and back to a
 * string later is where timezone bugs are born.
 */
types.setTypeParser(1184, (value) => new Date(value).toISOString())
types.setTypeParser(1114, (value) => new Date(`${value}Z`).toISOString())
/** int8: counts fit in a JS number long before they fit in 64 bits. */
types.setTypeParser(20, (value) => Number.parseInt(value, 10))

export type Sql = pg.Pool

export interface PoolOptions {
  connectionString: string
  maxConnections?: number
}

export function createPool(options: PoolOptions): Sql {
  return new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    // Fail fast rather than queueing requests behind a dead database.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })
}

export async function checkConnection(sql: Sql): Promise<boolean> {
  try {
    await sql.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
