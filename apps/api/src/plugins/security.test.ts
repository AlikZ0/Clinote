/**
 * The headers, and the one that is easy to get wrong: `no-store`.
 *
 * A response carrying wrapped key material or a presigned URL must not be
 * cacheable, and the plan catalogue must stay cacheable — a single rule that
 * covered both would be wrong in one direction or the other.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import type { Storage } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { registerSecurityHeaders } from './security'

let app: FastifyInstance
let storage: Storage

async function build(overrides: Record<string, string> = {}) {
  storage = await createTestStorage()
  const instance = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      JWT_SECRET: 'a'.repeat(48),
      ...overrides,
    } as NodeJS.ProcessEnv),
    storage,
  })
  await instance.ready()
  return instance
}

beforeEach(async () => {
  app = await build()
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

describe('security headers', () => {
  it('sends them on every response, including errors', async () => {
    for (const url of ['/health/live', '/api/v1/does-not-exist']) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['x-frame-options']).toBe('DENY')
      expect(response.headers['referrer-policy']).toBe('no-referrer')
      expect(response.headers['content-security-policy']).toContain("default-src 'none'")
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    }
  })

  it('does not claim HSTS over plain http in development', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' })
    expect(response.headers['strict-transport-security']).toBeUndefined()
  })

  it('sends HSTS in production and not before', async () => {
    // Exercised directly rather than through `buildApp`: a production
    // environment cannot even be loaded today, because the only billing
    // provider that exists is refused there. That guard has its own test.
    const production = Fastify()
    registerSecurityHeaders(production, { production: true })
    production.get('/probe', async () => ({ ok: true }))

    const response = await production.inject({ method: 'GET', url: '/probe' })
    expect(response.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    )
    await production.close()
  })
})

describe('caching', () => {
  it('refuses to let anything authenticated be stored', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'anna@example.com', password: 'correct horse battery staple' },
    })
    expect(registered.headers['cache-control']).toBe('no-store')

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${registered.json().tokens.accessToken}` },
    })
    expect(me.headers['cache-control']).toBe('no-store')
  })

  it('keeps the public plan catalogue cacheable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/plans' })
    // Prices are public and identical for everyone; making them uncacheable
    // would cost every visitor a round trip for no privacy gain.
    expect(response.headers['cache-control']).toBe('public, max-age=300')
  })
})

describe('client addresses', () => {
  /** Signs in and returns the address the audit log recorded for it. */
  async function signInFrom(forwardedFor: string, email: string): Promise<string | null> {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct horse battery staple' },
    })
    const userId = registered.json().user.id as string
    const token = registered.json().tokens.accessToken as string

    await storage.stores.subscriptions.upsert({
      userId,
      planId: 'business',
      status: 'active',
      currentPeriodEnd: null,
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        id: randomUUID(),
        name: 'Main Clinic',
        sealedKey: { senderPublicKey: 'cHVi', salt: 'c2FsdA==', iv: 'aXY=', key: 'a2V5' },
      },
    })

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': forwardedFor },
      payload: { email, password: 'correct horse battery staple' },
    })

    const events = await storage.stores.audit.listForUser(userId, { limit: 20 })
    return events.find((event) => event.action === 'LOGIN')?.ip ?? null
  }

  it('ignores a forged X-Forwarded-For when no proxy is declared', async () => {
    // A client must not be able to choose its own rate-limit bucket, or the
    // address that appears next to its name in a clinic's audit log.
    expect(await signInFrom('203.0.113.9', 'anna@example.com')).not.toBe('203.0.113.9')
  })

  it('honours the header when exactly one proxy is declared', async () => {
    await app.close()
    app = await build({ TRUST_PROXY: '1' })

    expect(await signInFrom('203.0.113.9', 'boris@example.com')).toBe('203.0.113.9')
  })
})
