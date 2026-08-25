/**
 * Forward-only migrations (docs/deployment.md §4).
 *
 * Rules:
 *  - a released migration is never edited; a new one is added;
 *  - each runs inside a transaction, so a failure leaves nothing half-applied;
 *  - an advisory lock means two API instances starting at once cannot both
 *    apply the same migration.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PLANS } from '@clinote/config'
import type { Sql } from './pool'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')
/** Any constant works; it only has to be the same in every instance. */
const LOCK_ID = 4_815_162_342

export interface MigrationResult {
  applied: string[]
  alreadyApplied: string[]
}

export async function migrate(
  sql: Sql,
  options: { seedPlans?: boolean } = {},
): Promise<MigrationResult> {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const client = await sql.connect()
  const result: MigrationResult = { applied: [], alreadyApplied: [] }

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
    const done = new Set(rows.map((row) => row.name))

    for (const name of await migrationFiles()) {
      if (done.has(name)) {
        result.alreadyApplied.push(name)
        continue
      }

      const sqlText = await readFile(join(MIGRATIONS_DIR, name), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sqlText)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
        await client.query('COMMIT')
        result.applied.push(name)
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error })
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
    client.release()
  }

  if (options.seedPlans !== false) await seedPlans(sql)
  return result
}

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR)
  // Numeric prefixes decide the order; the sort must not depend on locale.
  return entries.filter((name) => name.endsWith('.sql')).sort()
}

/**
 * Seeds the plan catalog from the shared defaults.
 *
 * Upsert by id, and never overwrite a price that an operator has changed:
 * prices are data precisely so they can be edited without a deploy
 * (docs/subscriptions.md §2). Only the feature matrix and limits, which are
 * code-level facts, are kept in step.
 */
export async function seedPlans(sql: Sql): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await sql.query(
      `INSERT INTO plans (id, name, price_amount, price_currency, price_interval,
                          features, limits, is_public, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE
         SET features = EXCLUDED.features,
             limits = EXCLUDED.limits,
             updated_at = now()`,
      [
        plan.id,
        plan.name,
        plan.price.amount,
        plan.price.currency,
        plan.price.interval,
        JSON.stringify(plan.features),
        JSON.stringify(plan.limits),
        plan.isPublic,
        plan.sortOrder,
      ],
    )
  }
}
