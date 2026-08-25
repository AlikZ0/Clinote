/**
 * Archive validation.
 *
 * Every failure returns a typed AppError, because these messages are shown to a
 * person who is about to replace their entire database (product spec §68).
 */
import { AppError, type Result, err, ok } from '@clinote/shared'
import { computeChecksum, type FileDigest } from './checksum'
import { BACKUP_FORMAT_VERSION, manifestSchema, type BackupManifest } from './format'

export interface ValidationContext {
  /** Dexie schema version supported by the app performing the restore. */
  supportedDatabaseVersion: number
}

export function validateManifest(raw: unknown, context: ValidationContext): Result<BackupManifest> {
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    return err(
      new AppError('backup_invalid_format', {
        message: 'This file is not a Clinote backup, or it is damaged.',
        details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      }),
    )
  }

  const manifest = parsed.data

  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    return err(
      new AppError('backup_version_unsupported', {
        message: 'This backup was created by a newer version of Clinote. Please update the app.',
        details: { formatVersion: manifest.formatVersion, supported: BACKUP_FORMAT_VERSION },
      }),
    )
  }

  if (manifest.databaseVersion > context.supportedDatabaseVersion) {
    return err(
      new AppError('backup_version_unsupported', {
        message: 'This backup was created by a newer version of Clinote. Please update the app.',
        details: {
          databaseVersion: manifest.databaseVersion,
          supported: context.supportedDatabaseVersion,
        },
      }),
    )
  }

  return ok(manifest)
}

export async function verifyChecksum(
  manifest: BackupManifest,
  databaseJson: string,
  files: readonly FileDigest[],
): Promise<Result<true>> {
  const actual = await computeChecksum(databaseJson, files)
  if (actual !== manifest.checksum) {
    return err(
      new AppError('backup_checksum_mismatch', {
        message: 'This backup is incomplete or damaged and was not restored.',
      }),
    )
  }
  return ok(true)
}
