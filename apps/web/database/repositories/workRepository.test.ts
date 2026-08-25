import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalCore } from '../index'
import { createTestCore, draftClient, draftWork } from '../../test/factories'

let core: LocalCore
let clientId: string
let otherClientId: string

beforeEach(async () => {
  core = await createTestCore()
  clientId = (await core.clients.create(draftClient())).id
  otherClientId = (await core.clients.create(draftClient({ lastName: 'Other' }))).id
})

afterEach(() => {
  core.close()
})

describe('WorkRepository', () => {
  it('lists one client works newest first and never leaks another client', async () => {
    await core.works.create(draftWork(clientId, { date: '2026-01-10', title: 'January' }))
    await core.works.create(draftWork(clientId, { date: '2026-03-02', title: 'March' }))
    await core.works.create(draftWork(clientId, { date: '2026-02-14', title: 'February' }))
    await core.works.create(draftWork(otherClientId, { title: 'Someone else' }))

    const page = await core.works.listByClient(clientId)
    expect(page.items.map((work) => work.title)).toEqual(['March', 'February', 'January'])
    expect(await core.works.countByClient(clientId)).toBe(3)
    expect(await core.works.countByClient(otherClientId)).toBe(1)
  })

  it('pages a client history exactly', async () => {
    for (let day = 1; day <= 7; day += 1) {
      await core.works.create(
        draftWork(clientId, { date: `2026-04-0${day}`, title: `Visit ${day}` }),
      )
    }

    const first = await core.works.listByClient(clientId, { limit: 3 })
    expect(first.items.map((work) => work.title)).toEqual(['Visit 7', 'Visit 6', 'Visit 5'])
    expect(first.hasMore).toBe(true)

    const second = await core.works.listByClient(clientId, { limit: 3, cursor: first.nextCursor })
    expect(second.items.map((work) => work.title)).toEqual(['Visit 4', 'Visit 3', 'Visit 2'])

    const third = await core.works.listByClient(clientId, { limit: 3, cursor: second.nextCursor })
    expect(third.items.map((work) => work.title)).toEqual(['Visit 1'])
    expect(third.hasMore).toBe(false)
    expect(third.nextCursor).toBeNull()
  })

  it('hides tombstoned works from the client history and the count', async () => {
    const work = await core.works.create(draftWork(clientId))
    await core.works.create(draftWork(clientId, { title: 'Kept' }))
    await core.works.softDelete(work.id)

    const page = await core.works.listByClient(clientId)
    expect(page.items.map((item) => item.title)).toEqual(['Kept'])
    expect(await core.works.countByClient(clientId)).toBe(1)
  })

  it('lists recent works across all clients', async () => {
    await core.works.create(draftWork(clientId, { date: '2026-01-01', title: 'Older' }))
    await core.works.create(draftWork(otherClientId, { date: '2026-06-01', title: 'Newer' }))

    const page = await core.works.listRecent({ limit: 5 })
    expect(page.items.map((work) => work.title)).toEqual(['Newer', 'Older'])
  })
})
