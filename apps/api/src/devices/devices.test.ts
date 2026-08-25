import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { createMemoryStorage } from '../storage'
import { loadEnv } from '../env'
import type { Storage, Stores } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'

let app: FastifyInstance
let storage: Storage
let stores: Stores
let accessToken: string
let userId: string

const DEVICE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Reception iPad',
  platform: 'ios' as const,
}

function authHeader(token = accessToken) {
  return { authorization: `Bearer ${token}` }
}

beforeEach(async () => {
  storage = await createTestStorage()
  stores = storage.stores
  app = await buildApp({
    env: loadEnv({ NODE_ENV: 'test', JWT_SECRET: 'a'.repeat(48) } as NodeJS.ProcessEnv),
    storage,
  })
  await app.ready()

  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: 'anna@example.com', password: 'correct horse battery staple' },
  })
  accessToken = registered.json().tokens.accessToken
  userId = registered.json().user.id
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

/**
 * Free has no device allowance at all; Pro has three.
 *
 * Written through the store rather than by patching it: a stub would not
 * exercise the adapter, and patching a shared instance leaks into later tests —
 * which is exactly how this was found, by running the suite against a second
 * adapter.
 */
async function makePro() {
  await stores.subscriptions.upsert({
    userId,
    planId: 'pro',
    status: 'active',
    currentPeriodEnd: null,
  })
}

describe('authentication guard', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/devices' })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('unauthenticated')
  })

  it('refuses a forged token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: authHeader('not.a.token'),
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a token signed with a different secret', async () => {
    const other = await buildApp({
      env: loadEnv({ NODE_ENV: 'test', JWT_SECRET: 'b'.repeat(48) } as NodeJS.ProcessEnv),
      storage: createMemoryStorage(),
    })
    await other.ready()
    const foreign = await other.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'anna@example.com', password: 'correct horse battery staple' },
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: authHeader(foreign.json().tokens.accessToken),
    })
    expect(response.statusCode).toBe(401)
    await other.close()
  })
})

describe('device registration', () => {
  it('is refused on Free, which has no multi-device allowance', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: authHeader(),
      payload: DEVICE,
    })

    expect(response.statusCode).toBe(402)
    expect(response.json().error.code).toBe('device_limit_reached')
    expect(response.json().error.message).toMatch(/Clinote Pro/)
  })

  it('registers the id the device generated for itself', async () => {
    await makePro()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: authHeader(),
      payload: DEVICE,
    })

    expect(response.statusCode).toBe(201)
    // The same id stamps sync envelopes, so the server must not invent one.
    expect(response.json().id).toBe(DEVICE.id)
  })

  it('is idempotent: re-registering the same device does not consume a slot', async () => {
    await makePro()
    await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: authHeader(),
      payload: DEVICE,
    })
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: authHeader(),
      payload: { ...DEVICE, name: 'Renamed iPad' },
    })

    expect(again.statusCode).toBe(200)
    expect(again.json().name).toBe('Renamed iPad')
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/devices', headers: authHeader() })).json(),
    ).toHaveLength(1)
  })

  it('enforces the plan limit server-side', async () => {
    await makePro()

    for (let index = 1; index <= 3; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        headers: authHeader(),
        payload: {
          ...DEVICE,
          id: `1111111${index}-1111-4111-8111-111111111111`,
          name: `Device ${index}`,
        },
      })
      expect(response.statusCode).toBe(201)
    }

    const fourth = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: authHeader(),
      payload: { ...DEVICE, id: '99999999-1111-4111-8111-111111111111', name: 'One too many' },
    })

    expect(fourth.statusCode).toBe(402)
    expect(fourth.json().error.details).toMatchObject({ limit: 3, active: 3 })
  })

  it('frees a slot when a device is removed', async () => {
    await makePro()
    await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: authHeader(),
      payload: DEVICE,
    })

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${DEVICE.id}`,
      headers: authHeader(),
    })
    expect(removed.statusCode).toBe(204)
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/devices', headers: authHeader() })).json(),
    ).toEqual([])
  })

  it('will not touch a device that belongs to someone else', async () => {
    await makePro()
    await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: authHeader(),
      payload: DEVICE,
    })

    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'boris@example.com', password: 'correct horse battery staple' },
    })
    const otherToken = other.json().tokens.accessToken

    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: authHeader(otherToken),
      payload: DEVICE,
    })
    expect(claim.statusCode).toBe(403)

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${DEVICE.id}`,
      headers: authHeader(otherToken),
    })
    expect(remove.statusCode).toBe(404)
  })
})

describe('entitlement snapshot', () => {
  it('describes what the account may do, not which plan it is on', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: authHeader(),
    })

    expect(response.statusCode).toBe(200)
    const { user, entitlement } = response.json()
    expect(user.email).toBe('anna@example.com')
    expect(entitlement.features).toMatchObject({ cloudSync: false, appointments: false })
    expect(entitlement.usage.devices).toBe(0)
  })

  it('reflects an active subscription and counts registered devices', async () => {
    await makePro()
    await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: authHeader(),
      payload: DEVICE,
    })

    const { entitlement } = (
      await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeader() })
    ).json()

    expect(entitlement.planId).toBe('pro')
    expect(entitlement.features.cloudSync).toBe(true)
    expect(entitlement.limits.maxDevices).toBe(3)
    expect(entitlement.usage.devices).toBe(1)
  })

  it('falls back to Free when a subscription has lapsed', async () => {
    await stores.subscriptions.upsert({
      userId,
      planId: 'pro',
      status: 'expired',
      currentPeriodEnd: '2026-01-01T00:00:00.000Z',
    })

    const { entitlement } = (
      await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeader() })
    ).json()

    expect(entitlement.planId).toBe('free')
    expect(entitlement.features.cloudBackup).toBe(false)
  })
})

describe('profile', () => {
  it('updates what the user is allowed to change', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: authHeader(),
      payload: { name: 'Anna S', timezone: 'Asia/Yerevan' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().user).toMatchObject({ name: 'Anna S', timezone: 'Asia/Yerevan' })
    expect(response.json().user.email).toBe('anna@example.com')
  })
})
