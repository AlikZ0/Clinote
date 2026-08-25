import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalCore } from '../index'
import { createTestCore, draftClient } from '../../test/factories'

let core: LocalCore

beforeEach(async () => {
  core = await createTestCore()
})

afterEach(() => {
  core.close()
})

describe('SyncRepository', () => {
  it('starts at cursor zero and only ever moves forward', async () => {
    expect(await core.sync.getCursor()).toBe(0)

    await core.sync.setCursor(42)
    expect(await core.sync.getCursor()).toBe(42)

    // A late response from an earlier request must not rewind the cursor and
    // cause envelopes to be applied twice.
    await core.sync.setCursor(17)
    expect(await core.sync.getCursor()).toBe(42)
  })

  it('records a conflict with both versions instead of discarding one', async () => {
    const client = await core.clients.create(draftClient())

    const conflict = await core.sync.recordConflict({
      entityType: 'client',
      entityId: client.id,
      localSnapshot: { notes: 'mine' },
      remoteSnapshot: { notes: 'theirs' },
    })

    expect(conflict.resolvedAt).toBeNull()
    const unresolved = await core.sync.listUnresolvedConflicts()
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0]?.localSnapshot).toEqual({ notes: 'mine' })
    expect(unresolved[0]?.remoteSnapshot).toEqual({ notes: 'theirs' })

    await core.sync.resolveConflict(conflict.id)
    expect(await core.sync.listUnresolvedConflicts()).toHaveLength(0)
  })

  it('summarizes the sync chip states', async () => {
    expect(await core.sync.summary(true)).toMatchObject({ status: 'synced', pending: 0 })

    await core.clients.create(draftClient())
    expect(await core.sync.summary(true)).toMatchObject({ status: 'syncing', pending: 1 })

    // Offline outranks a pending queue: the user needs to know why nothing moves.
    expect(await core.sync.summary(false)).toMatchObject({ status: 'offline' })

    await core.outbox.markFailed(1, 'network_unavailable')
    expect(await core.sync.summary(true)).toMatchObject({ status: 'failed', failed: 1 })

    await core.sync.recordConflict({
      entityType: 'client',
      entityId: '11111111-1111-4111-8111-111111111111',
      localSnapshot: {},
      remoteSnapshot: {},
    })
    // A conflict needs a person; it outranks a retryable failure.
    expect(await core.sync.summary(true)).toMatchObject({ status: 'conflict', conflicts: 1 })
  })

  it('remembers when the last pull happened', async () => {
    expect(await core.sync.getLastPullAt()).toBeNull()
    await core.sync.markPulled('2026-08-25T19:42:00.000Z')
    expect(await core.sync.getLastPullAt()).toBe('2026-08-25T19:42:00.000Z')
  })
})
