import { describe, expect, it } from 'vitest'
import {
  BACKUP_FORMAT_VERSION,
  backupFileName,
  computeChecksum,
  filePath,
  manifestSchema,
  validateManifest,
  verifyChecksum,
  type BackupManifest,
} from './index'

const DATABASE_JSON = JSON.stringify({ clients: [{ id: 'c1' }], works: [], files: [] })
const FILES = [
  { fileId: 'f2', hash: 'b'.repeat(64) },
  { fileId: 'f1', hash: 'a'.repeat(64) },
]

async function manifest(overrides: Partial<BackupManifest> = {}): Promise<BackupManifest> {
  return {
    format: 'clinote-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: '0.1.0',
    databaseVersion: 1,
    createdAt: '2026-08-25T19:42:11.000Z',
    deviceId: 'device-1',
    counts: { clients: 1, works: 0, files: 2, appointments: 0 },
    checksum: await computeChecksum(DATABASE_JSON, FILES),
    ...overrides,
  }
}

describe('archive format', () => {
  it('names archives by creation date', () => {
    expect(backupFileName(new Date('2026-08-25T19:42:11.000Z'))).toBe(
      'clinote-backup-2026-08-25.zip',
    )
  })

  it('lays files out under their client', () => {
    expect(filePath('c1', 'f1', '.JPG')).toBe('files/clients/c1/f1.jpg')
    expect(filePath('c1', 'f1', '')).toBe('files/clients/c1/f1')
  })
})

describe('checksum', () => {
  it('is stable regardless of file ordering', async () => {
    const a = await computeChecksum(DATABASE_JSON, FILES)
    const b = await computeChecksum(DATABASE_JSON, [...FILES].reverse())
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('changes when the database changes', async () => {
    const original = await computeChecksum(DATABASE_JSON, FILES)
    expect(await computeChecksum(`${DATABASE_JSON} `, FILES)).not.toBe(original)
  })

  it('changes when a file is swapped', async () => {
    const original = await computeChecksum(DATABASE_JSON, FILES)
    const tampered = [{ fileId: 'f1', hash: 'c'.repeat(64) }, FILES[0]!]
    expect(await computeChecksum(DATABASE_JSON, tampered)).not.toBe(original)
  })
})

describe('validation', () => {
  it('accepts a well-formed manifest', async () => {
    const result = validateManifest(await manifest(), { supportedDatabaseVersion: 1 })
    expect(result.ok).toBe(true)
  })

  it('rejects a foreign file with a human message', () => {
    const result = validateManifest({ hello: 'world' }, { supportedDatabaseVersion: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('backup_invalid_format')
    expect(result.error.message).not.toMatch(/zod|undefined|DOMException/i)
  })

  it('refuses a backup from a newer database version instead of corrupting data', async () => {
    const result = validateManifest(await manifest({ databaseVersion: 9 }), {
      supportedDatabaseVersion: 1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('backup_version_unsupported')
  })

  it('detects a truncated archive through the checksum', async () => {
    const result = await verifyChecksum(await manifest(), DATABASE_JSON, [FILES[0]!])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('backup_checksum_mismatch')
  })

  it('confirms an intact archive', async () => {
    expect((await verifyChecksum(await manifest(), DATABASE_JSON, FILES)).ok).toBe(true)
  })

  it('keeps the manifest schema aligned with the documented contract', async () => {
    expect(() => manifestSchema.parse(manifest())).toThrow()
    expect(manifestSchema.safeParse(await manifest()).success).toBe(true)
  })
})
