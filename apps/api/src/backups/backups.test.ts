import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import type { Storage, Stores } from '../storage'
import { createMemoryObjectStore, type MemoryObjectStore } from '../storage/objects'
import { closeTestStorage, createTestStorage } from '../test/storage'

let app: FastifyInstance
let storage: Storage
let stores: Stores
let objects: MemoryObjectStore
let accessToken: string
let userId: string
let deviceId: string

const ARCHIVE = Buffer.from('encrypted-archive-bytes-that-the-server-cannot-read')
const CHECKSUM = createHash('sha256').update(ARCHIVE).digest('hex')

const WRAPPED_DEK = {
  iv: Buffer.alloc(12, 3).toString('base64'),
  key: Buffer.alloc(48, 4).toString('base64'),
}

function auth(token = accessToken) {
  return { authorization: `Bearer ${token}` }
}

async function register(email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'correct horse battery staple' },
  })
  return { token: response.json().tokens.accessToken, id: response.json().user.id }
}

async function enablePro(id: string) {
  await stores.subscriptions.upsert({
    userId: id,
    planId: 'pro',
    status: 'active',
    currentPeriodEnd: null,
  })
}

function initPayload(overrides: Record<string, unknown> = {}) {
  return {
    deviceId,
    sizeBytes: ARCHIVE.length,
    checksum: CHECKSUM,
    wrappedDek: WRAPPED_DEK,
    appVersion: '0.1.0',
    databaseVersion: 1,
    ...overrides,
  }
}

async function init(overrides: Record<string, unknown> = {}, token = accessToken) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/backups/init',
    headers: auth(token),
    payload: initPayload(overrides),
  })
}

/** Stands in for the device PUTting to the signed URL. */
function upload(objectKeyOwner: string, body: Buffer = ARCHIVE) {
  objects.put(objectKeyOwner, new Uint8Array(body))
}

function objectKeyFor(backupId: string) {
  return `backups/${userId}/${backupId}.clinote`
}

async function complete(backupId: string, checksum = CHECKSUM) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/backups/${backupId}/complete`,
    headers: auth(),
    payload: { checksum },
  })
}

beforeEach(async () => {
  storage = await createTestStorage()
  stores = storage.stores
  objects = createMemoryObjectStore()
  app = await buildApp({
    env: loadEnv({ NODE_ENV: 'test', JWT_SECRET: 'a'.repeat(48) } as NodeJS.ProcessEnv),
    storage,
    objects,
  })
  await app.ready()

  const account = await register('anna@example.com')
  accessToken = account.token
  userId = account.id
  deviceId = randomUUID()
  await enablePro(userId)
  await app.inject({
    method: 'POST',
    url: '/api/v1/devices',
    headers: auth(),
    payload: { id: deviceId, name: 'Test device', platform: 'web' },
  })
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

describe('entitlement', () => {
  it('refuses cloud backup on Free', async () => {
    const free = await register('free@example.com')
    const response = await init({}, free.token)

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('feature_not_available')
  })
})

describe('upload protocol', () => {
  it('hands out a signed URL without taking the archive itself', async () => {
    const response = await init()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.backupId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.upload.url).toContain('backups')
    expect(Date.parse(body.upload.expiresAt)).toBeGreaterThan(Date.now())
    // Nothing is stored yet: the device has not uploaded.
    expect(objects.size()).toBe(0)
  })

  it('completes only after checking what actually landed', async () => {
    const { backupId } = (await init()).json()
    upload(objectKeyFor(backupId))

    const response = await complete(backupId)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'completed', sizeBytes: ARCHIVE.length })
    expect(response.json().completedAt).not.toBeNull()
  })

  it('refuses to complete a backup that was never uploaded', async () => {
    const { backupId } = (await init()).json()

    const response = await complete(backupId)

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('backup_invalid_format')
    const [record] = (
      await app.inject({ method: 'GET', url: '/api/v1/backups', headers: auth() })
    ).json()
    expect(record.status).toBe('failed')
  })

  it('rejects a truncated upload and keeps nothing', async () => {
    const { backupId } = (await init()).json()
    upload(objectKeyFor(backupId), Buffer.from('too short'))

    const response = await complete(backupId)

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('backup_checksum_mismatch')
    expect(objects.has(objectKeyFor(backupId))).toBe(false)
  })

  it('rejects an archive whose bytes do not match the promised digest', async () => {
    const tampered = Buffer.alloc(ARCHIVE.length, 9)
    const { backupId } = (await init()).json()
    upload(objectKeyFor(backupId), tampered)

    const response = await complete(backupId)

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('backup_checksum_mismatch')
  })

  it('never sees the archive contents', async () => {
    const { backupId } = (await init()).json()
    upload(objectKeyFor(backupId))
    await complete(backupId)

    const listed = (
      await app.inject({ method: 'GET', url: '/api/v1/backups', headers: auth() })
    ).json()
    // Size, digest, versions — and nothing that could be read.
    expect(Object.keys(listed[0]).sort()).toEqual([
      'appVersion',
      'checksum',
      'completedAt',
      'createdAt',
      'databaseVersion',
      'deviceId',
      'emailStatus',
      'errorCode',
      'expiresAt',
      'id',
      'sizeBytes',
      'status',
    ])
  })

  it('refuses a device that is not on the account', async () => {
    const response = await init({ deviceId: randomUUID() })
    expect(response.statusCode).toBe(403)
  })
})

describe('storage accounting', () => {
  it('counts only completed backups', async () => {
    const first = (await init()).json()
    upload(objectKeyFor(first.backupId))
    await complete(first.backupId)

    // A second, abandoned attempt must not consume the quota.
    await init()

    const health = (
      await app.inject({ method: 'GET', url: '/api/v1/backups/health', headers: auth() })
    ).json()
    expect(health.storageUsedBytes).toBe(ARCHIVE.length)
  })

  it('refuses a backup that would exceed the plan storage', async () => {
    const response = await init({ sizeBytes: 11 * 1024 * 1024 * 1024 })
    expect(response.statusCode).toBe(422)
  })

  it('reports the limit alongside the usage', async () => {
    const health = (
      await app.inject({ method: 'GET', url: '/api/v1/backups/health', headers: auth() })
    ).json()
    expect(health.storageLimitBytes).toBe(10 * 1024 ** 3)
  })

  it('frees the space when a backup is deleted', async () => {
    const { backupId } = (await init()).json()
    upload(objectKeyFor(backupId))
    await complete(backupId)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/backups/${backupId}`,
      headers: auth(),
    })

    expect(deleted.statusCode).toBe(204)
    expect(objects.has(objectKeyFor(backupId))).toBe(false)
    const health = (
      await app.inject({ method: 'GET', url: '/api/v1/backups/health', headers: auth() })
    ).json()
    expect(health.storageUsedBytes).toBe(0)
  })
})

