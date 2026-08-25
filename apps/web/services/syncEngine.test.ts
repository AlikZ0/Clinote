import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '@clinote/shared'
import type { LocalCore } from '~/database'
import { createTestCore, draftAppointment, draftClient, draftWork } from '../test/factories'
import { FakeSyncServer } from '../test/fakeServer'
import { ClientService } from './clientService'
import { ConflictService } from './conflictService'
import { createKeyMaterial, unlockKeyMaterial, type EnvelopeCipher } from './encryption'
import { SyncEngine } from './syncEngine'

let server: FakeSyncServer
let cipher: EnvelopeCipher
let deviceA: LocalCore
let deviceB: LocalCore
let syncA: SyncEngine
let syncB: SyncEngine

const PASSPHRASE = 'correct horse battery staple'

beforeEach(async () => {
  server = new FakeSyncServer()

  // Both devices unlock the same account key, which is the only way device B
  // can read anything device A wrote.
  const setup = await createKeyMaterial(PASSPHRASE)
  cipher = setup.cipher
  const { cipher: cipherB } = await unlockKeyMaterial(PASSPHRASE, setup.material)

  deviceA = await createTestCore()
  deviceB = await createTestCore()
  syncA = new SyncEngine(deviceA, server.transport(), cipher)
  syncB = new SyncEngine(deviceB, server.transport(), cipherB)
})

afterEach(() => {
  deviceA.close()
  deviceB.close()
})

describe('replication', () => {
  it('carries a record from one device to the other', async () => {
    const client = await new ClientService(deviceA).create(
      draftClient({ lastName: 'Petrov', notes: 'clinical note' }),
    )

    await syncA.syncOnce()
    const outcome = await syncB.syncOnce()

    expect(outcome.applied).toBe(1)
    const copy = await deviceB.clients.getById(client.id)
    expect(copy).toMatchObject({ lastName: 'Petrov', notes: 'clinical note' })
    // Identity and causal ordering survive the trip.
    expect(copy?.hlc).toBe(client.hlc)
  })

  it('sends nothing the server can read', async () => {
    await new ClientService(deviceA).create(draftClient({ lastName: 'Petrov', notes: 'secret' }))
    await syncA.drain()

    const payloads = server.payloads().join('')
    expect(payloads).not.toContain('Petrov')
    expect(payloads).not.toContain('secret')
    // ...and it is a real envelope, not just base64 of the plaintext.
    expect(Buffer.from(payloads, 'base64').toString('utf8')).not.toContain('Petrov')
  })

  it('replicates works, appointments and deletions', async () => {
    const clients = new ClientService(deviceA)
    const client = await clients.create(draftClient())
    const work = await deviceA.works.create(draftWork(client.id, { title: 'Consultation' }))
    await deviceA.appointments.create(draftAppointment(client.id))

    await syncA.syncOnce()
    await syncB.syncOnce()

    expect(await deviceB.works.getById(work.id)).toMatchObject({ title: 'Consultation' })
    expect(await deviceB.appointments.count()).toBe(1)

    await deviceA.works.softDelete(work.id)
    await syncA.syncOnce()
    await syncB.syncOnce()

    expect(await deviceB.works.getById(work.id)).toBeNull()
    expect(await deviceB.works.getById(work.id, { includeDeleted: true })).not.toBeNull()
  })

  it('does not echo a device own envelopes back into itself', async () => {
    const client = await new ClientService(deviceA).create(draftClient())
    await syncA.syncOnce()

    const second = await syncA.syncOnce()

    expect(second.applied).toBe(0)
    expect(await deviceA.clients.getById(client.id)).not.toBeNull()
  })

  it('converges when both devices edit different records', async () => {
    const a = await new ClientService(deviceA).create(draftClient({ lastName: 'FromA' }))
    const b = await new ClientService(deviceB).create(draftClient({ lastName: 'FromB' }))

    await syncA.syncOnce()
    await syncB.syncOnce()
    await syncA.syncOnce()

    expect(await deviceA.clients.count()).toBe(2)
    expect(await deviceB.clients.count()).toBe(2)
    expect(await deviceB.clients.getById(a.id)).not.toBeNull()
    expect(await deviceA.clients.getById(b.id)).not.toBeNull()
  })
})

