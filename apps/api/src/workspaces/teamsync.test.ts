/**
 * A shared stream is where roles stop being a label and start being enforced,
 * and where the audit log gets its content without the server gaining any.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import type { Storage } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'
import { actionForEnvelope } from './audit'

let app: FastifyInstance
let storage: Storage

interface Account {
  id: string
  token: string
  deviceId: string
}

const auth = (account: Account) => ({ authorization: `Bearer ${account.token}` })

const sealed = () => ({
  senderPublicKey: 'cHVibGlj',
  salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
  iv: 'aXZpdml2aXZpdml2',
  key: 'd3JhcHBlZA==',
})

function envelope(deviceId: string, overrides: Record<string, unknown> = {}) {
  return {
    operationId: randomUUID(),
    entityType: 'client',
    entityId: randomUUID(),
    operation: 'put',
    hlc: '000000001756108800000:00000:device-a',
    baseHlc: null,
    deviceId,
    payload: Buffer.from('ciphertext').toString('base64'),
    ...overrides,
  }
}

async function register(address: string): Promise<Account> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: address, password: 'correct horse battery staple' },
  })
  const body = response.json()
  return { id: body.user.id, token: body.tokens.accessToken, deviceId: randomUUID() }
}

async function registerDevice(account: Account) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/devices',
    headers: auth(account),
    payload: { id: account.deviceId, name: 'Test device', platform: 'web' },
  })
}

async function makeBusiness(userId: string): Promise<void> {
  await storage.stores.subscriptions.upsert({
    userId,
    planId: 'business',
    status: 'active',
    currentPeriodEnd: null,
  })
}

function push(account: Account, envelopes: unknown[], workspaceId?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: {
      ...auth(account),
      ...(workspaceId ? { 'x-clinote-workspace': workspaceId } : {}),
    },
    payload: { envelopes },
  })
}

function pull(account: Account, workspaceId?: string, since = 0) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/sync/changes?since=${since}`,
    headers: {
      ...auth(account),
      ...(workspaceId ? { 'x-clinote-workspace': workspaceId } : {}),
    },
  })
}

/** Owner with a workspace, plus one colleague in the given role. */
async function team(role: string) {
  const owner = await register('anna@example.com')
  await makeBusiness(owner.id)
  await registerDevice(owner)

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: auth(owner),
    payload: { id: randomUUID(), name: 'Main Clinic', sealedKey: sealed() },
  })
  const workspaceId = created.json().workspace.id as string

  const invitation = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/invites`,
    headers: auth(owner),
    payload: { email: 'boris@example.com', role },
  })
  const colleague = await register('boris@example.com')
  await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces/invites/accept',
    headers: auth(colleague),
    payload: { token: invitation.json().token },
  })
  // Only now can Boris register a device: joining the clinic is what pays for
  // it. Doing this before the invite would fail, which is the point.
  await registerDevice(colleague)

  return { owner, colleague, workspaceId }
}

beforeEach(async () => {
  storage = await createTestStorage()
  app = await buildApp({
    env: loadEnv({ NODE_ENV: 'test', JWT_SECRET: 'a'.repeat(48) } as NodeJS.ProcessEnv),
    storage,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

describe('the shared stream', () => {
  it('delivers a colleague’s changes to the other members', async () => {
    const { owner, colleague, workspaceId } = await team('doctor')

    await push(colleague, [envelope(colleague.deviceId)], workspaceId)
    const received = await pull(owner, workspaceId)

    expect(received.json().items).toHaveLength(1)
    // The relay is still blind: what came back is what went in.
    expect(received.json().items[0].payload).toBe(Buffer.from('ciphertext').toString('base64'))
  })

  it('keeps the personal stream and the workspace stream apart', async () => {
    const { owner, workspaceId } = await team('doctor')

    await push(owner, [envelope(owner.deviceId)])
    await push(owner, [envelope(owner.deviceId)], workspaceId)

    expect((await pull(owner)).json().items).toHaveLength(1)
    expect((await pull(owner, workspaceId)).json().items).toHaveLength(1)
  })

  it('gives each workspace its own cursor on the same device', async () => {
    const { owner, workspaceId } = await team('doctor')
    await push(owner, [envelope(owner.deviceId)], workspaceId)

    await app.inject({
      method: 'POST',
      url: '/api/v1/sync/cursor',
      headers: { ...auth(owner), 'x-clinote-workspace': workspaceId },
      payload: { deviceId: owner.deviceId, seq: 1 },
    })

    const inWorkspace = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
      headers: {
        ...auth(owner),
        'x-clinote-device': owner.deviceId,
        'x-clinote-workspace': workspaceId,
      },
    })
    const personal = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
      headers: { ...auth(owner), 'x-clinote-device': owner.deviceId },
    })

    expect(inWorkspace.json().deviceCursor).toBe(1)
    // Advancing one stream must not skip envelopes in the other.
    expect(personal.json().deviceCursor).toBe(0)
  })

  it('lets a viewer read and refuses to let them write', async () => {
    const { colleague, workspaceId } = await team('viewer')

    const wrote = await push(colleague, [envelope(colleague.deviceId)], workspaceId)
    expect(wrote.statusCode).toBe(403)

    // A modified client cannot push anyway — but it can still receive.
    expect((await pull(colleague, workspaceId)).statusCode).toBe(200)
  })

  it('refuses a stream the caller is not a member of', async () => {
    const { workspaceId } = await team('doctor')
    const stranger = await register('mallory@example.com')
    await makeBusiness(stranger.id)
    await registerDevice(stranger)

    expect((await pull(stranger, workspaceId)).statusCode).toBe(404)
    expect((await push(stranger, [envelope(stranger.deviceId)], workspaceId)).statusCode).toBe(404)
  })

  it('follows the owner’s plan, not the member’s', async () => {
    const { colleague, workspaceId } = await team('doctor')

    // Boris is on the free plan and has no cloud sync of his own — and still
    // works in his clinic's workspace, which the clinic pays for.
    const response = await pull(colleague, workspaceId)
    expect(response.statusCode).toBe(200)

    const personal = await pull(colleague)
    expect(personal.statusCode).toBe(403)
    expect(personal.json().error.code).toBe('feature_not_available')
  })

  it('stops when the clinic’s subscription lapses', async () => {
    const { owner, colleague, workspaceId } = await team('doctor')
    await storage.stores.subscriptions.upsert({
      userId: owner.id,
      planId: 'business',
      status: 'expired',
      currentPeriodEnd: new Date(Date.now() - 86_400_000).toISOString(),
    })

    const response = await pull(colleague, workspaceId)
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('feature_not_available')
  })
})

describe('the audit log', () => {
  it('records what happened without recording what it was about', async () => {
    const { owner, colleague, workspaceId } = await team('doctor')

    const clientId = randomUUID()
    await push(colleague, [envelope(colleague.deviceId, { entityId: clientId })], workspaceId)
    await push(
      colleague,
      [
        envelope(colleague.deviceId, {
          entityId: clientId,
          baseHlc: '000000001756108800000:00000:device-a',
        }),
      ],
      workspaceId,
    )

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/audit`,
      headers: auth(owner),
    })

    const actions = response.json().events.map((event: { action: string }) => event.action)
    expect(actions).toContain('CLIENT_CREATED')
    expect(actions).toContain('CLIENT_UPDATED')
    expect(actions).toContain('WORKSPACE_CREATED')

    const created = response
      .json()
      .events.find((event: { action: string }) => event.action === 'CLIENT_CREATED')
    expect(created.actorEmail).toBe('boris@example.com')
    expect(created.resourceId).toBe(clientId)
    // Everything the log knows is in that record. There is no name anywhere.
    expect(JSON.stringify(response.json())).not.toContain('ciphertext')
  })

  it('is closed to the people it records', async () => {
    const { colleague, workspaceId } = await team('doctor')

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/audit`,
      headers: auth(colleague),
    })
    expect(response.statusCode).toBe(403)
  })

  it('never records anything for a personal stream', async () => {
    const owner = await register('anna@example.com')
    await makeBusiness(owner.id)
    await registerDevice(owner)
    await push(owner, [envelope(owner.deviceId)])

    // A single-person account has nobody to be accountable to, and logging
    // their own actions back at them would be surveillance, not an audit.
    const events = await storage.stores.audit.listForUser(owner.id, { limit: 10 })
    expect(events).toHaveLength(0)
  })
})

describe('deriving an action from an envelope', () => {
  const base = {
    operationId: 'op',
    entityId: 'entity',
    operation: 'put' as const,
    hlc: 'h',
    baseHlc: null,
    deviceId: 'device',
    payload: 'x',
  }

  it('reads a creation from the absence of a previous version', () => {
    expect(actionForEnvelope({ ...base, entityType: 'client' })).toBe('CLIENT_CREATED')
    expect(actionForEnvelope({ ...base, entityType: 'client', baseHlc: 'h0' })).toBe(
      'CLIENT_UPDATED',
    )
    expect(actionForEnvelope({ ...base, entityType: 'client', operation: 'delete' })).toBe(
      'CLIENT_DELETED',
    )
  })

  it('logs only creations for the rest, to keep the log readable', () => {
    expect(actionForEnvelope({ ...base, entityType: 'work' })).toBe('WORK_CREATED')
    expect(actionForEnvelope({ ...base, entityType: 'work', baseHlc: 'h0' })).toBeNull()
    expect(actionForEnvelope({ ...base, entityType: 'file' })).toBe('FILE_ADDED')
    expect(actionForEnvelope({ ...base, entityType: 'appointment' })).toBe('APPOINTMENT_CREATED')
  })

  it('says nothing about an entity type it does not know', () => {
    expect(actionForEnvelope({ ...base, entityType: 'settings' })).toBeNull()
  })
})
