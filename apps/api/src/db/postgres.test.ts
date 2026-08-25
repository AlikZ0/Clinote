/**
 * Behaviour that only PostgreSQL can be asked about: migrations, constraints
 * and the seeded plan catalog. Runs only in the `api:postgres` project.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import { createPostgresStores } from '../storage'
import { activeDriver } from '../test/storage'
import { createPool, type Sql } from './pool'
import { migrate } from './migrate'

const url = process.env.TEST_DATABASE_URL
const runs = activeDriver() === 'postgres' && Boolean(url)

let sql: Sql

beforeAll(async () => {
  if (!runs) return
  sql = createPool({ connectionString: url as string })
  await migrate(sql)
})

afterAll(async () => {
  if (runs) await sql.end()
})

describe.skipIf(!runs)('migrations', () => {
  it('records what it applied', async () => {
    const { rows } = await sql.query<{ name: string }>('SELECT name FROM schema_migrations')
    expect(rows.map((row) => row.name)).toContain('0001_init.sql')
  })

  it('is safe to run again', async () => {
    const result = await migrate(sql)
    expect(result.applied).toEqual([])
    expect(result.alreadyApplied).toContain('0001_init.sql')
  })

  it('creates every table the schema document promises', async () => {
    const { rows } = await sql.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    )
    const tables = rows.map((row) => row.table_name)
    for (const expected of [
      'users',
      'identities',
      'devices',
      'sessions',
      'password_resets',
      'plans',
      'subscriptions',
    ]) {
      expect(tables).toContain(expected)
    }
  })
})

describe.skipIf(!runs)('constraints', () => {
  function user(email: string) {
    const now = new Date().toISOString()
    return {
      id: randomUUID(),
      email,
      passwordHash: 'hash',
      name: null,
      locale: null,
      timezone: null,
      emailVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
  }

  it('refuses two live accounts for one address, whatever the casing', async () => {
    const stores = createPostgresStores(sql)
    const email = `dup-${randomUUID()}@example.com`
    await stores.users.create(user(email))

    await expect(stores.users.create(user(email.toUpperCase()))).rejects.toThrow()
  })

  it('frees the address again once the account is deleted', async () => {
    const stores = createPostgresStores(sql)
    const email = `reuse-${randomUUID()}@example.com`
    const first = await stores.users.create(user(email))

    await stores.users.update(first.id, { deletedAt: new Date().toISOString() })

    // The unique index is partial for exactly this reason.
    const second = await stores.users.create(user(email))
    expect(second.id).not.toBe(first.id)
    expect(await stores.users.findByEmail(email)).toMatchObject({ id: second.id })
  })

  it('removes a user session and device with the user', async () => {
    const stores = createPostgresStores(sql)
    const account = await stores.users.create(user(`cascade-${randomUUID()}@example.com`))
    await stores.devices.upsert({
      id: randomUUID(),
      userId: account.id,
      name: 'Laptop',
      platform: 'desktop',
      lastSeen: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    })

    await sql.query('DELETE FROM users WHERE id = $1', [account.id])

    const { rows } = await sql.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM devices WHERE user_id = $1',
      [account.id],
    )
    expect(rows[0]?.n).toBe(0)
  })

  it('keeps timestamps as ISO strings, not Date objects', async () => {
    const stores = createPostgresStores(sql)
    const account = await stores.users.create(user(`iso-${randomUUID()}@example.com`))
    const found = await stores.users.findById(account.id)

    expect(typeof found?.createdAt).toBe('string')
    expect(found?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })
})

describe.skipIf(!runs)('plan catalog', () => {
  it('is served from the database, so a price is a data change', async () => {
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        JWT_SECRET: 'a'.repeat(48),
        STORAGE_DRIVER: 'postgres',
        DATABASE_URL: url,
      } as NodeJS.ProcessEnv),
    })
    await app.ready()

    try {
      const before = (await app.inject({ method: 'GET', url: '/api/v1/plans' })).json()
      expect(before.map((plan: { id: string }) => plan.id)).toEqual(['free', 'pro', 'business'])

      await sql.query(`UPDATE plans SET price_amount = 799 WHERE id = 'pro'`)
      const after = (await app.inject({ method: 'GET', url: '/api/v1/plans' })).json()
      expect(after[1].price.amount).toBe(799)
    } finally {
      await sql.query(`UPDATE plans SET price_amount = 599 WHERE id = 'pro'`)
      await app.close()
    }
  })

  it('re-seeding does not overwrite an operator price', async () => {
    await sql.query(`UPDATE plans SET price_amount = 999 WHERE id = 'business'`)
    await migrate(sql)

    const { rows } = await sql.query<{ price_amount: number }>(
      `SELECT price_amount FROM plans WHERE id = 'business'`,
    )
    expect(rows[0]?.price_amount).toBe(999)

    await sql.query(`UPDATE plans SET price_amount = 1499 WHERE id = 'business'`)
  })
})

describe.skipIf(!runs)('readiness', () => {
  it('reports the database it depends on', async () => {
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        JWT_SECRET: 'a'.repeat(48),
        STORAGE_DRIVER: 'postgres',
        DATABASE_URL: url,
      } as NodeJS.ProcessEnv),
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(200)
    expect(response.json().checks.database).toBe('ok')

    await app.close()
  })

  it('is not ready when the database is unreachable', async () => {
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        JWT_SECRET: 'a'.repeat(48),
        STORAGE_DRIVER: 'postgres',
        // A port nothing listens on: the probe must fail, not hang forever.
        DATABASE_URL: 'postgres://clinote:clinote@127.0.0.1:1/clinote',
        DATABASE_MIGRATE_ON_BOOT: 'false',
      } as NodeJS.ProcessEnv),
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json().checks.database).toBe('unavailable')

    await app.close()
  })
})