describe('ordering', () => {
  it('keeps the newer version when the same record is edited twice', async () => {
    const client = await new ClientService(deviceA).create(draftClient({ firstName: 'First' }))
    await syncA.syncOnce()
    await syncB.syncOnce()

    await deviceA.clients.update(client.id, { firstName: 'Second' })
    await syncA.syncOnce()
    await syncB.syncOnce()

    expect(await deviceB.clients.getById(client.id)).toMatchObject({ firstName: 'Second' })
  })

  it('ignores an older version arriving after a newer local edit', async () => {
    const client = await new ClientService(deviceA).create(draftClient({ firstName: 'Original' }))
    await syncA.syncOnce()
    await syncB.syncOnce()

    // Device B moves ahead and publishes.
    await deviceB.clients.update(client.id, { firstName: 'NewerOnB' })
    await syncB.syncOnce()

    // Device A pulls B's change, then a stale copy of its own arrives again.
    await syncA.syncOnce()
    expect(await deviceA.clients.getById(client.id)).toMatchObject({ firstName: 'NewerOnB' })

    // Replaying the whole stream changes nothing.
    await deviceA.sync.setCursor(0)
    const replay = await syncA.pull()
    expect(replay.applied).toBe(0)
    expect(await deviceA.clients.getById(client.id)).toMatchObject({ firstName: 'NewerOnB' })
  })

  it('applies a delete that wins and a delete that loses, identically on both devices', async () => {
    const client = await new ClientService(deviceA).create(draftClient())
    await syncA.syncOnce()
    await syncB.syncOnce()

    await deviceA.clients.softDelete(client.id)
    await syncA.syncOnce()
    await syncB.syncOnce()

    const onA = await deviceA.clients.getById(client.id, { includeDeleted: true })
    const onB = await deviceB.clients.getById(client.id, { includeDeleted: true })
    expect(onA?.deletedAt).not.toBeNull()
    expect(onB?.deletedAt).toBe(onA?.deletedAt)
    expect(onB?.hlc).toBe(onA?.hlc)
  })

  it('is idempotent when the same envelope is delivered twice', async () => {
    await new ClientService(deviceA).create(draftClient())
    await syncA.syncOnce()
    await syncB.syncOnce()

    await deviceB.sync.setCursor(0)
    const second = await syncB.pull()

    expect(second.applied).toBe(0)
    expect(await deviceB.clients.count()).toBe(1)
  })
})

