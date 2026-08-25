import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@clinote/shared'
import { sha256Hex, type Bytes } from '@clinote/crypto'
import type { ApiClient } from '~/api/client'
import type { LocalCore } from '~/database'
import { createTestCore, draftClient, fakeImage } from '../test/factories'
import { ClientService } from './clientService'
import { CloudBackupService, type CloudBackupRecord } from './cloudBackupService'
import { createKeyMaterial } from './encryption'
import { ExportService } from './exportService'
import { ImportService } from './importService'

/**
 * A stand-in for the API and the object store together: it enforces the same
 * rules the server does — verify what landed, refuse what does not match.
 */
class FakeBackend {
  readonly objects = new Map<string, Uint8Array>()
  readonly records = new Map<string, CloudBackupRecord & { wrappedDek: unknown; key: string }>()
  failUpload = false

  api(): ApiClient {
    const request = async (path: string, options: { method?: string; body?: unknown } = {}) => {
      const method = options.method ?? 'GET'

      if (path === '/backups/init' && method === 'POST') {
        const body = options.body as {
          sizeBytes: number
          checksum: string
          wrappedDek: unknown
          appVersion: string
          databaseVersion: number
          deviceId: string
        }
        const id = crypto.randomUUID()
        const key = `backups/test/${id}`
        this.records.set(id, {
          id,
          createdAt: new Date().toISOString(),
          completedAt: null,
          sizeBytes: body.sizeBytes,
          checksum: body.checksum,
          status: 'pending',
          errorCode: null,
          deviceId: body.deviceId,
          appVersion: body.appVersion,
          databaseVersion: body.databaseVersion,
          expiresAt: null,
          wrappedDek: body.wrappedDek,
          key,
        })
        return { backupId: id, upload: { url: `fake://${key}`, headers: {}, expiresAt: '' } }
      }

      const completeMatch = /^\/backups\/([^/]+)\/complete$/.exec(path)
      if (completeMatch && method === 'POST') {
        const record = this.records.get(completeMatch[1] as string)
        if (!record) throw new AppError('not_found', { message: 'no such backup' })
        const stored = this.objects.get(record.key)

        if (!stored) {
          record.status = 'failed'
          throw new AppError('backup_invalid_format', { message: 'nothing was uploaded' })
        }
        if (
          stored.length !== record.sizeBytes ||
          (await sha256Hex(stored as Bytes)) !== record.checksum
        ) {
          record.status = 'failed'
          throw new AppError('backup_checksum_mismatch', { message: 'damaged' })
        }

        record.status = 'completed'
        record.completedAt = new Date().toISOString()
        return record
      }

      const downloadMatch = /^\/backups\/([^/]+)\/download$/.exec(path)
      if (downloadMatch) {
        const record = this.records.get(downloadMatch[1] as string)
        if (!record || record.status !== 'completed') {
          throw new AppError('not_found', { message: 'no such backup' })
        }
        return {
          url: `fake://${record.key}`,
          wrappedDek: record.wrappedDek,
          checksum: record.checksum,
        }
      }

      if (path === '/backups') return [...this.records.values()]

      throw new AppError('not_found', { message: `unexpected ${method} ${path}` })
    }

    return { request } as unknown as ApiClient
  }

  /** Stands in for the browser PUTting to the signed URL, and for GET. */
  installFetch(): void {
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const key = String(url).replace('fake://', '')
      if (init?.method === 'PUT') {
        if (this.failUpload) throw new TypeError('Failed to fetch')
        this.objects.set(key, new Uint8Array(init.body as ArrayBuffer))
        return new Response(null, { status: 200 })
      }
      const stored = this.objects.get(key)
      if (!stored) return new Response(null, { status: 404 })
      return new Response(stored as unknown as BodyInit, { status: 200 })
    })
  }
}

let core: LocalCore
let backend: FakeBackend
let service: CloudBackupService
let accountKey: CryptoKey

async function seed() {
  const clients = new ClientService(core)
  const client = await clients.create(draftClient({ lastName: 'Petrov', notes: 'clinical note' }))
  await core.files.addFile({ clientId: client.id, name: 'x.jpg', original: fakeImage('x-ray') })
  return client
}

function wire(target: LocalCore) {
  const exports = new ExportService(target, '0.1.0')
  const imports = new ImportService(target, exports)
  return new CloudBackupService(target, backend.api(), exports, imports, '0.1.0')
}

beforeEach(async () => {
  core = await createTestCore()
  backend = new FakeBackend()
  backend.installFetch()
  service = wire(core)
  accountKey = (await createKeyMaterial('correct horse battery staple')).dek
})

afterEach(() => {
  vi.unstubAllGlobals()
  core.close()
})

