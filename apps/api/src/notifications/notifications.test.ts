import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@clinote/types'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import type { Storage, Stores } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'
import { deliverDueReminders } from './scheduler'
import {
  backupEmail,
  createMemoryEmailSender,
  createMemoryPushSender,
  reminderEmail,
  securityEmail,
} from './senders'

let app: FastifyInstance
let storage: Storage
let stores: Stores
let accessToken: string
let userId: string

const REF = 'ref-' + 'a'.repeat(20)
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString()

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

async function putSchedules(schedules: unknown[], refs = [REF], token = accessToken) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/appointments/schedules',
    headers: auth(token),
    payload: { refs, schedules },
  })
}

beforeEach(async () => {
  storage = await createTestStorage()
  stores = storage.stores
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      JWT_SECRET: 'a'.repeat(48),
      VAPID_PUBLIC_KEY: 'test-public-key',
    } as NodeJS.ProcessEnv),
    storage,
  })
  await app.ready()

  const account = await register('anna@example.com')
  accessToken = account.token
  userId = account.id
  await enablePro(userId)
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

describe('minimum disclosure', () => {
  it('stores an instant, a reference and a channel — and nothing else', async () => {
    await putSchedules([{ ref: REF, fireAt: TOMORROW, kind: 'tomorrow', channel: 'email' }])

    const [row] = await stores.reminders.listForUser(userId)
    expect(row).toMatchObject({ appointmentRef: REF, kind: 'tomorrow', channel: 'email' })
    // Nothing in the record could describe a person.
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'appointmentRef',
      'attempts',
      'channel',
      'createdAt',
      'fireAt',
      'id',
      'kind',
      'lastError',
      'sentAt',
      'state',
      'userId',
    ])
  })

  it('rejects anything that tries to smuggle a title through', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/appointments/schedules',
      headers: auth(),
      payload: {
        refs: [REF],
        schedules: [
          { ref: REF, fireAt: TOMORROW, kind: 'tomorrow', channel: 'push', title: 'Ivan Petrov' },
        ],
      },
    })

    expect(response.statusCode).toBe(204)
    const serialized = JSON.stringify(await stores.reminders.listForUser(userId))
    expect(serialized).not.toContain('Ivan')
    expect(serialized).not.toContain('title')
  })
})

describe('schedule lifecycle', () => {
  it('replaces the schedules for a reference rather than adding to them', async () => {
    await putSchedules([
      { ref: REF, fireAt: TOMORROW, kind: 'tomorrow', channel: 'email' },
      { ref: REF, fireAt: TOMORROW, kind: 'before', channel: 'push' },
    ])
    expect(await stores.reminders.listForUser(userId)).toHaveLength(2)

    // The appointment moved: one reminder now, not three.
    await putSchedules([{ ref: REF, fireAt: TOMORROW, kind: 'before', channel: 'push' }])
    const rows = await stores.reminders.listForUser(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('before')
  })

  it('withdraws every schedule for a cancelled appointment', async () => {
    await putSchedules([{ ref: REF, fireAt: TOMORROW, kind: 'tomorrow', channel: 'email' }])

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/appointments/schedules',
      headers: auth(),
      payload: { refs: [REF] },
    })

    expect(response.statusCode).toBe(204)
    expect(await stores.reminders.listForUser(userId)).toEqual([])
  })

  it('refuses reminders on Free', async () => {
    const free = await register('free@example.com')
    const response = await putSchedules(
      [{ ref: REF, fireAt: TOMORROW, kind: 'tomorrow', channel: 'email' }],
      [REF],
      free.token,
    )

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('feature_not_available')
  })

  it('keeps one account schedules away from another', async () => {
    await putSchedules([{ ref: REF, fireAt: TOMORROW, kind: 'tomorrow', channel: 'email' }])

    const other = await register('boris@example.com')
    await enablePro(other.id)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/appointments/schedules',
      headers: auth(other.token),
    })
    expect(listed.json()).toEqual([])
  })
})

