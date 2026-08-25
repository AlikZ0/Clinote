import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { sha256Hex } from '@clinote/crypto'
import {
  DATABASE_PATH,
  MANIFEST_PATH,
  buildArchive,
  filePath,
  readArchive,
  type ArchiveFileEntry,
  type DatabaseSnapshot,
} from './index'

const CONTEXT = { supportedDatabaseVersion: 1 }
const CLIENT_ID = '11111111-1111-4111-8111-111111111111'
const FILE_ID = '22222222-2222-4222-8222-222222222222'

function client(overrides: Record<string, unknown> = {}) {
  return {
    id: CLIENT_ID,
    firstName: 'Ivan',
    lastName: 'Petrov',
    arrivalDate: '2026-08-25',
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    deletedAt: null,
    hlc: '000000001756108800000:00000:device-a',
    ...overrides,
  }
}

async function fileEntry(content = 'x-ray-bytes'): Promise<ArchiveFileEntry> {
  const bytes = strToU8(content)
  return {
    path: filePath(CLIENT_ID, FILE_ID, 'jpg'),
    fileId: FILE_ID,
    hash: await sha256Hex(bytes),
    bytes,
  }
}

async function snapshotWithFile(): Promise<{
  snapshot: DatabaseSnapshot
  entry: ArchiveFileEntry
}> {
  const entry = await fileEntry()
  const snapshot: DatabaseSnapshot = {
    clients: [client()],
    works: [],
    appointments: [],
    files: [
      {
        path: entry.path,
        meta: {
          id: FILE_ID,
          clientId: CLIENT_ID,
          name: 'panoramic.jpg',
          mimeType: 'image/jpeg',
          size: entry.bytes.length,
          hash: entry.hash,
          createdAt: '2026-08-25T10:05:00.000Z',
          updatedAt: '2026-08-25T10:05:00.000Z',
          deletedAt: null,
          hlc: '000000001756109100000:00000:device-a',
        },
      },
    ],
  }
  return { snapshot, entry }
}

async function build() {
  const { snapshot, entry } = await snapshotWithFile()
  const archive = await buildArchive({
    snapshot,
    files: [entry],
    appVersion: '0.1.0',
    databaseVersion: 1,
    deviceId: 'device-a',
    createdAt: '2026-08-25T19:42:11.000Z',
  })
  return { archive, snapshot, entry }
}

describe('archive round trip', () => {
  it('writes a manifest that describes what is inside', async () => {
    const { archive } = await build()

    expect(archive.manifest.format).toBe('clinote-backup')
    expect(archive.manifest.counts).toEqual({ clients: 1, works: 0, files: 1, appointments: 0 })
    expect(archive.manifest.checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('reads back exactly what was written, bytes included', async () => {
    const { archive, entry } = await build()

    const result = await readArchive(archive.bytes, CONTEXT)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.snapshot.clients[0]?.lastName).toBe('Petrov')
    expect(result.value.snapshot.clients[0]?.hlc).toBe(client().hlc)
    expect(Array.from(result.value.files.get(entry.path) ?? [])).toEqual(Array.from(entry.bytes))
  })

  it('is deterministic: the same database produces the same checksum', async () => {
    const first = await build()
    const second = await build()
    expect(second.archive.manifest.checksum).toBe(first.archive.manifest.checksum)
  })

  it('preserves tombstones so a deletion survives export and import', async () => {
    const archive = await buildArchive({
      snapshot: {
        clients: [client({ deletedAt: '2026-08-26T09:00:00.000Z' })],
        works: [],
        appointments: [],
        files: [],
      },
      files: [],
      appVersion: '0.1.0',
      databaseVersion: 1,
      deviceId: 'device-a',
      createdAt: '2026-08-26T09:00:00.000Z',
    })

    const result = await readArchive(archive.bytes, CONTEXT)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.snapshot.clients[0]?.deletedAt).not.toBeNull()
  })
})

describe('archive building', () => {
  it('refuses to write an archive whose files it cannot read', async () => {
    const { snapshot } = await snapshotWithFile()
    await expect(
      buildArchive({
        snapshot,
        files: [],
        appVersion: '0.1.0',
        databaseVersion: 1,
        deviceId: 'device-a',
        createdAt: '2026-08-25T19:42:11.000Z',
      }),
    ).rejects.toMatchObject({ code: 'backup_invalid_format' })
  })
})

describe('archive validation', () => {
  it('refuses a file that is not a zip', async () => {
    const result = await readArchive(strToU8('definitely not a zip'), CONTEXT)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('backup_invalid_format')
      expect(result.error.message).not.toMatch(/zip|unzip|TypeError/i)
    }
  })

  it('refuses a zip without a manifest', async () => {
    const bytes = zipSync({ 'random.txt': strToU8('hello') })
    const result = await readArchive(bytes, CONTEXT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('backup_invalid_format')
  })

  it('detects a tampered database.json through the checksum', async () => {
    const { archive } = await build()
    const raw = await readArchive(archive.bytes, CONTEXT)
    expect(raw.ok).toBe(true)
    if (!raw.ok) return

    // Rebuild the archive with an edited client name but the original manifest.
    const tampered = zipSync({
      [MANIFEST_PATH]: strToU8(JSON.stringify(archive.manifest)),
      [DATABASE_PATH]: strToU8(
        JSON.stringify({ ...raw.value.snapshot, clients: [client({ lastName: 'Forged' })] }),
      ),
      ...Object.fromEntries([...raw.value.files.entries()]),
    })

    const result = await readArchive(tampered, CONTEXT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('backup_checksum_mismatch')
  })

  it('refuses an archive whose files are missing', async () => {
    const { archive } = await build()
    const raw = await readArchive(archive.bytes, CONTEXT)
    expect(raw.ok).toBe(true)
    if (!raw.ok) return

    const withoutFiles = zipSync({
      [MANIFEST_PATH]: strToU8(JSON.stringify(archive.manifest)),
      [DATABASE_PATH]: strToU8(JSON.stringify(raw.value.snapshot)),
    })

    const result = await readArchive(withoutFiles, CONTEXT)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('backup_checksum_mismatch')
      expect(result.error.message).toMatch(/Nothing was restored/)
    }
  })

  it('refuses an archive from a newer database version', async () => {
    const { snapshot, entry } = await snapshotWithFile()
    const archive = await buildArchive({
      snapshot,
      files: [entry],
      appVersion: '9.0.0',
      databaseVersion: 9,
      deviceId: 'device-a',
      createdAt: '2026-08-25T19:42:11.000Z',
    })

    const result = await readArchive(archive.bytes, CONTEXT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('backup_version_unsupported')
  })
})
