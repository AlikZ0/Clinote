import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@clinote/shared'
import type { LocalCore } from './index'
import { DATABASE_VERSION, databaseNameFor } from './index'
import { SCHEMA_V1 } from './migrations'
import { createTestCore } from '../test/factories'

let core: LocalCore

beforeEach(async () => {
  core = await createTestCore()
})

afterEach(() => {
  core.close()
})

describe('database', () => {
  it('opens at the documented version with every table present', () => {
    expect(core.db.verno).toBe(DATABASE_VERSION)
    for (const table of Object.keys(SCHEMA_V1)) {
      expect(core.db.tables.map((t) => t.name)).toContain(table)
    }
  })

  it('gives each Business workspace its own database', () => {
    expect(databaseNameFor()).toBe('clinote')
    expect(databaseNameFor('ws-1')).toBe('clinote_ws_ws-1')
    expect(databaseNameFor('ws-1')).not.toBe(databaseNameFor('ws-2'))
  })

  it('creates a device id once and keeps it across reopens', async () => {
    const first = core.context.deviceId
    expect(first).toMatch(/^[0-9a-f-]{36}$/)

    const name = core.db.name
    core.close()
    const reopened = await (await import('./index')).createLocalCore({ name })
    expect(reopened.context.deviceId).toBe(first)
    reopened.close()
    core = await createTestCore()
  })

  it('does not re-issue an HLC after a reload', async () => {
    const client = await core.clients.create({
      firstName: 'Anna',
      lastName: 'Sargsyan',
      arrivalDate: '2026-08-25',
    })

    const name = core.db.name
    core.close()

    const reopened = await (await import('./index')).createLocalCore({ name })
    const next = await reopened.clients.create({
      firstName: 'Boris',
      lastName: 'Tumanyan',
      arrivalDate: '2026-08-25',
    })

    expect(next.hlc > client.hlc).toBe(true)
    reopened.close()
    core = await createTestCore()
  })

  it('translates a storage quota failure into a sentence a person can act on', async () => {
    vi.spyOn(core.db.clients, 'put').mockRejectedValue(
      new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
    )

    const failure = await core.clients
      .create({ firstName: 'Anna', lastName: 'Sargsyan', arrivalDate: '2026-08-25' })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AppError)
    expect(failure).toMatchObject({ code: 'storage_quota_exceeded' })
    expect((failure as AppError).message).not.toMatch(/DOMException|QuotaExceededError/)
    vi.restoreAllMocks()
  })

  it('leaves no partial write behind when a transaction fails', async () => {
    vi.spyOn(core.db.outbox, 'add').mockRejectedValue(new Error('outbox unavailable'))

    await expect(
      core.clients.create({ firstName: 'Anna', lastName: 'Sargsyan', arrivalDate: '2026-08-25' }),
    ).rejects.toBeInstanceOf(AppError)
    vi.restoreAllMocks()

    // The record and its outbox entry commit together or not at all
    // (docs/sync.md §3).
    expect(await core.clients.count({ includeDeleted: true })).toBe(0)
    expect(await core.db.outbox.count()).toBe(0)
  })

  it('reports a missing record as a typed error, not a raw exception', async () => {
    await expect(
      core.clients.update('11111111-1111-4111-8111-111111111111', {}),
    ).rejects.toBeInstanceOf(AppError)
    await expect(
      core.clients.update('11111111-1111-4111-8111-111111111111', {}),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})
