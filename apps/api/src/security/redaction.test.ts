/**
 * Nothing sensitive leaves this process (docs/security.md §7, invariant I4).
 *
 * The interesting part is what these tests do *not* assume. They do not check
 * the redaction configuration; they run the real flows against a real logger
 * and then read every byte the process wrote, looking for the secrets that went
 * in. A future route that logs a request body, or an error message that
 * interpolates a client's name, fails here without anybody remembering to add
 * a case for it.
 */
import { Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import { backupEmail, createMemoryEmailSender, reminderEmail } from '../notifications/senders'
import type { Storage } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'

/** The values that must never appear anywhere but in the response they belong to. */
const SECRETS = {
  password: 'a-passphrase-nobody-should-see',
  clientName: 'Mariam-Sargsyan',
  clientNote: 'diagnosis-that-is-nobody-business',
  email: 'anna@example.com',
  sealedKey: 'c2VhbGVkLXdvcmtzcGFjZS1rZXk=',
}

let app: FastifyInstance
let storage: Storage
let logged: string
let email: ReturnType<typeof createMemoryEmailSender>

function capture(): Writable {
  logged = ''
  return new Writable({
    write(chunk, _encoding, callback) {
      logged += String(chunk)
      callback()
    },
  })
}

beforeEach(async () => {
  storage = await createTestStorage()
  email = createMemoryEmailSender()
  app = await buildApp({
    env: loadEnv({ NODE_ENV: 'test', JWT_SECRET: 'a'.repeat(48) } as NodeJS.ProcessEnv),
    storage,
    email,
    logDestination: capture(),
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

async function register(address = SECRETS.email) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { name: SECRETS.clientName, email: address, password: SECRETS.password },
  })
  return { id: response.json().user.id as string, token: response.json().tokens.accessToken }
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

describe('logs', () => {
  it('never contains a password, in any flow that carries one', async () => {
    await register()
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: SECRETS.email, password: SECRETS.password },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: SECRETS.email, password: 'the-wrong-one-entirely' },
    })

    expect(logged).not.toContain(SECRETS.password)
    expect(logged).not.toContain('the-wrong-one-entirely')
  })

  it('never contains an account email address', async () => {
    await register()
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: SECRETS.email },
    })

    expect(logged).not.toContain(SECRETS.email)
  })

  it('never contains a refresh token or an access token', async () => {
    const account = await register()
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: SECRETS.email, password: SECRETS.password },
    })

    const refreshCookie = login.cookies.find((entry) => entry.name === 'clinote_rt')
    expect(refreshCookie?.value).toBeTruthy()
    expect(logged).not.toContain(refreshCookie!.value)
    expect(logged).not.toContain(account.token)
  })

  it('never contains a sync payload, even a rejected one', async () => {
    const account = await register()
    await storage.stores.subscriptions.upsert({
      userId: account.id,
      planId: 'pro',
      status: 'active',
      currentPeriodEnd: null,
    })

    const deviceId = randomUUID()
    await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: auth(account.token),
      payload: { id: deviceId, name: 'Test device', platform: 'web' },
    })

    const payload = Buffer.from(SECRETS.clientNote).toString('base64')
    await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: auth(account.token),
      payload: {
        envelopes: [
          {
            operationId: randomUUID(),
            entityType: 'client',
            entityId: randomUUID(),
            operation: 'put',
            hlc: '000000001756108800000:00000:device-a',
            baseHlc: null,
            deviceId,
            payload,
          },
        ],
      },
    })

    // A real payload is ciphertext; this one is not, which is the point — if a
    // payload ever reached a log, a plaintext one would be readable there.
    expect(logged).not.toContain(payload)
    expect(logged).not.toContain(SECRETS.clientNote)
  })

  it('never contains wrapped key material or a sealed workspace key', async () => {
    const account = await register()
    await storage.stores.subscriptions.upsert({
      userId: account.id,
      planId: 'business',
      status: 'active',
      currentPeriodEnd: null,
    })

    await app.inject({
      method: 'PUT',
      url: '/api/v1/users/me/keys',
      headers: auth(account.token),
      payload: {
        kdf: 'pbkdf2-sha256',
        salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
        iterations: 600_000,
        wrappedDekSync: { iv: 'aXZpdml2aXZpdml2', key: SECRETS.sealedKey },
        wrappedDekRecovery: null,
      },
    })

    await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: auth(account.token),
      payload: {
        id: randomUUID(),
        name: 'Main Clinic',
        sealedKey: {
          senderPublicKey: 'cHVibGlj',
          salt: 'c2FsdA==',
          iv: 'aXY=',
          key: SECRETS.sealedKey,
        },
      },
    })

    expect(logged).not.toContain(SECRETS.sealedKey)
  })

  it('logs enough to debug with: method, path and status', async () => {
    // The counterpart to everything above. Redaction that removed the request
    // line as well would be safe and useless.
    await app.inject({ method: 'GET', url: '/api/v1/plans' })
    expect(logged).toContain('/api/v1/plans')
    expect(logged).toContain('"statusCode":200')
  })
})

