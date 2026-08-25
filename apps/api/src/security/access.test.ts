/**
 * The pen-test checklist, executable (docs/threat-model.md, docs/security.md §14).
 *
 * Every item here is an attack somebody would actually try: reach another
 * account's data by id, forge a token, keep a session after signing out, or
 * walk in through a header the server was trusting. A checklist in a document
 * gets read once; this runs on every commit.
 */
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import type { Storage } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'
import { REFRESH_COOKIE, secretKey } from '../auth/tokens'

const JWT_SECRET = 'a'.repeat(48)

let app: FastifyInstance
let storage: Storage

interface Account {
  id: string
  token: string
  deviceId: string
}

const auth = (account: Account) => ({ authorization: `Bearer ${account.token}` })

async function makeAccount(email: string, plan: 'free' | 'pro' | 'business'): Promise<Account> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'correct horse battery staple' },
  })
  const account = {
    id: response.json().user.id as string,
    token: response.json().tokens.accessToken as string,
    deviceId: randomUUID(),
  }

  if (plan !== 'free') {
    await storage.stores.subscriptions.upsert({
      userId: account.id,
      planId: plan,
      status: 'active',
      currentPeriodEnd: null,
    })
  }

  await app.inject({
    method: 'POST',
    url: '/api/v1/devices',
    headers: auth(account),
    payload: { id: account.deviceId, name: 'Test device', platform: 'web' },
  })

  return account
}