describe('delivery', () => {
  const past = new Date(Date.now() - 60_000).toISOString()

  it('sends an email that says how many, and never who', async () => {
    await putSchedules([{ ref: REF, fireAt: past, kind: 'tomorrow', channel: 'email' }])
    const email = createMemoryEmailSender()

    const result = await deliverDueReminders({
      stores,
      email,
      push: createMemoryPushSender(),
    })

    expect(result.delivered).toBe(1)
    expect(email.sent[0]?.to).toBe('anna@example.com')
    expect(email.sent[0]?.text).toContain('1 appointment tomorrow')
    expect(email.sent[0]?.text).toMatch(/on your device, not in this email/)
  })

  it('sends a push payload with no content in it', async () => {
    await putSchedules([{ ref: REF, fireAt: past, kind: 'before', channel: 'push' }])
    await stores.pushSubscriptions.upsert({
      id: randomUUID(),
      userId,
      deviceId: null,
      endpoint: 'https://push.example.com/abc',
      p256dh: 'key',
      auth: 'auth',
      createdAt: new Date().toISOString(),
      failedAt: null,
    })

    const push = createMemoryPushSender()
    await deliverDueReminders({ stores, email: createMemoryEmailSender(), push })

    expect(push.sent).toHaveLength(1)
    // `{ kind, ref }` and nothing else: the device renders the sentence.
    expect(Object.keys(push.sent[0]?.payload ?? {}).sort()).toEqual(['kind', 'ref'])
    expect(push.sent[0]?.payload.kind).toBe('reminder.before')
  })

  it('does not deliver anything that is not due yet', async () => {
    await putSchedules([{ ref: REF, fireAt: TOMORROW, kind: 'tomorrow', channel: 'email' }])
    const email = createMemoryEmailSender()

    const result = await deliverDueReminders({
      stores,
      email,
      push: createMemoryPushSender(),
    })

    expect(result.delivered).toBe(0)
    expect(email.sent).toEqual([])
  })

  it('delivers each reminder once', async () => {
    await putSchedules([{ ref: REF, fireAt: past, kind: 'tomorrow', channel: 'email' }])
    const email = createMemoryEmailSender()
    const deps = { stores, email, push: createMemoryPushSender() }

    await deliverDueReminders(deps)
    await deliverDueReminders(deps)

    expect(email.sent).toHaveLength(1)
  })

  it('honours a preference set after the schedule was written', async () => {
    await putSchedules([{ ref: REF, fireAt: past, kind: 'tomorrow', channel: 'email' }])
    await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/preferences',
      headers: auth(),
      payload: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        appointments: {
          ...DEFAULT_NOTIFICATION_PREFERENCES.appointments,
          tomorrow: { push: false, email: false },
        },
      },
    })

    const email = createMemoryEmailSender()
    const result = await deliverDueReminders({
      stores,
      email,
      push: createMemoryPushSender(),
    })

    expect(result.skipped).toBe(1)
    expect(email.sent).toEqual([])
  })

  it('prunes a subscription the push service says is gone', async () => {
    await putSchedules([{ ref: REF, fireAt: past, kind: 'before', channel: 'push' }])
    await stores.pushSubscriptions.upsert({
      id: randomUUID(),
      userId,
      deviceId: null,
      endpoint: 'https://push.example.com/expired',
      p256dh: 'key',
      auth: 'auth',
      createdAt: new Date().toISOString(),
      failedAt: null,
    })

    const result = await deliverDueReminders({
      stores,
      email: createMemoryEmailSender(),
      push: createMemoryPushSender('gone'),
    })

    expect(result.pruned).toBe(1)
    expect(await stores.pushSubscriptions.listForUser(userId)).toEqual([])
  })

  it('records a failure instead of crashing the run', async () => {
    await putSchedules([{ ref: REF, fireAt: past, kind: 'tomorrow', channel: 'email' }])

    const result = await deliverDueReminders({
      stores,
      email: {
        async send() {
          throw new Error('smtp is down')
        },
      },
      push: createMemoryPushSender(),
    })

    expect(result.failed).toBe(1)
    const [row] = await stores.reminders.listForUser(userId)
    expect(row).toMatchObject({ state: 'failed', attempts: 1 })
    expect(row?.lastError).toBe('smtp is down')
  })
})

