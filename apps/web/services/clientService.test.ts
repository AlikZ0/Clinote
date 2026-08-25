import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalCore } from '~/database'
import {
  createTestCore,
  draftAppointment,
  draftClient,
  draftWork,
  fakeImage,
} from '../test/factories'
import { ClientService } from './clientService'
import { FileService } from './fileService'
import { WorkService } from './workService'

let core: LocalCore
let clients: ClientService
let works: WorkService
let files: FileService

beforeEach(async () => {
  core = await createTestCore()
  clients = new ClientService(core)
  works = new WorkService(core)
  files = new FileService(core)
})

afterEach(() => {
  vi.restoreAllMocks()
  core.close()
})

describe('ClientService', () => {
  it('treats blank optional fields as absent rather than empty data', async () => {
    const client = await clients.create({
      firstName: 'Ivan',
      lastName: 'Petrov',
      arrivalDate: '2026-08-25',
      phone: '   ',
      email: '',
      notes: '',
    })

    expect(client.phone).toBeUndefined()
    expect(client.email).toBeUndefined()
    expect(client.notes).toBeUndefined()
  })

  it('summarizes a client with counts and the next appointment', async () => {
    const client = await clients.create(draftClient())
    await works.create(draftWork(client.id))
    await core.files.addFile({ clientId: client.id, name: 'x.jpg', original: fakeImage() })
    const soon = new Date(Date.now() + 86_400_000).toISOString()
    const later = new Date(Date.now() + 172_800_000).toISOString()
    await core.appointments.create(
      draftAppointment(client.id, { startAt: soon, endAt: later, title: 'Next visit' }),
    )

    const overview = await clients.overview(client.id)
    expect(overview).toMatchObject({ workCount: 1, fileCount: 1 })
    expect(overview?.nextAppointment?.title).toBe('Next visit')
  })

  it('removes everything that belongs to a deleted client', async () => {
    const client = await clients.create(draftClient())
    const work = await works.create(draftWork(client.id))
    const file = await core.files.addFile({
      clientId: client.id,
      name: 'x.jpg',
      original: fakeImage(),
    })
    const appointment = await core.appointments.create(draftAppointment(client.id))

    await clients.remove(client.id)

    expect(await clients.get(client.id)).toBeNull()
    expect(await core.works.getById(work.id)).toBeNull()
    expect(await core.files.getById(file.id)).toBeNull()
    expect(await core.appointments.getById(appointment.id)).toBeNull()

    // Tombstones, not erasure: the deletions still have to reach other devices.
    expect(await core.works.getById(work.id, { includeDeleted: true })).not.toBeNull()
  })

  it('leaves the client intact when part of the cascade fails', async () => {
    const client = await clients.create(draftClient())
    const work = await works.create(draftWork(client.id))
    await core.appointments.create(draftAppointment(client.id))

    vi.spyOn(core.db.appointments, 'put').mockRejectedValue(new Error('disk gone'))

    await expect(clients.remove(client.id)).rejects.toThrow()

    // One transaction: a half-deleted client must not exist.
    expect(await clients.get(client.id)).not.toBeNull()
    expect(await core.works.getById(work.id)).not.toBeNull()
  })

  it('does not touch another client during a cascade', async () => {
    const target = await clients.create(draftClient({ lastName: 'Target' }))
    const bystander = await clients.create(draftClient({ lastName: 'Bystander' }))
    const keptWork = await works.create(draftWork(bystander.id))

    await clients.remove(target.id)

    expect(await clients.get(bystander.id)).not.toBeNull()
    expect(await core.works.getById(keptWork.id)).not.toBeNull()
  })
})

describe('WorkService', () => {
  it('removes the files that belong to a deleted work', async () => {
    const client = await clients.create(draftClient())
    const work = await works.create(draftWork(client.id))
    const attached = await core.files.addFile({
      clientId: client.id,
      workId: work.id,
      name: 'x.jpg',
      original: fakeImage('attached'),
    })
    const loose = await core.files.addFile({
      clientId: client.id,
      name: 'y.jpg',
      original: fakeImage('loose'),
    })

    await works.remove(work.id)

    expect(await core.files.getById(attached.id)).toBeNull()
    // A file that was not part of the work stays with the client.
    expect(await core.files.getById(loose.id)).not.toBeNull()
  })

  it('fills in the optional text fields the schema defaults', async () => {
    const client = await clients.create(draftClient())
    const work = await works.create({ clientId: client.id, date: '2026-08-25', title: 'Checkup' })

    expect(work.description).toBe('')
    expect(work.notes).toBe('')
  })
})

describe('FileService', () => {
  function upload(name: string, content: string, type: string): File {
    return new File([content], name, { type })
  }

  it('refuses unsupported and empty files with a readable reason', async () => {
    const client = await clients.create(draftClient())

    const result = await files.addFiles(client.id, [
      upload('notes.txt', 'hello', 'text/plain'),
      upload('empty.jpg', '', 'image/jpeg'),
    ])

    expect(result.added).toHaveLength(0)
    expect(result.rejected.map((item) => item.reason)).toEqual([
      'Only images and PDF files can be attached.',
      'This file is empty.',
    ])
  })

  it('keeps the good files when one in a batch is refused', async () => {
    const client = await clients.create(draftClient())

    const result = await files.addFiles(client.id, [
      upload('scan.jpg', 'good-bytes', 'image/jpeg'),
      upload('notes.txt', 'nope', 'text/plain'),
      upload('report.pdf', '%PDF-1.7', 'application/pdf'),
    ])

    expect(result.added.map((file) => file.name)).toEqual(['scan.jpg', 'report.pdf'])
    expect(result.rejected).toHaveLength(1)
    expect(await files.totalBytes()).toBeGreaterThan(0)
  })

  it('refuses a file above the size limit', async () => {
    const client = await clients.create(draftClient())
    const huge = upload('huge.jpg', 'x', 'image/jpeg')
    Object.defineProperty(huge, 'size', { value: 65 * 1024 * 1024 })

    const result = await files.addFiles(client.id, [huge])
    expect(result.added).toHaveLength(0)
    expect(result.rejected[0]?.reason).toMatch(/larger than 64 MB/)
  })

  it('stores a file without a thumbnail when none can be generated', async () => {
    const client = await clients.create(draftClient())

    const result = await files.addFiles(client.id, [
      upload('report.pdf', '%PDF-1.7', 'application/pdf'),
    ])

    expect(result.added[0]).toBeDefined()
    expect(await files.getThumbnail(result.added[0]!.id)).toBeNull()
  })
})