describe('conflicts', () => {
  async function bothEditNotes() {
    const client = await new ClientService(deviceA).create(draftClient({ notes: 'original' }))
    await syncA.syncOnce()
    await syncB.syncOnce()

    // Neither device has seen the other's edit.
    await deviceA.clients.update(client.id, { notes: 'written by A' })
    await deviceB.clients.update(client.id, { notes: 'written by B' })
    return client
  }

  it('surfaces the conflict on both devices and loses neither version', async () => {
    const client = await bothEditNotes()

    // A publishes first; B pulls while holding its own, newer, edit.
    await syncA.drain()
    const onB = await syncB.pull()

    expect(onB.conflicts).toBe(1)
    // B's version is newer, so it stands — and A's text is kept for the user.
    expect(await deviceB.clients.getById(client.id)).toMatchObject({ notes: 'written by B' })
    const cardsB = await deviceB.sync.listUnresolvedConflicts()
    expect(cardsB[0]?.localSnapshot).toMatchObject({ notes: 'written by B' })
    expect(cardsB[0]?.remoteSnapshot).toMatchObject({ notes: 'written by A' })

    await syncB.drain()
    const onA = await syncA.pull()

    // The device that pushed first would silently lose its work without this.
    expect(onA.conflicts).toBe(1)
    expect(await deviceA.clients.getById(client.id)).toMatchObject({ notes: 'written by B' })
    const cardsA = await deviceA.sync.listUnresolvedConflicts()
    expect(cardsA[0]?.localSnapshot).toMatchObject({ notes: 'written by A' })
  })

  it('records one card per entity however often the envelope is delivered', async () => {
    await bothEditNotes()
    await syncA.drain()

    await syncB.pull()
    await deviceB.sync.setCursor(0)
    await syncB.pull()

    expect(await deviceB.sync.listUnresolvedConflicts()).toHaveLength(1)
  })

  it('drops a queued change that lost, so a stale clock is never pushed', async () => {
    const client = await new ClientService(deviceA).create(draftClient())
    await syncA.syncOnce()
    await syncB.syncOnce()

    // A's edit never leaves the device; B's does, and is newer.
    await deviceA.clients.update(client.id, { firstName: 'QueuedOnA' })
    await deviceB.clients.update(client.id, { firstName: 'PublishedByB' })
    await syncB.drain()
    await syncA.pull()

    expect(await deviceA.outbox.listPending()).toHaveLength(0)
    expect(await deviceA.clients.getById(client.id)).toMatchObject({ firstName: 'PublishedByB' })
  })

  it('does not raise a conflict when only one side changed', async () => {
    const client = await new ClientService(deviceA).create(draftClient({ notes: 'original' }))
    await syncA.syncOnce()
    await syncB.syncOnce()

    await deviceA.clients.update(client.id, { notes: 'edited by A' })
    await syncA.syncOnce()
    const outcome = await syncB.syncOnce()

    expect(outcome.conflicts).toBe(0)
    expect(await deviceB.sync.listUnresolvedConflicts()).toHaveLength(0)
  })

  it('does not raise a conflict for fields that are safe to overwrite', async () => {
    const client = await new ClientService(deviceA).create(draftClient())
    await syncA.syncOnce()
    await syncB.syncOnce()

    // Both edit a name. Diverged, but last-write-wins loses nothing a person
    // would grieve over, so it is applied without a card.
    await deviceA.clients.update(client.id, { firstName: 'FromA' })
    await deviceB.clients.update(client.id, { firstName: 'FromB' })

    await syncB.drain()
    const outcome = await syncA.pull()

    expect(outcome.conflicts).toBe(0)
    expect(outcome.applied).toBe(1)
    expect(await deviceA.clients.getById(client.id)).toMatchObject({ firstName: 'FromB' })
  })

  it('treats a concurrent appointment move as a conflict', async () => {
    const clientId = (await new ClientService(deviceA).create(draftClient())).id
    const appointment = await deviceA.appointments.create(draftAppointment(clientId))
    await syncA.syncOnce()
    await syncB.syncOnce()

    await deviceA.appointments.update(appointment.id, {
      startAt: '2026-08-26T09:00:00.000Z',
      endAt: '2026-08-26T09:30:00.000Z',
    })
    await deviceB.appointments.update(appointment.id, {
      startAt: '2026-08-26T16:00:00.000Z',
      endAt: '2026-08-26T16:30:00.000Z',
    })

    await syncA.drain()
    const outcome = await syncB.pull()

    // Silently picking one would send a person to the clinic at the wrong time.
    expect(outcome.conflicts).toBe(1)
  })
})

