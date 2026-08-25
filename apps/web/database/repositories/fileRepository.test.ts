import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '@clinote/shared'
import type { LocalCore } from '../index'
import { createTestCore, draftClient, draftWork, fakeImage } from '../../test/factories'

let core: LocalCore
let clientId: string

beforeEach(async () => {
  core = await createTestCore()
  clientId = (await core.clients.create(draftClient())).id
})

afterEach(() => {
  core.close()
})

async function textOf(blob: Blob): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))
}

describe('FileRepository', () => {
  it('stores metadata and bytes together and hashes the original', async () => {
    const file = await core.files.addFile({
      clientId,
      name: 'panoramic.jpg',
      original: fakeImage('panoramic-bytes'),
      thumbnail: fakeImage('thumb', 'image/jpeg'),
    })

    expect(file.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(file.size).toBeGreaterThan(0)
    expect(await textOf(await core.files.getOriginal(file.id))).toBe('panoramic-bytes')
    expect(await textOf((await core.files.getThumbnail(file.id)) as Blob)).toBe('thumb')
  })

  it('keeps bytes out of metadata queries', async () => {
    await core.files.addFile({ clientId, name: 'x.jpg', original: fakeImage() })

    const page = await core.files.listByClient(clientId)
    const item = page.items[0] as Record<string, unknown>
    expect(item).toBeDefined()
    expect(item.original).toBeUndefined()
    expect(item.thumbnail).toBeUndefined()
    expect(item.blob).toBeUndefined()
  })

  it('deduplicates identical bytes for the same client', async () => {
    const first = await core.files.addFile({ clientId, name: 'a.jpg', original: fakeImage('same') })
    const second = await core.files.addFile({
      clientId,
      name: 'b.jpg',
      original: fakeImage('same'),
    })

    expect(second.id).toBe(first.id)
    expect(await core.files.count()).toBe(1)
    // Re-adding is a no-op, so it must not queue a second upload either.
    expect(await core.outbox.listPending()).toHaveLength(2) // client + one file
  })

  it('keeps identical bytes for different clients separate', async () => {
    const otherClientId = (await core.clients.create(draftClient({ lastName: 'Other' }))).id
    const first = await core.files.addFile({ clientId, name: 'a.jpg', original: fakeImage('same') })
    const second = await core.files.addFile({
      clientId: otherClientId,
      name: 'a.jpg',
      original: fakeImage('same'),
    })

    expect(second.id).not.toBe(first.id)
    expect(await core.files.count()).toBe(2)
  })

  it('links a file to a work', async () => {
    const work = await core.works.create(draftWork(clientId))
    const file = await core.files.addFile({
      clientId,
      workId: work.id,
      name: 'xray.jpg',
      original: fakeImage(),
    })

    expect((await core.files.listByWork(work.id)).map((item) => item.id)).toEqual([file.id])
  })

  it('reports a missing blob as a typed error', async () => {
    await expect(
      core.files.getOriginal('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('keeps bytes after a soft delete so the deletion can be undone', async () => {
    const file = await core.files.addFile({ clientId, name: 'a.jpg', original: fakeImage('keep') })
    await core.files.softDelete(file.id)

    expect(await core.files.getById(file.id)).toBeNull()
    expect(await textOf(await core.files.getOriginal(file.id))).toBe('keep')

    await core.files.restore(file.id)
    expect(await core.files.getById(file.id)).not.toBeNull()
  })

  it('purges tombstoned files and their bytes together', async () => {
    const file = await core.files.addFile({ clientId, name: 'a.jpg', original: fakeImage() })
    await core.files.softDelete(file.id)

    expect(await core.files.purgeDeletedBefore('2020-01-01T00:00:00.000Z')).toBe(0)

    const purged = await core.files.purgeDeletedBefore('2999-01-01T00:00:00.000Z')
    expect(purged).toBe(1)
    expect(await core.files.getById(file.id, { includeDeleted: true })).toBeNull()
    await expect(core.files.getOriginal(file.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('sums the bytes held by live files', async () => {
    await core.files.addFile({ clientId, name: 'a.jpg', original: fakeImage('1234567890') })
    const removed = await core.files.addFile({
      clientId,
      name: 'b.jpg',
      original: fakeImage('abc'),
    })
    await core.files.softDelete(removed.id)

    expect(await core.files.totalBytes()).toBe(10)
  })
})