beforeEach(async () => {
  storage = await createTestStorage()
  app = await buildApp({
    env: loadEnv({ NODE_ENV: 'test', JWT_SECRET } as NodeJS.ProcessEnv),
    storage,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

describe('reaching another account by id', () => {
  it('will not hand over somebody else’s backup', async () => {
    const anna = await makeAccount('anna@example.com', 'pro')
    const mallory = await makeAccount('mallory@example.com', 'pro')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/backups/init',
      headers: auth(anna),
      payload: {
        deviceId: anna.deviceId,
        sizeBytes: 1024,
        checksum: 'a'.repeat(64),
        wrappedDek: { iv: 'aXZpdml2aXZpdml2', key: 'a2V5' },
        appVersion: '0.1.0',
        databaseVersion: 1,
      },
    })
    const backupId = created.json().backupId as string

    for (const [method, url] of [
      ['GET', `/api/v1/backups/${backupId}/download`],
      ['POST', `/api/v1/backups/${backupId}/complete`],
      ['DELETE', `/api/v1/backups/${backupId}`],
    ] as const) {
      const response = await app.inject({ method, url, headers: auth(mallory) })
      // 404, not 403: whether that backup exists is not Mallory's business.
      expect(response.statusCode).toBe(404)
    }
  })

  it('will not revoke somebody else’s device', async () => {
    const anna = await makeAccount('anna@example.com', 'pro')
    const mallory = await makeAccount('mallory@example.com', 'pro')

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${anna.deviceId}`,
      headers: auth(mallory),
    })
    expect(response.statusCode).toBe(404)

    const device = await storage.stores.devices.findById(anna.deviceId)
    expect(device?.revokedAt).toBeNull()
  })

  it('will not let one account push envelopes as another account’s device', async () => {
    const anna = await makeAccount('anna@example.com', 'pro')
    const mallory = await makeAccount('mallory@example.com', 'pro')

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: auth(mallory),
      payload: {
        envelopes: [
          {
            operationId: randomUUID(),
            entityType: 'client',
            entityId: randomUUID(),
            operation: 'put',
            hlc: '000000001756108800000:00000:device-a',
            baseHlc: null,
            // Anna's device id: forging this would corrupt her ordering.
            deviceId: anna.deviceId,
            payload: Buffer.from('x').toString('base64'),
          },
        ],
      },
    })
    expect(response.statusCode).toBe(403)
  })

  it('keeps two accounts’ streams apart', async () => {
    const anna = await makeAccount('anna@example.com', 'pro')
    const mallory = await makeAccount('mallory@example.com', 'pro')

    await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: auth(anna),
      payload: {
        envelopes: [
          {
            operationId: randomUUID(),
            entityType: 'client',
            entityId: randomUUID(),
            operation: 'put',
            hlc: '000000001756108800000:00000:device-a',
            baseHlc: null,
            deviceId: anna.deviceId,
            payload: Buffer.from('anna-ciphertext').toString('base64'),
          },
        ],
      },
    })

    const pulled = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/changes?since=0&limit=50',
      headers: auth(mallory),
    })
    expect(pulled.json().items).toHaveLength(0)
  })

  it('will not read another account’s wrapped keys', async () => {
    const anna = await makeAccount('anna@example.com', 'pro')
    await app.inject({
      method: 'PUT',
      url: '/api/v1/users/me/keys',
      headers: auth(anna),
      payload: {
        kdf: 'pbkdf2-sha256',
        salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
        iterations: 600_000,
        wrappedDekSync: { iv: 'aXZpdml2aXZpdml2', key: 'YW5uYS1rZXk=' },
        wrappedDekRecovery: null,
      },
    })

    const mallory = await makeAccount('mallory@example.com', 'pro')
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/keys',
      headers: auth(mallory),
    })

    // There is no endpoint that takes a user id at all; `me` is the session.
    expect(response.statusCode).toBe(404)
    expect(response.body).not.toContain('YW5uYS1rZXk=')
  })
})

describe('tokens', () => {
  async function probe(token: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('rejects an unsigned token claiming alg: none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const claims = Buffer.from(
      JSON.stringify({
        sub: randomUUID(),
        sid: randomUUID(),
        iss: 'clinote',
        aud: 'clinote-app',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url')

    expect((await probe(`${header}.${claims}.`)).statusCode).toBe(401)
  })

  it('rejects a token signed with the wrong secret', async () => {
    const forged = await new SignJWT({ sid: randomUUID() })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(randomUUID())
      .setIssuer('clinote')
      .setAudience('clinote-app')
      .setExpirationTime('1h')
      .sign(secretKey('b'.repeat(48)))

    expect((await probe(forged)).statusCode).toBe(401)
  })

  it('rejects a correctly signed token issued for something else', async () => {
    // The same secret, the wrong audience: a token minted for another service
    // sharing the key must not open this one.
    const other = await new SignJWT({ sid: randomUUID() })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(randomUUID())
      .setIssuer('clinote')
      .setAudience('some-other-app')
      .setExpirationTime('1h')
      .sign(secretKey(JWT_SECRET))

    expect((await probe(other)).statusCode).toBe(401)
  })

  it('rejects an expired token', async () => {
    const expired = await new SignJWT({ sid: randomUUID() })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(randomUUID())
      .setIssuer('clinote')
      .setAudience('clinote-app')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secretKey(JWT_SECRET))

    expect((await probe(expired)).statusCode).toBe(401)
  })

  it('does not accept the refresh cookie as an access token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'anna@example.com', password: 'correct horse battery staple' },
    })
    const refresh = login.cookies.find((entry) => entry.name === REFRESH_COOKIE)!.value

    expect((await probe(refresh)).statusCode).toBe(401)
  })
})

describe('sessions', () => {
  it('sets the refresh cookie so script cannot read it and other sites cannot send it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'anna@example.com', password: 'correct horse battery staple' },
    })

    const cookie = response.cookies.find((entry) => entry.name === REFRESH_COOKIE)!
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.sameSite).toBe('Strict')
    // Scoped to the one path that consumes it, so it is not attached to every
    // request the app makes.
    expect(cookie.path).toContain('/auth')
  })

  it('stops working the moment it is used twice', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'anna@example.com', password: 'correct horse battery staple' },
    })
    const stolen = registered.cookies.find((entry) => entry.name === REFRESH_COOKIE)!.value

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: stolen },
    })
    expect(first.statusCode).toBe(200)

    // Replaying the rotated token is what a theft looks like; the family goes.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: stolen },
    })
    expect(replay.statusCode).toBe(401)

    const rotated = first.cookies.find((entry) => entry.name === REFRESH_COOKIE)!.value
    const afterReuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: rotated },
    })
    expect(afterReuse.statusCode).toBe(401)
  })

  it('ends the session on sign-out', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'anna@example.com', password: 'correct horse battery staple' },
    })
    const cookie = registered.cookies.find((entry) => entry.name === REFRESH_COOKIE)!.value

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [REFRESH_COOKIE]: cookie },
    })

    const afterLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: cookie },
    })
    expect(afterLogout.statusCode).toBe(401)
  })
})

describe('input the server should refuse', () => {
  it('refuses a body larger than the JSON limit', async () => {
    const anna = await makeAccount('anna@example.com', 'pro')
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: auth(anna),
      payload: { envelopes: [{ payload: 'x'.repeat(2 * 1024 * 1024) }] },
    })
    // Backups never travel through the JSON API, so nothing legitimate is
    // anywhere near this size.
    expect(response.statusCode).toBe(413)
  })

  it('refuses a workspace id that is not a uuid instead of querying with it', async () => {
    const anna = await makeAccount('anna@example.com', 'business')

    const response = await app.inject({
      method: 'GET',
      url: "/api/v1/workspaces/' OR 1=1 --/members",
      headers: auth(anna),
    })
    expect(response.statusCode).toBe(422)
  })

  it('will not let a client choose which account a webhook applies to', async () => {
    const anna = await makeAccount('anna@example.com', 'free')

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/billing/manual',
      headers: { 'content-type': 'application/json', 'x-clinote-signature': 'not-a-signature' },
      payload: JSON.stringify({
        externalId: randomUUID(),
        type: 'subscription.activated',
        userId: anna.id,
        planId: 'business',
      }),
    })

    expect(response.statusCode).toBe(403)
    expect(await storage.stores.subscriptions.findByUserId(anna.id)).toBeNull()
  })
})