describe('email content', () => {
  it('never names a client, in any template', () => {
    const messages = [
      reminderEmail('anna@example.com', 'tomorrow', 3),
      reminderEmail('anna@example.com', 'before', 1),
      backupEmail('anna@example.com', 'completed', { sizeBytes: 2048, at: '2026-08-25' }),
      backupEmail('anna@example.com', 'failed', {
        errorCode: 'network_unavailable',
        at: '2026-08-25',
      }),
      securityEmail('anna@example.com', 'a new device signed in', '2026-08-25'),
    ]

    for (const message of messages) {
      // The product name is the one legitimate occurrence of "note".
      const body = `${message.subject}\n${message.text}`.toLowerCase().replaceAll('clinote', '')

      for (const forbidden of ['petrov', 'ivan', 'x-ray', 'diagnosis', 'note', 'client']) {
        expect(body).not.toContain(forbidden)
      }
    }
  })

  it('says how many appointments, in words that fit the number', () => {
    expect(reminderEmail('a@b.c', 'tomorrow', 1).text).toContain('1 appointment tomorrow')
    expect(reminderEmail('a@b.c', 'tomorrow', 3).text).toContain('3 appointments tomorrow')
  })

  it('reports a backup failure with a code and no blame', () => {
    const message = backupEmail('a@b.c', 'failed', {
      errorCode: 'storage_limit_reached',
      at: 'now',
    })
    expect(message.subject).toBe('Backup failed')
    expect(message.text).toContain('storage_limit_reached')
    expect(message.text).toContain('retry')
  })
})

describe('push subscriptions', () => {
  it('registers and removes a subscription', async () => {
    const subscription = {
      endpoint: 'https://push.example.com/abc',
      keys: { p256dh: 'key', auth: 'auth' },
    }

    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/push/subscribe',
      headers: auth(),
      payload: subscription,
    })
    expect(added.statusCode).toBe(204)
    expect(await stores.pushSubscriptions.listForUser(userId)).toHaveLength(1)

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications/push/subscribe',
      headers: auth(),
      payload: { endpoint: subscription.endpoint },
    })
    expect(removed.statusCode).toBe(204)
    expect(await stores.pushSubscriptions.listForUser(userId)).toEqual([])
  })

  it('will not let one account remove another subscription', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/push/subscribe',
      headers: auth(),
      payload: { endpoint: 'https://push.example.com/mine', keys: { p256dh: 'k', auth: 'a' } },
    })

    const other = await register('boris@example.com')
    await app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications/push/subscribe',
      headers: auth(other.token),
      payload: { endpoint: 'https://push.example.com/mine' },
    })

    expect(await stores.pushSubscriptions.listForUser(userId)).toHaveLength(1)
  })

  it('publishes the public key the device needs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/notifications/push/key' })
    expect(response.json()).toEqual({ publicKey: 'test-public-key' })
  })
})

describe('preferences', () => {
  it('starts from a default that is quiet but not silent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/preferences',
      headers: auth(),
    })

    expect(response.json()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    // A failed backup is worth interrupting someone for; a successful one is not.
    expect(response.json().backup.failed.email).toBe(true)
    expect(response.json().backup.completed.email).toBe(false)
  })

  it('round-trips a change', async () => {
    const updated = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      appointments: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.appointments,
        thirtyMinutes: { push: false, email: true },
      },
    }

    await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/preferences',
      headers: auth(),
      payload: updated,
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/preferences',
      headers: auth(),
    })
    expect(response.json()).toEqual(updated)
  })

  it('will not let security alerts be switched off', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/preferences',
      headers: auth(),
      payload: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        security: { alerts: false },
      },
    })

    expect(response.statusCode).toBe(422)
  })
})