describe('responses', () => {
  it('does not echo back what was submitted when validation fails', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', password: SECRETS.password },
    })

    expect(response.statusCode).toBe(422)
    // Field paths, never field values: an error that quoted the input would
    // reflect it straight back into whatever renders the message.
    expect(response.body).not.toContain(SECRETS.password)
    expect(response.body).not.toContain('not-an-email')
    expect(response.json().error.details.fields).toContain('email')
  })

  it('says nothing specific when something breaks internally', async () => {
    // A real failure through a real route: the storage layer gives out, the way
    // it would if the database went away mid-request.
    storage.stores.plans.listPublic = async () => {
      throw new Error(`connect ECONNREFUSED 10.0.0.5:5432 while reading ${SECRETS.clientName}`)
    }

    const response = await app.inject({ method: 'GET', url: '/api/v1/plans' })

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('ECONNREFUSED')
    expect(response.body).not.toContain('10.0.0.5')
    expect(response.body).not.toContain(SECRETS.clientName)
    expect(response.json().error).toMatchObject({ code: 'internal', details: {} })
  })

  it('tells a stranger nothing about whether an account exists', async () => {
    await register()

    const known = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: SECRETS.email },
    })
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'nobody@example.com' },
    })

    expect(known.statusCode).toBe(unknown.statusCode)
    expect(known.body).toBe(unknown.body)
  })

  it('gives the same answer for a wrong password and a missing account', async () => {
    await register()

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: SECRETS.email, password: 'not-the-password-at-all' },
    })
    const noAccount = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'not-the-password-at-all' },
    })

    expect(wrongPassword.statusCode).toBe(noAccount.statusCode)
    expect(wrongPassword.json().error).toEqual(noAccount.json().error)
  })
})

describe('email', () => {
  it('carries counts and times, never a person', () => {
    const reminder = reminderEmail('doctor@example.com', 'tomorrow', 3)
    const failure = backupEmail('doctor@example.com', 'failed', {
      errorCode: 'storage_limit_reached',
      at: '2026-08-25',
    })

    for (const message of [reminder, failure]) {
      expect(message.text).not.toContain(SECRETS.clientName)
      expect(message.text).not.toContain(SECRETS.clientNote)
      // The recipient's own address is the only address in it.
      expect(message.text).not.toContain('@')
    }
    expect(reminder.text).toContain('3')
  })

  it('names the workspace in an invitation and nothing else', async () => {
    const account = await register()
    await storage.stores.subscriptions.upsert({
      userId: account.id,
      planId: 'business',
      status: 'active',
      currentPeriodEnd: null,
    })

    const workspaceId = randomUUID()
    await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: auth(account.token),
      payload: {
        id: workspaceId,
        name: 'Main Clinic',
        sealedKey: { senderPublicKey: 'cHVi', salt: 'c2FsdA==', iv: 'aXY=', key: 'a2V5' },
      },
    })
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/invites`,
      headers: auth(account.token),
      payload: { email: 'boris@example.com', role: 'doctor' },
    })

    const invitation = email.sent.at(-1)!
    expect(invitation.text).toContain('Main Clinic')
    // Not the inviter's address, and nothing about the practice's records.
    expect(invitation.text).not.toContain(SECRETS.email)
    expect(invitation.text).not.toContain(SECRETS.clientName)
  })
})
