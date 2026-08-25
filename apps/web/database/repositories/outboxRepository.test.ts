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

describe('OutboxRepository', () => {
  it('coalesces consecutive undelivered operations for one entity', async () => {
    const client = await core.clients.create(draftClient())
    await core.clients.update(client.id, { firstName: 'Second' })
    await core.clients.update(client.id, { firstName: 'Third' })

    const pending = await core.outbox.listPending()
    expect(pending).toHaveLength(1)
    // The surviving row carries the newest HLC, so drain order stays correct.
    expect(pending[0]?.hlc).toBe((await core.clients.getById(client.id))?.hlc)
  })

  it('does not coalesce across different entities', async () => {
    await core.clients.create(draftClient({ lastName: 'A' }))
    await core.clients.create(draftClient({ lastName: 'B' }))

    expect(await core.outbox.listPending()).toHaveLength(2)
  })

  it('does not coalesce an operation that is already uploading', async () => {
    const client = await core.clients.create(draftClient())
    await core.outbox.markState([1], 'uploading')

    await core.clients.update(client.id, { firstName: 'Changed' })

    const counts = await core.outbox.countByState()
    expect(counts.uploading).toBe(1)
    expect(counts.pending).toBe(1)
  })

  it('replaces a failed operation with the newer one', async () => {
    const client = await core.clients.create(draftClient())
    await core.outbox.markFailed(1, 'network_unavailable')

    await core.clients.update(client.id, { firstName: 'Retry' })

    const counts = await core.outbox.countByState()
    expect(counts.failed).toBe(0)
    expect(counts.pending).toBe(1)
  })

  it('drains in insertion order', async () => {
    const first = await core.clients.create(draftClient({ lastName: 'First' }))
    const second = await core.clients.create(draftClient({ lastName: 'Second' }))

    const pending = await core.outbox.listPending()
    expect(pending.map((row) => row.entityId)).toEqual([first.id, second.id])
  })

  it('tracks attempts and the last error on failure', async () => {
    await core.clients.create(draftClient())
    await core.outbox.markFailed(1, 'network_unavailable')
    await core.outbox.markFailed(1, 'rate_limited')

    const row = await core.db.outbox.get(1)
    expect(row).toMatchObject({ state: 'failed', attempts: 2, lastError: 'rate_limited' })
  })

  it('clears delivered operations without touching the data', async () => {
    const client = await core.clients.create(draftClient())
    await core.outbox.markState([1], 'synced')

    expect(await core.outbox.clearSynced()).toBe(1)
    expect(await core.db.outbox.count()).toBe(0)
    expect(await core.clients.getById(client.id)).not.toBeNull()
  })

  it('prunes the oldest entries for a plan that will never drain them', async () => {
    for (let index = 0; index < 12; index += 1) {
      await core.clients.create(draftClient({ lastName: `Client${index}` }))
    }
    expect(await core.db.outbox.count()).toBe(12)

    const pruned = await core.outbox.prune(5)

    expect(pruned).toBe(7)
    expect(await core.db.outbox.count()).toBe(5)
    // The queue shrank; the clients did not (docs/architecture.md I2).
    expect(await core.clients.count()).toBe(12)
  })

  it('prunes nothing when the queue is within the cap', async () => {
    await core.clients.create(draftClient())
    expect(await core.outbox.prune(50)).toBe(0)
  })
})
