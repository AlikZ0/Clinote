/**
 * Organizations: the billing and identity boundary (Phase 18/19).
 *
 * These cover the invitation path end to end, because every step of it was
 * broken at once when it shipped: the plan limit read a free-plan entitlement
 * no matter what the organization paid for, the "already a member" check asked
 * about the inviter instead of the invitee, and the token was hashed, stored
 * and then dropped, so no invitation could ever be accepted.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import { createMemoryEmailSender } from '../notifications/senders'
import type { Storage } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'

let app: FastifyInstance
let storage: Storage
let email: ReturnType<typeof createMemoryEmailSender>

interface Account {
  id: string
  token: string
  email: string
}

const auth = (account: Account) => ({ authorization: `Bearer ${account.token}` })

async function register(address: string): Promise<Account> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: address, password: 'correct horse battery staple' },
  })
  const body = response.json()
  return { id: body.user.id, token: body.tokens.accessToken, email: address }
}

/** A team on an organization is what the Business plan pays for. */
async function makeBusiness(organizationId: string): Promise<void> {
  await storage.stores.subscriptions.upsert({
    userId: null,
    organizationId,
    planId: 'business',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  })
}

async function createOrg(account: Account, slug: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/organizations',
    headers: auth(account),
    payload: { name: `Practice ${slug}`, slug },
  })
  expect(response.statusCode).toBe(201)
  return response.json().organization.id
}

async function invite(
  account: Account,
  organizationId: string,
  address: string,
  role: 'admin' | 'billing' = 'admin',
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/organizations/${organizationId}/invites`,
    headers: auth(account),
    payload: { email: address, role },
  })
}

beforeEach(async () => {
  storage = await createTestStorage()
  email = createMemoryEmailSender()
  app = await buildApp({
    env: loadEnv({ ...process.env, NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32) }),
    storage,
    email,
  })
})

afterEach(async () => {
  await app.close()
  await storage.close()
})

afterAll(closeTestStorage)

describe('organization invitations', () => {
  it('lets a paid organization invite someone, and the invitation can be accepted', async () => {
    const owner = await register('owner-a@example.com')
    const colleague = await register('colleague-a@example.com')
    const organizationId = await createOrg(owner, 'practice-a')
    await makeBusiness(organizationId)

    const created = await invite(owner, organizationId, colleague.email)
    expect(created.statusCode).toBe(201)

    // Outside production the token comes back in the response; a deployment
    // with a mail server reads it out of the message instead.
    const token = created.json().token
    expect(token).toBeTruthy()
    expect(email.sent.at(-1)?.to).toBe(colleague.email)

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/invites/${token}/accept`,
      headers: auth(colleague),
    })
    expect(accepted.statusCode).toBe(200)

    const members = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: auth(owner),
    })
    expect(members.json().members).toHaveLength(2)
  })

  it('refuses a second invitation to somebody who already joined', async () => {
    const owner = await register('owner-b@example.com')
    const colleague = await register('colleague-b@example.com')
    const organizationId = await createOrg(owner, 'practice-b')
    await makeBusiness(organizationId)

    const first = await invite(owner, organizationId, colleague.email)
    await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/invites/${first.json().token}/accept`,
      headers: auth(colleague),
    })

    const second = await invite(owner, organizationId, colleague.email)
    expect(second.statusCode).toBe(422)
  })

  it('refuses a second outstanding invitation to the same address', async () => {
    const owner = await register('owner-c@example.com')
    const organizationId = await createOrg(owner, 'practice-c')
    await makeBusiness(organizationId)

    expect((await invite(owner, organizationId, 'pending-c@example.com')).statusCode).toBe(201)
    expect((await invite(owner, organizationId, 'pending-c@example.com')).statusCode).toBe(422)
  })

  it('stops a free organization at its plan limit, and says so as payment required', async () => {
    const owner = await register('owner-d@example.com')
    const organizationId = await createOrg(owner, 'practice-d')

    const refused = await invite(owner, organizationId, 'colleague-d@example.com')
    expect(refused.statusCode).toBe(402)
    expect(refused.json().error.code).toBe('member_limit_reached')
  })

  it('counts outstanding invitations against the limit', async () => {
    const owner = await register('owner-e@example.com')
    const organizationId = await createOrg(owner, 'practice-e')
    // Pro seats one person: the owner. An invitation must not slip past that
    // just because nobody has accepted it yet.
    await storage.stores.subscriptions.upsert({
      userId: null,
      organizationId,
      planId: 'pro',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    })

    expect((await invite(owner, organizationId, 'colleague-e@example.com')).statusCode).toBe(402)
  })

  it('reports a stale invitation as gone, not as a server fault', async () => {
    const owner = await register('owner-f@example.com')
    const colleague = await register('colleague-f@example.com')
    const organizationId = await createOrg(owner, 'practice-f')
    await makeBusiness(organizationId)

    const created = await invite(owner, organizationId, colleague.email)
    const token = created.json().token

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/invites/${token}/accept`,
      headers: auth(colleague),
    })
    expect(first.statusCode).toBe(200)

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/invites/${token}/accept`,
      headers: auth(colleague),
    })
    expect(replay.statusCode).toBe(410)
    expect(replay.json().error.code).toBe('invite_invalid')
  })

  it('refuses an invitation forwarded to somebody else', async () => {
    const owner = await register('owner-g@example.com')
    const invited = await register('invited-g@example.com')
    const stranger = await register('stranger-g@example.com')
    const organizationId = await createOrg(owner, 'practice-g')
    await makeBusiness(organizationId)

    const created = await invite(owner, organizationId, invited.email)
    const forwarded = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/invites/${created.json().token}/accept`,
      headers: auth(stranger),
    })

    expect(forwarded.statusCode).toBe(410)
  })
})

describe('organization permissions', () => {
  it('answers a non-member with 403, not 500', async () => {
    const owner = await register('owner-h@example.com')
    const outsider = await register('outsider-h@example.com')
    const organizationId = await createOrg(owner, 'practice-h')

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}`,
      headers: auth(outsider),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('forbidden')
  })

  it('answers a member whose role does not reach the action with 403, not 500', async () => {
    const owner = await register('owner-i@example.com')
    const accountant = await register('accountant-i@example.com')
    const organizationId = await createOrg(owner, 'practice-i')
    await makeBusiness(organizationId)

    const created = await invite(owner, organizationId, accountant.email, 'billing')
    await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/invites/${created.json().token}/accept`,
      headers: auth(accountant),
    })

    // 'billing' may read the plan; it may not bring in new people.
    const refused = await invite(accountant, organizationId, 'someone-i@example.com')
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.code).toBe('forbidden')
  })

  it('does not tell a stranger whether an organization exists beyond 403/404', async () => {
    const outsider = await register('outsider-j@example.com')
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
      headers: auth(outsider),
    })
    expect(response.statusCode).toBe(404)
  })
})
