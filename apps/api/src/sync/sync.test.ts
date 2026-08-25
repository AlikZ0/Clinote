import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import type { Storage, Stores } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'
import { MAX_PAYLOAD_BYTES } from './routes'

let app: FastifyInstance
let storage: Storage
let stores: Stores
let accessToken: string
let userId: string
let deviceId: string

function auth(token = accessToken) {
  return { authorization: `Bearer ${token}` }
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    operationId: randomUUID(),
    entityType: 'client',
    entityId: randomUUID(),
    operation: 'put',
    hlc: '000000001756108800000:00000:device-a',
    deviceId,
    // Opaque to the server: a real payload is an AES-GCM envelope.
    payload: Buffer.from('ciphertext').toString('base64'),
    ...overrides,
  }
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

async function registerDevice(token: string, id: string) {
  await app.inject({
    method: 'POST',
    url: '/api/v1/devices',
    headers: auth(token),
    payload: { id, name: 'Test device', platform: 'web' },
  })
}

beforeEach(async () => {
  storage = await createTestStorage()
  stores = storage.stores
  app = await buildApp({
    env: loadEnv({ NODE_ENV: 'test', JWT_SECRET: 'a'.repeat(48) } as NodeJS.ProcessEnv),
    storage,
  })
  await app.ready()

  const account = await register('anna@example.com')
  accessToken = account.token
  userId = account.id
  deviceId = randomUUID()
  await enablePro(userId)
  await registerDevice(accessToken, deviceId)
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

async function push(envelopes: unknown[], token = accessToken) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: auth(token),
    payload: { envelopes },
  })
}

