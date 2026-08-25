import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import { createMemoryEmailSender } from '../notifications/senders'
import type { Storage } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'

let app: FastifyInstance
let storage: Storage
let email: ReturnType<typeof createMemoryEmailSender>

/** A sealed key is opaque to the server; any well-formed blob will do here. */
const sealed = (marker = 'AAAA') => ({
  senderPublicKey: Buffer.from('public-key').toString('base64'),
  salt: Buffer.from('saltsaltsaltsalt').toString('base64'),
  iv: Buffer.from('ivivivivivvi').toString('base64'),
  key: Buffer.from(`wrapped-${marker}`).toString('base64'),
})

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

/** Business is what pays for a workspace; the owner is who pays it. */
async function makeBusiness(userId: string): Promise<void> {
  await storage.stores.subscriptions.upsert({
    userId,
    planId: 'business',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  })
}

async function publishIdentity(account: Account, marker: string): Promise<void> {
  await app.inject({
    method: 'PUT',
    url: '/api/v1/users/me/identity',
    headers: auth(account),
    payload: {
      publicKey: Buffer.from(`identity-${marker}`).toString('base64'),
      wrappedPrivateKey: { iv: 'aXZpdml2aXZpdml2', key: Buffer.from('wrapped').toString('base64') },
    },
  })
}

async function createWorkspace(owner: Account, name = 'Main Clinic'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: auth(owner),
    payload: { id: randomUUID(), name, sealedKey: sealed('owner') },
  })
  return response.json().workspace.id
}

async function invite(owner: Account, workspaceId: string, address: string, role: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/invites`,
    headers: auth(owner),
    payload: { email: address, role },
  })
  return response
}

async function join(account: Account, token: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/workspaces/invites/accept',
    headers: auth(account),
    payload: { token },
  })
}

beforeEach(async () => {
  storage = await createTestStorage()
  email = createMemoryEmailSender()
  app = await buildApp({
    env: loadEnv({ NODE_ENV: 'test', JWT_SECRET: 'a'.repeat(48) } as NodeJS.ProcessEnv),
    storage,
    email,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

describe('creating a workspace', () => {
  it('is refused without a Business subscription', async () => {
    const owner = await register('anna@example.com')
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: auth(owner),
      payload: { id: randomUUID(), name: 'Main Clinic', sealedKey: sealed() },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('feature_not_available')
  })

  it('makes the creator the owner and stores their sealed key', async () => {
    const owner = await register('anna@example.com')
    await makeBusiness(owner.id)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: auth(owner),
      payload: { id: randomUUID(), name: 'Main Clinic', sealedKey: sealed('anna') },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().workspace).toMatchObject({ name: 'Main Clinic', role: 'owner' })

    const key = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${response.json().workspace.id}/key`,
      headers: auth(owner),
    })
    expect(key.json().sealedKey.key).toBe(sealed('anna').key)
  })

  it('refuses a workspace beyond the plan’s limit', async () => {
    const owner = await register('anna@example.com')
    await storage.stores.subscriptions.upsert({
      userId: owner.id,
      planId: 'business',
      status: 'active',
      currentPeriodEnd: null,
    })

    // The business plan allows ten; create them and ask for one more.
    for (let index = 0; index < 10; index += 1) await createWorkspace(owner, `Branch ${index}`)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: auth(owner),
      payload: { id: randomUUID(), name: 'One too many', sealedKey: sealed() },
    })
    expect(response.statusCode).toBe(402)
    expect(response.json().error.code).toBe('workspace_limit_reached')
  })
})