describe('history and health', () => {
  it('starts by saying that nothing has ever been backed up', async () => {
    const health = (
      await app.inject({ method: 'GET', url: '/api/v1/backups/health', headers: auth() })
    ).json()

    expect(health).toMatchObject({
      lastSuccessfulBackup: null,
      successCount30d: 0,
      needsAttention: true,
    })
  })

  it('turns green after a successful backup and red after a failed one', async () => {
    const good = (await init()).json()
    upload(objectKeyFor(good.backupId))
    await complete(good.backupId)

    let health = (
      await app.inject({ method: 'GET', url: '/api/v1/backups/health', headers: auth() })
    ).json()
    expect(health).toMatchObject({ successCount30d: 1, failureCount30d: 0, needsAttention: false })

    const bad = (await init()).json()
    await complete(bad.backupId) // never uploaded

    health = (
      await app.inject({ method: 'GET', url: '/api/v1/backups/health', headers: auth() })
    ).json()
    expect(health).toMatchObject({ successCount30d: 1, failureCount30d: 1, needsAttention: true })
    expect(health.lastSuccessfulBackup).not.toBeNull()
  })

  it('sets an expiry from the plan retention window', async () => {
    const { backupId } = (await init()).json()
    upload(objectKeyFor(backupId))
    const completed = await complete(backupId)

    const expiresAt = Date.parse(completed.json().expiresAt)
    const days = Math.round((expiresAt - Date.now()) / 86_400_000)
    expect(days).toBe(30)
  })
})

describe('download', () => {
  it('returns a short-lived link and the wrapped key', async () => {
    const { backupId } = (await init()).json()
    upload(objectKeyFor(backupId))
    await complete(backupId)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/backups/${backupId}/download`,
      headers: auth(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().url).toContain('download')
    expect(response.json().wrappedDek).toEqual(WRAPPED_DEK)
    expect(Date.parse(response.json().expiresAt)).toBeGreaterThan(Date.now())
  })

  it('refuses a backup that never completed', async () => {
    const { backupId } = (await init()).json()

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/backups/${backupId}/download`,
      headers: auth(),
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('isolation', () => {
  it('never lets one account touch another backup', async () => {
    const { backupId } = (await init()).json()
    upload(objectKeyFor(backupId))
    await complete(backupId)

    const other = await register('boris@example.com')
    await enablePro(other.id)

    expect(
      (
        await app.inject({ method: 'GET', url: '/api/v1/backups', headers: auth(other.token) })
      ).json(),
    ).toEqual([])

    for (const url of [`/api/v1/backups/${backupId}/download`, `/api/v1/backups/${backupId}`]) {
      const response = await app.inject({
        method: url.endsWith('/download') ? 'GET' : 'DELETE',
        url,
        headers: auth(other.token),
      })
      expect(response.statusCode).toBe(404)
    }

    expect(objects.has(objectKeyFor(backupId))).toBe(true)
  })
})