async function changes(since = 0, token = accessToken) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/sync/changes?since=${since}`,
    headers: auth(token),
  })
}

describe('entitlement', () => {
  it('refuses sync on Free', async () => {
    const free = await register('free@example.com')

    const response = await push([envelope()], free.token)
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('feature_not_available')

    const pull = await changes(0, free.token)
    expect(pull.statusCode).toBe(403)
  })

  it('refuses an unauthenticated push', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      payload: { envelopes: [envelope()] },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('push', () => {
  it('accepts envelopes and assigns increasing sequences', async () => {
    const first = envelope()
    const second = envelope()

    const response = await push([first, second])

    expect(response.statusCode).toBe(200)
    const { seq } = response.json()
    expect(seq[first.operationId]).toBeGreaterThan(0)
    expect(seq[second.operationId]).toBeGreaterThan(seq[first.operationId])
  })

  it('is idempotent: a retried operation keeps its sequence', async () => {
    const only = envelope()

    const first = (await push([only])).json().seq[only.operationId]
    const retry = (await push([only])).json().seq[only.operationId]

    expect(retry).toBe(first)
    expect((await changes(0)).json().items).toHaveLength(1)
  })

  it('refuses a device that is not registered on the account', async () => {
    const response = await push([envelope({ deviceId: randomUUID() })])
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('forbidden')
  })

  it('refuses a batch that claims to come from two devices', async () => {
    const other = randomUUID()
    await registerDevice(accessToken, other)

    const response = await push([envelope(), envelope({ deviceId: other })])
    expect(response.statusCode).toBe(422)
  })

  it('refuses a payload larger than the cap', async () => {
    const oversized = Buffer.alloc(MAX_PAYLOAD_BYTES + 1024, 1).toString('base64')
    const response = await push([envelope({ payload: oversized })])

    expect(response.statusCode).toBe(422)
    expect(response.json().error.message).toMatch(/too large/)
  })

  it('rejects a malformed envelope instead of storing it', async () => {
    const response = await push([envelope({ entityType: 'not-an-entity' })])
    expect(response.statusCode).toBe(422)
    expect((await changes(0)).json().items).toHaveLength(0)
  })
})

describe('pull', () => {
  it('returns envelopes in order, after the cursor', async () => {
    const ids = [envelope(), envelope(), envelope()]
    await push(ids)

    const all = (await changes(0)).json()
    expect(all.items.map((item: { operationId: string }) => item.operationId)).toEqual(
      ids.map((item) => item.operationId),
    )

    const after = (await changes(all.items[1].seq)).json()
    expect(after.items).toHaveLength(1)
    expect(after.items[0].operationId).toBe(ids[2]?.operationId)
  })

  it('returns the payload untouched', async () => {
    const payload = Buffer.from('opaque-ciphertext-bytes').toString('base64')
    await push([envelope({ payload })])

    expect((await changes(0)).json().items[0].payload).toBe(payload)
  })

  it('pages with a cursor and says when there is more', async () => {
    await push(Array.from({ length: 5 }, () => envelope()))

    const page = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/changes?since=0&limit=2',
      headers: auth(),
    })

    expect(page.json().items).toHaveLength(2)
    expect(page.json().hasMore).toBe(true)
    expect(page.json().nextCursor).toBe(page.json().items[1].seq)
  })

  it('never returns another account envelopes', async () => {
    await push([envelope()])

    const other = await register('boris@example.com')
    await enablePro(other.id)

    expect((await changes(0, other.token)).json().items).toEqual([])
  })
})

describe('cursor', () => {
  it('remembers where a device stopped and never moves backwards', async () => {
    await push([envelope(), envelope()])

    await app.inject({
      method: 'POST',
      url: '/api/v1/sync/cursor',
      headers: auth(),
      payload: { deviceId, seq: 2 },
    })

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
      headers: { ...auth(), 'x-clinote-device': deviceId },
    })
    expect(status.json()).toMatchObject({ serverSeq: 2, deviceCursor: 2 })

    // A late response from an earlier request must not replay envelopes.
    await app.inject({
      method: 'POST',
      url: '/api/v1/sync/cursor',
      headers: auth(),
      payload: { deviceId, seq: 1 },
    })
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
      headers: { ...auth(), 'x-clinote-device': deviceId },
    })
    expect(after.json().deviceCursor).toBe(2)
  })

  it('refuses to move a cursor for a device on another account', async () => {
    const other = await register('boris@example.com')
    await enablePro(other.id)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/cursor',
      headers: auth(other.token),
      payload: { deviceId, seq: 1 },
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('key material', () => {
  it('is not readable before it is set up', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/keys',
      headers: auth(),
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('key_unavailable')
  })

  it('stores wrapped keys and hands them back to another device', async () => {
    const material = {
      kdf: 'pbkdf2-sha256',
      salt: Buffer.alloc(16, 7).toString('base64'),
      iterations: 600_000,
      wrappedDekSync: {
        iv: Buffer.alloc(12, 1).toString('base64'),
        key: Buffer.alloc(48, 2).toString('base64'),
      },
      wrappedDekRecovery: null,
    }

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/users/me/keys',
      headers: auth(),
      payload: material,
    })
    expect(put.statusCode).toBe(204)

    const get = await app.inject({ method: 'GET', url: '/api/v1/users/me/keys', headers: auth() })
    expect(get.json()).toMatchObject({
      kdf: material.kdf,
      salt: material.salt,
      iterations: material.iterations,
      wrappedDekSync: material.wrappedDekSync,
    })
  })

  it('refuses to replace key material, which would orphan every envelope', async () => {
    const material = {
      kdf: 'pbkdf2-sha256',
      salt: Buffer.alloc(16, 7).toString('base64'),
      iterations: 600_000,
      wrappedDekSync: {
        iv: Buffer.alloc(12, 1).toString('base64'),
        key: Buffer.alloc(48, 2).toString('base64'),
      },
      wrappedDekRecovery: null,
    }
    await app.inject({
      method: 'PUT',
      url: '/api/v1/users/me/keys',
      headers: auth(),
      payload: material,
    })

    const second = await app.inject({
      method: 'PUT',
      url: '/api/v1/users/me/keys',
      headers: auth(),
      payload: material,
    })
    expect(second.statusCode).toBe(403)
  })

  it('refuses a dangerously low iteration count', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/users/me/keys',
      headers: auth(),
      payload: {
        kdf: 'pbkdf2-sha256',
        salt: Buffer.alloc(16, 7).toString('base64'),
        iterations: 1000,
        wrappedDekSync: {
          iv: Buffer.alloc(12, 1).toString('base64'),
          key: Buffer.alloc(48, 2).toString('base64'),
        },
      },
    })
    expect(response.statusCode).toBe(422)
  })
})

describe('key rotation', () => {
  const material = {
    kdf: 'pbkdf2-sha256',
    salt: Buffer.alloc(16, 7).toString('base64'),
    iterations: 600_000,
    wrappedDekSync: {
      iv: Buffer.alloc(12, 1).toString('base64'),
      key: Buffer.alloc(48, 2).toString('base64'),
    },
    wrappedDekRecovery: {
      iv: Buffer.alloc(12, 5).toString('base64'),
      key: Buffer.alloc(48, 6).toString('base64'),
    },
  }

  async function setUpKeys() {
    return app.inject({
      method: 'PUT',
      url: '/api/v1/users/me/keys',
      headers: auth(),
      payload: material,
    })
  }

  it('replaces the wrapping and keeps both secrets usable', async () => {
    await setUpKeys()

    const rotated = {
      ...material,
      salt: Buffer.alloc(16, 8).toString('base64'),
      wrappedDekSync: {
        iv: Buffer.alloc(12, 3).toString('base64'),
        key: Buffer.alloc(48, 4).toString('base64'),
      },
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/keys/rotate',
      headers: auth(),
      payload: rotated,
    })
    expect(response.statusCode).toBe(204)

    const stored = (
      await app.inject({ method: 'GET', url: '/api/v1/users/me/keys', headers: auth() })
    ).json()
    expect(stored.salt).toBe(rotated.salt)
    expect(stored.wrappedDekSync).toEqual(rotated.wrappedDekSync)
    // The recovery wrapping still opens the same data key.
    expect(stored.wrappedDekRecovery).toEqual(material.wrappedDekRecovery)
  })

  it('refuses to rotate an account that has no key material', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/keys/rotate',
      headers: auth(),
      payload: material,
    })
    expect(response.statusCode).toBe(404)
  })

  it('never lets one account rotate another keys', async () => {
    await setUpKeys()

    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'boris@example.com', password: 'correct horse battery staple' },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/keys/rotate',
      headers: { authorization: `Bearer ${other.json().tokens.accessToken}` },
      payload: material,
    })
    // Their own account has no keys, so this is a 404 about *their* account —
    // not a door into ours.
    expect(response.statusCode).toBe(404)
    const ours = (
      await app.inject({ method: 'GET', url: '/api/v1/users/me/keys', headers: auth() })
    ).json()
    expect(ours.salt).toBe(material.salt)
  })
})
