import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import type { Storage } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'
import { createManualBillingProvider, signWebhook } from './index'

const WEBHOOK_SECRET = 'a-development-webhook-secret-value'

let app: FastifyInstance
let storage: Storage
let accessToken: string
let userId: string

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

function event(overrides: Record<string, unknown> = {}) {
  return {
    externalId: `evt_${Math.random().toString(36).slice(2)}`,
    type: 'subscription.activated',
    userId,
    planId: 'pro',
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    providerSubscriptionId: 'sub_123',
    ...overrides,
  }
}

async function webhook(body: Record<string, unknown>, signature?: string) {
  const raw = JSON.stringify(body)
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/billing/manual',
    headers: {
      'content-type': 'application/json',
      'x-clinote-signature': signature ?? signWebhook(raw, WEBHOOK_SECRET),
    },
    payload: raw,
  })
}

beforeEach(async () => {
  storage = await createTestStorage()
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      JWT_SECRET: 'a'.repeat(48),
      BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as NodeJS.ProcessEnv),
    storage,
    billing: createManualBillingProvider({
      webhookSecret: WEBHOOK_SECRET,
      checkoutBaseUrl: 'http://localhost:3000/billing/checkout',
    }),
  })
  await app.ready()

  const account = await register('anna@example.com')
  accessToken = account.token
  userId = account.id
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

describe('checkout', () => {
  it('returns a payment page and grants nothing yet', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/checkout',
      headers: auth(),
      payload: { planId: 'pro' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().url).toContain('/billing/checkout')

    // Starting a checkout is not paying for one.
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth() })
    expect(me.json().entitlement.planId).toBe('free')
    expect(me.json().entitlement.features.cloudSync).toBe(false)
  })

  it('refuses to sell the free plan or an unknown one', async () => {
    for (const planId of ['free', 'enterprise']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/subscriptions/checkout',
        headers: auth(),
        payload: { planId },
      })
      expect(response.statusCode).toBe(422)
    }
  })

  it('needs an account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/checkout',
      payload: { planId: 'pro' },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('webhooks', () => {
  it('activates a subscription and flips the entitlement', async () => {
    const response = await webhook(event())
    expect(response.statusCode).toBe(200)
    expect(response.json().applied).toBe(1)

    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth() })
    expect(me.json().entitlement.planId).toBe('pro')
    expect(me.json().entitlement.features.cloudSync).toBe(true)
    expect(me.json().entitlement.limits.storageBytes).toBe(10 * 1024 ** 3)
  })

  it('ignores a redelivery of the same event', async () => {
    const payload = event()
    await webhook(payload)
    const second = await webhook(payload)

    expect(second.statusCode).toBe(200)
    // Providers retry; a retry must change nothing.
    expect(second.json().applied).toBe(0)
  })

  it('refuses a body whose signature does not verify', async () => {
    const response = await webhook(event(), 'not-the-signature')

    expect(response.statusCode).toBe(403)
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth() })
    expect(me.json().entitlement.planId).toBe('free')
  })

  it('refuses a signature computed over a different body', async () => {
    const signature = signWebhook(JSON.stringify(event({ planId: 'business' })), WEBHOOK_SECRET)
    const response = await webhook(event({ planId: 'pro' }), signature)

    expect(response.statusCode).toBe(403)
  })

  it('rejects a verified body that is not a billing event', async () => {
    const response = await webhook({ hello: 'world' })
    expect(response.statusCode).toBe(422)
  })

  it('does not know a provider it was not configured with', async () => {
    const raw = JSON.stringify(event())
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/billing/stripe',
      headers: {
        'content-type': 'application/json',
        'x-clinote-signature': signWebhook(raw, WEBHOOK_SECRET),
      },
      payload: raw,
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('state transitions', () => {
  async function entitlement() {
    const response = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth() })
    return response.json().entitlement
  }

  it('keeps access while a payment is late, and takes it back when it expires', async () => {
    await webhook(event())
    expect((await entitlement()).features.cloudSync).toBe(true)

    // past_due is a warning, not a cut-off: cards fail for boring reasons.
    await webhook(event({ type: 'subscription.past_due' }))
    expect((await entitlement()).status).toBe('past_due')
    expect((await entitlement()).features.cloudSync).toBe(false)

    await webhook(event({ type: 'subscription.expired' }))
    const expired = await entitlement()
    expect(expired.planId).toBe('free')
    expect(expired.features.cloudBackup).toBe(false)
  })

  it('renews without interrupting anything', async () => {
    await webhook(event())
    const renewedUntil = new Date(Date.now() + 60 * 86_400_000).toISOString()
    await webhook(event({ type: 'subscription.renewed', currentPeriodEnd: renewedUntil }))

    const current = await entitlement()
    expect(current.features.cloudSync).toBe(true)
    expect(current.expiresAt).toBe(renewedUntil)
  })

  it('cancels through the provider and keeps access until the period ends', async () => {
    await webhook(event())

    const cancelled = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/cancel',
      headers: auth(),
    })

    expect(cancelled.statusCode).toBe(200)
    // The provider's webhook decides when access ends; until then it is paid for.
    expect(cancelled.json().entitlement.features.cloudSync).toBe(true)

    await webhook(event({ type: 'subscription.canceled' }))
    expect((await entitlement()).planId).toBe('free')
  })

  it('refuses to cancel what was never bought', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/cancel',
      headers: auth(),
    })
    expect(response.statusCode).toBe(404)
  })

  it('never lets one account webhook another into a plan', async () => {
    const other = await register('boris@example.com')
    await webhook(event({ userId: other.id }))

    expect((await entitlement()).planId).toBe('free')
    const theirs = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: auth(other.token),
    })
    expect(theirs.json().entitlement.planId).toBe('pro')
  })

  it('records an event for an account that no longer exists without failing', async () => {
    const response = await webhook(event({ userId: '11111111-1111-4111-8111-111111111111' }))
    expect(response.statusCode).toBe(200)
    expect(response.json().applied).toBe(1)
  })
})

describe('subscription view', () => {
  it('reports nothing before anything was bought', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/subscriptions/me',
      headers: auth(),
    })

    expect(response.json().subscription).toBeNull()
    expect(response.json().entitlement.planId).toBe('free')
  })

  it('reports the plan, the status and when it runs out', async () => {
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString()
    await webhook(event({ currentPeriodEnd: until }))

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/subscriptions/me',
      headers: auth(),
    })

    expect(response.json().subscription).toEqual({
      planId: 'pro',
      status: 'active',
      currentPeriodEnd: until,
    })
  })
})

describe('production safety', () => {
  it('refuses to start with the stand-in provider in production', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
        BILLING_PROVIDER: 'manual',
      } as NodeJS.ProcessEnv),
    ).toThrow(/takes no money/)
  })
})
