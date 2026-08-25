/**
 * Archive reading and writing (docs/backup.md §2).
 *
 * One implementation for the Free local export and the Pro cloud backup: the
 * encrypted upload wraps exactly these bytes, so a cloud backup can always be
 * downloaded and opened as a plain export.
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { AppError, type Result, err, ok } from '@clinote/shared'
import { computeChecksum, type FileDigest } from './checksum'
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  DATABASE_PATH,
  MANIFEST_PATH,
  type BackupManifest,
} from './format'
import { countSnapshot, parseSnapshot, serializeSnapshot, type DatabaseSnapshot } from './snapshot'
import { validateManifest, verifyChecksum, type ValidationContext } from './validate'

export interface ArchiveFileEntry {
  /** Path inside the archive; must match `snapshot.files[].path`. */
  path: string
  fileId: string
  /** SHA-256 hex of these bytes. */
  hash: string
  bytes: Uint8Array
}

export interface BuildArchiveInput {
  snapshot: DatabaseSnapshot
  files: readonly ArchiveFileEntry[]
  appVersion: string
  databaseVersion: number
  deviceId: string
  createdAt: string
}

export interface BuiltArchive {
  bytes: Uint8Array
  manifest: BackupManifest
}

export async function buildArchive(input: BuildArchiveInput): Promise<BuiltArchive> {
  const databaseJson = serializeSnapshot(input.snapshot)

  // The snapshot is the authoritative list of what belongs in the archive, and
  // it is also what the reader validates against. Deriving the digests from
  // anywhere else would let a builder produce an archive that can never be
  // verified.
  const provided = new Map(input.files.map((file) => [file.path, file]))
  const digests: FileDigest[] = []
  const included: ArchiveFileEntry[] = []

  for (const entry of input.snapshot.files) {
    const bytes = provided.get(entry.path)
    if (!bytes) {
      throw new AppError('backup_invalid_format', {
        message: 'Clinote could not read one of the files for this backup. Nothing was written.',
        details: { fileId: entry.meta.id },
      })
    }
    digests.push({ fileId: entry.meta.id, hash: entry.meta.hash })
    included.push(bytes)
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: input.appVersion,
    databaseVersion: input.databaseVersion,
    createdAt: input.createdAt,
    deviceId: input.deviceId,
    counts: countSnapshot(input.snapshot),
    checksum: await computeChecksum(databaseJson, digests),
  }

  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 | 6 }]> = {
    [MANIFEST_PATH]: [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }],
    [DATABASE_PATH]: [strToU8(databaseJson), { level: 6 }],
  }

  for (const file of included) {
    // Photos, x-rays and PDFs are already compressed; deflating them again
    // costs time and memory and saves nothing.
    entries[file.path] = [file.bytes, { level: 0 }]
  }

  return { bytes: zipSync(entries, { level: 6 }), manifest }
}

export interface ParsedArchive {
  manifest: BackupManifest
  snapshot: DatabaseSnapshot
  /** Path inside the archive → bytes. */
  files: Map<string, Uint8Array>
}

/**
 * Parses and fully validates an archive before a single record is written.
 *
 * Every failure is a typed AppError with a sentence the user can act on: this
 * message is shown to someone about to replace their entire database.
 */
export async function readArchive(
  bytes: Uint8Array,
  context: ValidationContext,
): Promise<Result<ParsedArchive>> {
  let raw: Record<string, Uint8Array>
  try {
    raw = unzipSync(bytes)
  } catch (cause) {
    return err(
      new AppError('backup_invalid_format', {
        message: 'This file is not a Clinote backup, or it is damaged.',
        cause,
      }),
    )
  }

  const manifestBytes = raw[MANIFEST_PATH]
  const databaseBytes = raw[DATABASE_PATH]
  if (!manifestBytes || !databaseBytes) {
    return err(
      new AppError('backup_invalid_format', {
        message: 'This backup is missing part of its contents and cannot be opened.',
      }),
    )
  }

  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(strFromU8(manifestBytes))
  } catch (cause) {
    return err(
      new AppError('backup_invalid_format', {
        message: 'This backup is damaged and cannot be opened.',
        cause,
      }),
    )
  }

  const manifestResult = validateManifest(manifestJson, context)
  if (!manifestResult.ok) return manifestResult

  const databaseJson = strFromU8(databaseBytes)
  let snapshot: DatabaseSnapshot
  try {
    snapshot = parseSnapshot(databaseJson)
  } catch (cause) {
    return err(
      new AppError('backup_invalid_format', {
        message: 'This backup was written in a format Clinote does not understand.',
        cause,
      }),
    )
  }

  const files = new Map<string, Uint8Array>()
  for (const [path, content] of Object.entries(raw)) {
    if (path !== MANIFEST_PATH && path !== DATABASE_PATH) files.set(path, content)
  }

  // Every file the snapshot promises must actually be in the archive, and the
  // checksum must cover exactly those bytes.
  const digests: FileDigest[] = []
  for (const entry of snapshot.files) {
    if (!files.has(entry.path)) {
      return err(
        new AppError('backup_checksum_mismatch', {
          message: 'This backup is incomplete: some files are missing. Nothing was restored.',
          details: { missing: entry.meta.id },
        }),
      )
    }
    digests.push({ fileId: entry.meta.id, hash: entry.meta.hash })
  }

  const checksumResult = await verifyChecksum(manifestResult.value, databaseJson, digests)
  if (!checksumResult.ok) return checksumResult

  return ok({ manifest: manifestResult.value, snapshot, files })
}