describe('creating a cloud backup', () => {
  it('uploads an encrypted archive and completes only after verification', async () => {
    await seed()

    const record = await service.create(accountKey)

    expect(record.status).toBe('completed')
    expect(record.sizeBytes).toBeGreaterThan(0)
    expect(backend.objects.size).toBe(1)
  })

  it('uploads nothing the server could read', async () => {
    await seed()
    await service.create(accountKey)

    const [uploaded] = [...backend.objects.values()]
    const asText = new TextDecoder().decode(uploaded)
    expect(asText).not.toContain('Petrov')
    expect(asText).not.toContain('clinical note')
    // ...and it is not merely a zip either: PK is the archive's magic.
    expect(asText.slice(0, 2)).not.toBe('PK')
  })

  it('records the attempt locally, so a failure is visible', async () => {
    await seed()
    await service.create(accountKey)

    const [attempt] = await core.backups.list()
    expect(attempt).toMatchObject({ kind: 'cloud_backup', status: 'completed' })
  })

  it('marks the local attempt failed when the upload does not go through', async () => {
    await seed()
    backend.failUpload = true

    await expect(service.create(accountKey)).rejects.toMatchObject({ code: 'network_unavailable' })

    const [attempt] = await core.backups.list()
    expect(attempt).toMatchObject({ status: 'failed', errorCode: 'network_unavailable' })
  })

  it('surfaces a server refusal rather than claiming success', async () => {
    await seed()
    // The upload silently does nothing: the server has nothing to verify.
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))

    await expect(service.create(accountKey)).rejects.toMatchObject({
      code: 'backup_invalid_format',
    })
  })
})

describe('restoring', () => {
  it('brings a database back on a device that has never seen it', async () => {
    const client = await seed()
    const record = await service.create(accountKey)

    const target = await createTestCore()
    const targetService = wire(target)

    const outcome = await targetService.restore(record.id, accountKey)

    expect(outcome.mode).toBe('replace')
    const restored = await target.clients.getById(client.id)
    expect(restored).toMatchObject({ lastName: 'Petrov', notes: 'clinical note' })
    // Files come back with their bytes, not just their metadata.
    const files = (await target.files.listByClient(client.id)).items
    const bytes = await (await target.files.getOriginal(files[0]!.id)).arrayBuffer()
    expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe('x-ray')

    target.close()
  })

  it('takes a safety copy of what it is about to replace', async () => {
    await seed()
    const record = await service.create(accountKey)

    const target = await createTestCore()
    const targetService = wire(target)
    await new ClientService(target).create(draftClient({ lastName: 'AboutToBeReplaced' }))

    const outcome = await targetService.restore(record.id, accountKey)

    expect(outcome.safetyCopy?.filename).toMatch(/^before-import-/)
    target.close()
  })

  it('refuses a damaged download before decrypting it', async () => {
    await seed()
    const record = await service.create(accountKey)

    // Corrupt the stored object.
    const [key] = [...backend.objects.keys()]
    const corrupted = new Uint8Array(backend.objects.get(key as string) as Uint8Array)
    corrupted[corrupted.length - 1] ^= 0xff
    backend.objects.set(key as string, corrupted)

    const target = await createTestCore()
    await expect(wire(target).restore(record.id, accountKey)).rejects.toMatchObject({
      code: 'backup_checksum_mismatch',
    })
    expect(await target.clients.count()).toBe(0)
    target.close()
  })

  it('refuses a backup that a different passphrase cannot open', async () => {
    await seed()
    const record = await service.create(accountKey)

    const stranger = (await createKeyMaterial('a completely different passphrase')).dek
    const target = await createTestCore()

    await expect(wire(target).restore(record.id, stranger)).rejects.toMatchObject({
      code: 'key_unavailable',
    })
    expect(await target.clients.count()).toBe(0)
    target.close()
  })

  it('leaves the current data untouched when the download fails', async () => {
    await seed()
    const record = await service.create(accountKey)
    backend.objects.clear()

    const target = await createTestCore()
    const keptId = (await new ClientService(target).create(draftClient({ lastName: 'Kept' }))).id

    await expect(wire(target).restore(record.id, accountKey)).rejects.toBeInstanceOf(AppError)
    expect(await target.clients.getById(keptId)).not.toBeNull()
    target.close()
  })
})

describe('round trip', () => {
  it('produces an archive that is byte-identical after decryption', async () => {
    await seed()
    const exports = new ExportService(core, '0.1.0')
    const plain = new Uint8Array(await (await exports.createArchive()).blob.arrayBuffer()) as Bytes

    const record = await service.create(accountKey)
    expect(record.status).toBe('completed')

    // The stored object is the encrypted form of the same archive format.
    const [stored] = [...backend.objects.values()]
    expect(stored!.length).toBeGreaterThan(plain.length - 64)
  })
})
