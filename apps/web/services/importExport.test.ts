import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@clinote/shared'
import type { LocalCore } from '~/database'
import {
  createTestCore,
  draftAppointment,
  draftClient,
  draftWork,
  fakeImage,
} from '../test/factories'
import { ClientService } from './clientService'
import { ExportService } from './exportService'
import { ImportService } from './importService'
import { WorkService } from './workService'

let core: LocalCore
let clients: ClientService
let works: WorkService
let exports: ExportService
let imports: ImportService

async function seed(): Promise<{ clientId: string }> {
  const client = await clients.create(draftClient({ lastName: 'Petrov', notes: 'clinical note' }))
  await works.create(draftWork(client.id, { title: 'Consultation' }))
  await core.files.addFile({
    clientId: client.id,
    name: 'panoramic.jpg',
    original: fakeImage('x-ray-bytes'),
  })
  await core.appointments.create(draftAppointment(client.id))
  const removed = await clients.create(draftClient({ lastName: 'Deleted' }))
  await clients.remove(removed.id)
  return { clientId: client.id }
}

function wire(target: LocalCore) {
  const exportService = new ExportService(target, '0.1.0')
  return {
    clients: new ClientService(target),
    works: new WorkService(target),
    exports: exportService,
    imports: new ImportService(target, exportService),
  }
}

beforeEach(async () => {
  core = await createTestCore()
  const wired = wire(core)
  clients = wired.clients
  works = wired.works
  exports = wired.exports
  imports = wired.imports
})

afterEach(() => {
  vi.restoreAllMocks()
  core.close()
})

describe('export', () => {
  it('produces a named archive and records the attempt', async () => {
    await seed()

    const result = await exports.createArchive()

    expect(result.filename).toMatch(/^clinote-backup-\d{4}-\d{2}-\d{2}\.zip$/)
    expect(result.blob.type).toBe('application/zip')
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.manifest.counts).toEqual({ clients: 2, works: 1, files: 1, appointments: 1 })

    const [attempt] = await core.backups.list()
    expect(attempt).toMatchObject({ kind: 'local_export', status: 'completed' })
    expect(attempt?.checksum).toBe(result.manifest.checksum)
  })

  it('includes tombstones so deletions are not undone by a later import', async () => {
    await seed()
    const preview = await imports.inspect((await exports.createArchive()).blob)
    // Two clients: one live, one deleted. The count includes the tombstone.
    expect(preview.counts.clients).toBe(2)
  })

  it('records a failure without claiming success', async () => {
    await seed()
    vi.spyOn(core.files, 'getOriginal').mockRejectedValue(
      new AppError('storage_unavailable', { message: 'disk gone' }),
    )

    await expect(exports.createArchive()).rejects.toBeInstanceOf(AppError)

    const [attempt] = await core.backups.list()
    expect(attempt).toMatchObject({ status: 'failed', errorCode: 'storage_unavailable' })
  })

  it('exports an empty database without inventing content', async () => {
    const result = await exports.createArchive()
    expect(result.manifest.counts).toEqual({ clients: 0, works: 0, files: 0, appointments: 0 })
  })
})

describe('import into a fresh device', () => {
  it('restores every record, its identity and its bytes', async () => {
    const { clientId } = await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    const wired = wire(target)
    const outcome = await wired.imports.apply(archive.blob, 'replace', { safetyCopy: false })

    expect(outcome.tallies.clients.inserted).toBe(2)
    expect(await target.clients.count()).toBe(1)
    expect(await target.clients.count({ includeDeleted: true })).toBe(2)

    const restored = await target.clients.getById(clientId)
    expect(restored).toMatchObject({ lastName: 'Petrov', notes: 'clinical note' })
    // Identity and causal ordering survive the round trip.
    const original = await core.clients.getById(clientId)
    expect(restored?.hlc).toBe(original?.hlc)
    expect(restored?.createdAt).toBe(original?.createdAt)

    const files = (await target.files.listByClient(clientId)).items
    expect(files).toHaveLength(1)
    const bytes = await (await target.files.getOriginal(files[0]!.id)).arrayBuffer()
    expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe('x-ray-bytes')

    target.close()
  })

  it('queues the imported records for upload without re-stamping their clock', async () => {
    const { clientId } = await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    await wire(target).imports.apply(archive.blob, 'replace', { safetyCopy: false })

    const pending = await target.outbox.listPending()
    const clientOp = pending.find((row) => row.entityId === clientId)
    expect(clientOp?.hlc).toBe((await core.clients.getById(clientId))?.hlc)
    expect(clientOp?.deviceId).toBe(target.context.deviceId)
    // The tombstoned client is queued as a delete, not a put.
    expect(pending.some((row) => row.operation === 'delete')).toBe(true)

    target.close()
  })
})