describe('failure handling', () => {
  it('marks the queue failed and keeps the data when a push fails', async () => {
    const client = await new ClientService(deviceA).create(draftClient())
    server.failNextPush = new TypeError('Failed to fetch')

    await expect(syncA.drain()).rejects.toBeInstanceOf(AppError)

    expect((await deviceA.outbox.countByState()).failed).toBe(1)
    expect(await deviceA.clients.getById(client.id)).not.toBeNull()
    expect(server.size).toBe(0)
  })

  it('sends the change on the next attempt', async () => {
    await new ClientService(deviceA).create(draftClient())
    server.failNextPush = new TypeError('Failed to fetch')
    await syncA.drain().catch(() => undefined)

    // A failed operation is retryable, and coalescing keeps it a single upload.
    await deviceA.db.outbox.toCollection().modify({ state: 'pending' })
    await syncA.drain()

    expect(server.size).toBe(1)
  })

  it('reports a payload it cannot decrypt instead of writing nonsense', async () => {
    await new ClientService(deviceA).create(draftClient())
    await syncA.drain()

    const stranger = new SyncEngine(
      deviceB,
      server.transport(),
      (await createKeyMaterial('a completely different passphrase')).cipher,
    )

    await expect(stranger.pull()).rejects.toMatchObject({ code: 'decryption_failed' })
    expect(await deviceB.clients.count()).toBe(0)
  })
})

describe('offline behaviour', () => {
  it('drains an accumulated queue in order after reconnecting', async () => {
    const clients = new ClientService(deviceA)
    for (let index = 0; index < 25; index += 1) {
      await clients.create(draftClient({ lastName: `Client${String(index).padStart(2, '0')}` }))
    }

    expect(server.size).toBe(0)
    await syncA.drain()
    expect(server.size).toBe(25)

    await syncB.pull()
    expect(await deviceB.clients.count()).toBe(25)
  })

  it('leaves local data untouched when sync never runs', async () => {
    await new ClientService(deviceA).create(draftClient())
    expect(await deviceA.clients.count()).toBe(1)
    expect(server.size).toBe(0)
  })
})

describe('resolving a conflict', () => {
  async function conflictOnA() {
    const client = await new ClientService(deviceA).create(draftClient({ notes: 'original' }))
    await syncA.syncOnce()
    await syncB.syncOnce()

    await deviceA.clients.update(client.id, { notes: 'written by A' })
    await deviceB.clients.update(client.id, { notes: 'written by B' })

    await syncB.drain()
    await syncA.pull()
    return client
  }

  it('keeps my version and publishes the decision', async () => {
    const client = await conflictOnA()
    const conflicts = new ConflictService(deviceA)
    const [card] = await conflicts.list()

    await conflicts.resolve(card!.id, 'mine')

    expect(await deviceA.clients.getById(client.id)).toMatchObject({ notes: 'written by A' })
    expect(await conflicts.count()).toBe(0)

    // The other device learns the outcome instead of keeping its own quietly.
    await syncA.drain()
    await syncB.pull()
    expect(await deviceB.clients.getById(client.id)).toMatchObject({ notes: 'written by A' })
  })

  it('accepts their version without further edits', async () => {
    const client = await conflictOnA()
    const conflicts = new ConflictService(deviceA)
    const [card] = await conflicts.list()

    await conflicts.resolve(card!.id, 'theirs')

    expect(await deviceA.clients.getById(client.id)).toMatchObject({ notes: 'written by B' })
    expect(await conflicts.count()).toBe(0)
  })

  it('keeps both texts when neither should be thrown away', async () => {
    const client = await conflictOnA()
    const conflicts = new ConflictService(deviceA)
    const [card] = await conflicts.list()

    await conflicts.resolve(card!.id, 'both')

    const notes = (await deviceA.clients.getById(client.id))?.notes ?? ''
    expect(notes).toContain('written by A')
    expect(notes).toContain('written by B')
  })

  it('shows what is actually at stake, field by field', async () => {
    await conflictOnA()
    const [card] = await new ConflictService(deviceA).list()

    expect(card?.differences).toEqual([
      { field: 'notes', mine: 'written by A', theirs: 'written by B' },
    ])
    expect(card?.title).toMatch(/Petrov/)
  })

  it('refuses to resolve a conflict twice', async () => {
    await conflictOnA()
    const conflicts = new ConflictService(deviceA)
    const [card] = await conflicts.list()

    await conflicts.resolve(card!.id, 'mine')
    await expect(conflicts.resolve(card!.id, 'mine')).rejects.toMatchObject({ code: 'not_found' })
  })
})
