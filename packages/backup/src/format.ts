/**
 * Backup archive format (docs/backup.md §2).
 *
 * The same format is used for a Free local export and for an encrypted cloud
 * backup — one serializer, one validator, one set of tests. A cloud backup can
 * always be downloaded and opened as a plain export, which is what makes the
 * "your data stays yours" promise real rather than marketing.
 *
 *   clinote-backup-2026-08-25.zip
 *     manifest.json
 *     database.json
 *     files/clients/<clientId>/<fileId>.<ext>
 */
import { z } from 'zod'

export const BACKUP_FORMAT = 'clinote-backup'
export const BACKUP_FORMAT_VERSION = 1

export const MANIFEST_PATH = 'manifest.json'
export const DATABASE_PATH = 'database.json'
export const FILES_PREFIX = 'files/clients'

export const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int().positive(),
  appVersion: z.string().min(1),
  databaseVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  deviceId: z.string().min(1),
  counts: z.object({
    clients: z.number().int().nonnegative(),
    works: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    appointments: z.number().int().nonnegative(),
  }),
  /** `sha256:<hex>` over database.json plus the sorted file digests. */
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
})

export type BackupManifest = z.infer<typeof manifestSchema>

export function filePath(clientId: string, fileId: string, extension: string): string {
  const ext = extension.replace(/^\./, '').toLowerCase()
  return `${FILES_PREFIX}/${clientId}/${fileId}${ext ? `.${ext}` : ''}`
}

export function backupFileName(createdAt: Date): string {
  const iso = createdAt.toISOString()
  return `clinote-backup-${iso.slice(0, 10)}.zip`
}