describe('invitations', () => {
  it('emails a code that has no client data in it', async () => {
    const owner = await register('anna@example.com')
    await makeBusiness(owner.id)
    const workspaceId = await createWorkspace(owner)

    const response = await invite(owner, workspaceId, 'boris@example.com', 'doctor')

    expect(response.statusCode).toBe(201)
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]!.to).toBe('boris@example.com')
    expect(email.sent[0]!.text).toContain('Main Clinic')
  })

  it('lets the invited person join, without giving them the data', async () => {
    const owner = await register('anna@example.com')
    await makeBusiness(owner.id)
    const workspaceId = await createWorkspace(owner)
    const invitation = await invite(owner, workspaceId, 'boris@example.com', 'doctor')

    const boris = await register('boris@example.com')
    const joined = await join(boris, invitation.json().token)

    expect(joined.statusCode).toBe(200)
    expect(joined.json()).toMatchObject({ awaitingKey: true })

    // Membership is not access: nobody has sealed the key to Boris yet.
    const key = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/key`,
      headers: auth(boris),
    })
    expect(key.statusCode).toBe(404)
    expect(key.json().error.code).toBe('workspace_key_unavailable')
  })

  it('refuses a forwarded invitation', async () => {
    const owner = await register('anna@example.com')
    await makeBusiness(owner.id)
    const workspaceId = await createWorkspace(owner)
    const invitation = await invite(owner, workspaceId, 'boris@example.com', 'doctor')

    const stranger = await register('mallory@example.com')
    const response = await join(stranger, invitation.json().token)

    expect(response.statusCode).toBe(410)
    expect(response.json().error.code).toBe('invite_invalid')
  })

  it('refuses the same invitation twice', async () => {
    const owner = await register('anna@example.com')
    await makeBusiness(owner.id)
    const workspaceId = await createWorkspace(owner)
    const invitation = await invite(owner, workspaceId, 'boris@example.com', 'doctor')

    const boris = await register('boris@example.com')
    await join(boris, invitation.json().token)
    const second = await join(boris, invitation.json().token)

    expect(second.statusCode).toBe(410)
  })

  it('counts pending invitations against the member limit', async () => {
    const owner = await register('anna@example.com')
    await storage.stores.subscriptions.upsert({
      userId: owner.id,
      planId: 'business',
      status: 'active',
      currentPeriodEnd: null,
    })
    const workspaceId = await createWorkspace(owner)

    // 25 members allowed, the owner is one of them: 24 invitations fit.
    for (let index = 0; index < 24; index += 1) {
      const response = await invite(owner, workspaceId, `member${index}@example.com`, 'assistant')
      expect(response.statusCode).toBe(201)
    }

    const overflow = await invite(owner, workspaceId, 'late@example.com', 'assistant')
    expect(overflow.statusCode).toBe(402)
    expect(overflow.json().error.code).toBe('member_limit_reached')
  })
})

describe('roles', () => {
  async function withMember(role: string) {
    const owner = await register('anna@example.com')
    await makeBusiness(owner.id)
    const workspaceId = await createWorkspace(owner)
    const invitation = await invite(owner, workspaceId, 'boris@example.com', role)
    const member = await register('boris@example.com')
    await join(member, invitation.json().token)
    return { owner, member, workspaceId }
  }

  it('stops a doctor from inviting people', async () => {
    const { member, workspaceId } = await withMember('doctor')

    const response = await invite(member, workspaceId, 'carol@example.com', 'assistant')
    expect(response.statusCode).toBe(403)
    expect(response.json().error.details).toMatchObject({ role: 'doctor' })
  })

  it('stops an admin from renaming the workspace', async () => {
    const { member, workspaceId } = await withMember('admin')

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspaceId}`,
      headers: auth(member),
      payload: { name: 'Mine now' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('stops an admin from changing the owner’s role', async () => {
    const { owner, member, workspaceId } = await withMember('admin')

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspaceId}/members/${owner.id}`,
      headers: auth(member),
      payload: { role: 'viewer' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('hides a workspace from someone who is not in it', async () => {
    const { workspaceId } = await withMember('doctor')
    const stranger = await register('mallory@example.com')

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/members`,
      headers: auth(stranger),
    })
    // Not 403: a stranger learns nothing about whether this workspace exists.
    expect(response.statusCode).toBe(404)
  })

  it('lets a member leave on their own', async () => {
    const { member, workspaceId } = await withMember('doctor')

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspaceId}/members/${member.id}`,
      headers: auth(member),
    })
    expect(response.statusCode).toBe(204)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces',
      headers: auth(member),
    })
    expect(list.json().workspaces).toHaveLength(0)
  })

  it('refuses to remove the owner', async () => {
    const { owner, member, workspaceId } = await withMember('admin')

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspaceId}/members/${owner.id}`,
      headers: auth(member),
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('granting access to the data', () => {
  it('hands the sealed key over and revokes it when the member leaves', async () => {
    const owner = await register('anna@example.com')
    await makeBusiness(owner.id)
    const workspaceId = await createWorkspace(owner)
    const invitation = await invite(owner, workspaceId, 'boris@example.com', 'doctor')
    const boris = await register('boris@example.com')
    await join(boris, invitation.json().token)
    await publishIdentity(boris, 'boris')

    const pending = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/keys/pending`,
      headers: auth(owner),
    })
    expect(pending.json().pending).toHaveLength(1)
    expect(pending.json().pending[0]).toMatchObject({ email: 'boris@example.com' })
    expect(pending.json().pending[0].publicKey).not.toBeNull()

    const granted = await app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${workspaceId}/keys/${boris.id}`,
      headers: auth(owner),
      payload: { sealedKey: sealed('for-boris') },
    })
    expect(granted.statusCode).toBe(200)

    const key = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/key`,
      headers: auth(boris),
    })
    expect(key.json().sealedKey.key).toBe(sealed('for-boris').key)

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspaceId}/members/${boris.id}`,
      headers: auth(owner),
    })

    const afterRemoval = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/key`,
      headers: auth(boris),
    })
    expect(afterRemoval.statusCode).toBe(404)
  })

  it('refuses to let someone grant a key they do not hold', async () => {
    const owner = await register('anna@example.com')
    await makeBusiness(owner.id)
    const workspaceId = await createWorkspace(owner)

    const invitation = await invite(owner, workspaceId, 'boris@example.com', 'admin')
    const boris = await register('boris@example.com')
    await join(boris, invitation.json().token)

    const carolInvite = await invite(owner, workspaceId, 'carol@example.com', 'doctor')
    const carol = await register('carol@example.com')
    await join(carol, carolInvite.json().token)

    // Boris is an admin but has never been granted the key himself. Whatever he
    // would seal cannot be the workspace key, so the grant is refused outright.
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${workspaceId}/keys/${carol.id}`,
      headers: auth(boris),
      payload: { sealedKey: sealed('nonsense') },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('workspace_key_unavailable')
  })

  it('will not let a published identity key be silently replaced', async () => {
    const boris = await register('boris@example.com')
    await publishIdentity(boris, 'first')

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/users/me/identity',
      headers: auth(boris),
      payload: {
        publicKey: Buffer.from('identity-second').toString('base64'),
        wrappedPrivateKey: { iv: 'aXZpdml2aXZpdml2', key: 'd3JhcHBlZA==' },
      },
    })
    expect(response.statusCode).toBe(403)
  })
})