describe('replace', () => {
  it('leaves nothing of the previous database behind', async () => {
    await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    const wired = wire(target)
    const strangerId = (await wired.clients.create(draftClient({ lastName: 'Stranger' }))).id

    await wired.imports.apply(archive.blob, 'replace', { safetyCopy: false })

    expect(await target.clients.getById(strangerId, { includeDeleted: true })).toBeNull()
    target.close()
  })

  it('takes a safety copy of the current data before replacing it', async () => {
    await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    const wired = wire(target)
    await wired.clients.create(draftClient({ lastName: 'AboutToBeReplaced' }))

    const outcome = await wired.imports.apply(archive.blob, 'replace')

    expect(outcome.safetyCopy?.filename).toMatch(/^before-import-clinote-backup-/)
    // The copy describes the data as it was, not as it became.
    const previous = await wired.imports.inspect(outcome.safetyCopy!.blob)
    expect(previous.counts.clients).toBe(1)
    target.close()
  })

  it('refuses to start when the safety copy cannot be written', async () => {
    await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    const wired = wire(target)
    const keptId = (await wired.clients.create(draftClient({ lastName: 'Kept' }))).id
    vi.spyOn(target.files, 'listAll').mockRejectedValue(new Error('disk gone'))

    await expect(wired.imports.apply(archive.blob, 'replace')).rejects.toMatchObject({
      code: 'restore_failed',
    })

    expect(await target.clients.getById(keptId)).not.toBeNull()
    target.close()
  })

  it('rolls back and keeps the current data when the write fails', async () => {
    await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    const wired = wire(target)
    const keptId = (await wired.clients.create(draftClient({ lastName: 'Kept' }))).id
    vi.spyOn(target.db.appointments, 'bulkPut').mockRejectedValue(new Error('write failed'))

    await expect(
      wired.imports.apply(archive.blob, 'replace', { safetyCopy: false }),
    ).rejects.toMatchObject({ code: 'restore_failed' })

    // I5: the current database is intact.
    expect(await target.clients.getById(keptId)).not.toBeNull()
    expect(await target.clients.count()).toBe(1)
    target.close()
  })
})

describe('merge', () => {
  it('adds what is missing and leaves the rest alone', async () => {
    await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    const wired = wire(target)
    const localOnlyId = (await wired.clients.create(draftClient({ lastName: 'LocalOnly' }))).id

    const outcome = await wired.imports.apply(archive.blob, 'merge', { safetyCopy: false })

    expect(outcome.tallies.clients.inserted).toBe(2)
    expect(await target.clients.getById(localOnlyId)).not.toBeNull()
    expect(await target.clients.count({ includeDeleted: true })).toBe(3)
    target.close()
  })

  it('is idempotent: importing the same archive twice changes nothing', async () => {
    await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    const wired = wire(target)
    await wired.imports.apply(archive.blob, 'merge', { safetyCopy: false })
    const afterFirst = await target.clients.count({ includeDeleted: true })

    const second = await wired.imports.apply(archive.blob, 'merge', { safetyCopy: false })

    expect(second.tallies.clients).toEqual({ inserted: 0, updated: 0, skipped: 2 })
    expect(second.tallies.files.skipped).toBe(1)
    expect(await target.clients.count({ includeDeleted: true })).toBe(afterFirst)
    target.close()
  })

  it('keeps local edits that are newer than the archive', async () => {
    const { clientId } = await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    const wired = wire(target)
    await wired.imports.apply(archive.blob, 'merge', { safetyCopy: false })
    await wired.clients.update(clientId, { firstName: 'EditedAfterExport' })

    const second = await wired.imports.apply(archive.blob, 'merge', { safetyCopy: false })

    expect(second.tallies.clients.updated).toBe(0)
    expect(await target.clients.getById(clientId)).toMatchObject({
      firstName: 'EditedAfterExport',
    })
    target.close()
  })

  it('does not resurrect a client deleted after the archive was made', async () => {
    const { clientId } = await seed()
    const archive = await exports.createArchive()

    const target = await createTestCore()
    const wired = wire(target)
    await wired.imports.apply(archive.blob, 'merge', { safetyCopy: false })
    await wired.clients.remove(clientId)

    await wired.imports.apply(archive.blob, 'merge', { safetyCopy: false })

    expect(await target.clients.getById(clientId)).toBeNull()
    target.close()
  })
})

describe('bad archives', () => {
  it('refuses a file that is not an archive and writes nothing', async () => {
    const { clientId } = await seed()

    await expect(
      imports.apply(new Blob(['not a zip'], { type: 'application/zip' }), 'replace', {
        safetyCopy: false,
      }),
    ).rejects.toMatchObject({ code: 'backup_invalid_format' })

    expect(await core.clients.getById(clientId)).not.toBeNull()
  })

  it('reports what is inside before anything is applied', async () => {
    await seed()
    const archive = await exports.createArchive()

    const preview = await imports.inspect(archive.blob)

    expect(preview.deviceId).toBe(core.context.deviceId)
    expect(preview.appVersion).toBe('0.1.0')
    expect(preview.counts.works).toBe(1)
  })
})
