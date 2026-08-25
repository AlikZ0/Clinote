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

describe('ClientRepository', () => {
  it('creates a client with stamped metadata', async () => {
    const client = await core.clients.create(draftClient())

    expect(client.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(client.createdAt).toBe(client.updatedAt)
    expect(client.deletedAt).toBeNull()
    expect(client.hlc).toContain(core.context.deviceId)
    expect(await core.clients.getById(client.id)).toEqual(client)
  })

  it('enqueues exactly one outbox operation per write, in the same transaction', async () => {
    const client = await core.clients.create(draftClient())

    const pending = await core.outbox.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      entityType: 'client',
      entityId: client.id,
      operation: 'put',
      state: 'pending',
      deviceId: core.context.deviceId,
      hlc: client.hlc,
    })
  })

  it('stores no payload in the outbox — intent only', async () => {
    await core.clients.create(draftClient({ notes: 'sensitive clinical note' }))

    const serialized = JSON.stringify(await core.outbox.listPending())
    expect(serialized).not.toContain('sensitive')
    expect(serialized).not.toContain('Petrov')
  })

  it('advances the HLC on every update and refuses to rewrite identity', async () => {
    const client = await core.clients.create(draftClient())
    const updated = await core.clients.update(client.id, { firstName: 'Ivan-Maria' })

    expect(updated.firstName).toBe('Ivan-Maria')
    expect(updated.id).toBe(client.id)
    expect(updated.createdAt).toBe(client.createdAt)
    expect(updated.hlc > client.hlc).toBe(true)
  })

  it('soft-deletes: the record survives as a tombstone and disappears from reads', async () => {
    const client = await core.clients.create(draftClient())
    const deleted = await core.clients.softDelete(client.id)

    expect(deleted.deletedAt).not.toBeNull()
    expect(await core.clients.getById(client.id)).toBeNull()
    expect(await core.clients.getById(client.id, { includeDeleted: true })).toMatchObject({
      id: client.id,
    })
    expect(await core.clients.count()).toBe(0)
    expect(await core.clients.count({ includeDeleted: true })).toBe(1)

    const pending = await core.outbox.listPending()
    expect(pending.at(-1)).toMatchObject({ operation: 'delete', entityId: client.id })
  })

  it('restores a tombstoned client', async () => {
    const client = await core.clients.create(draftClient())
    await core.clients.softDelete(client.id)
    const restored = await core.clients.restore(client.id)

    expect(restored.deletedAt).toBeNull()
    expect(await core.clients.count()).toBe(1)
  })

  it('rejects invalid data before it reaches storage', async () => {
    await expect(core.clients.create(draftClient({ firstName: '' }))).rejects.toThrow()
    await expect(core.clients.create(draftClient({ email: 'not-an-email' }))).rejects.toThrow()
    expect(await core.clients.count({ includeDeleted: true })).toBe(0)
  })

  it('pages alphabetically, exactly, across duplicate surnames', async () => {
    const surnames = ['Petrov', 'Petrov', 'Abrahamyan', 'Sargsyan', 'Petrov', 'Zakaryan']
    for (const [index, lastName] of surnames.entries()) {
      await core.clients.create(draftClient({ lastName, firstName: `First${index}` }))
    }

    const seen: string[] = []
    let cursor: string | null = null
    let guard = 0
    do {
      const page = await core.clients.listPage({ cursor, limit: 2 })
      expect(page.items.length).toBeLessThanOrEqual(2)
      seen.push(...page.items.map((client) => client.id))
      cursor = page.nextCursor
      guard += 1
    } while (cursor && guard < 10)

    // Every client exactly once: no repeats at page boundaries, nothing skipped.
    expect(seen).toHaveLength(surnames.length)
    expect(new Set(seen).size).toBe(surnames.length)

    const all = await core.clients.listPage({ limit: 100 })
    expect(all.items.map((client) => client.lastName)).toEqual([
      'Abrahamyan',
      'Petrov',
      'Petrov',
      'Petrov',
      'Sargsyan',
      'Zakaryan',
    ])
  })

  it('excludes tombstones from the list', async () => {
    const keep = await core.clients.create(draftClient({ lastName: 'Keep' }))
    const remove = await core.clients.create(draftClient({ lastName: 'Remove' }))
    await core.clients.softDelete(remove.id)

    const page = await core.clients.listPage()
    expect(page.items.map((client) => client.id)).toEqual([keep.id])
  })

  it('searches by surname prefix, including compound surnames', async () => {
    await core.clients.create(draftClient({ lastName: 'Van Dijk', firstName: 'Anna' }))
    await core.clients.create(draftClient({ lastName: 'Van', firstName: 'Boris' }))
    await core.clients.create(draftClient({ lastName: 'Sargsyan', firstName: 'Clara' }))

    const results = await core.clients.searchByLastName('van')
    expect(results.map((client) => client.lastName).sort()).toEqual(['Van', 'Van Dijk'])

    // The separator must sort below a space, otherwise "Van" lands after "Van Dijk".
    const ordered = await core.clients.listPage({ limit: 10 })
    expect(ordered.items.map((client) => client.lastName)).toEqual(['Sargsyan', 'Van', 'Van Dijk'])
  })

  it('applies a remote record without echoing it back to the server', async () => {
    const client = await core.clients.create(draftClient())
    await core.outbox.markState(
      (await core.outbox.listPending()).map((row) => row.seq as number),
      'synced',
    )

    await core.clients.applyRemote({ ...client, firstName: 'FromOtherDevice', hlc: '999' })

    expect(await core.clients.getById(client.id)).toMatchObject({ firstName: 'FromOtherDevice' })
    expect(await core.outbox.listPending()).toHaveLength(0)
  })
})
