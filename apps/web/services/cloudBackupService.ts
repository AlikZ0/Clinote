/**
 * Cloud backup (docs/backup.md §3, §4, §7).
 *
 * snapshot → validate → compress → encrypt → upload → verify.
 *
 * The first three steps are the local export from Phase 5 — one archive format,
 * one serializer, one validator — so a cloud backup can always be downloaded
 * and opened as a plain export.
 */
import { AppError, toAppError } from '@clinote/shared'
import { sha256Hex, fromBase64, toBase64, type Bytes } from '@clinote/crypto'
import type { ApiClient } from '~/api/client'
import { DATABASE_VERSION, type LocalCore } from '~/database'
import { createBackupCipher, openBackupCipher } from './encryption'
import type { ExportService } from './exportService'
import type { ImportOutcome, ImportService } from './importService'

export interface CloudBackupRecord {
  id: string
  createdAt: string
  completedAt: string | null
  sizeBytes: number
  checksum: string
  status: 'pending' | 'uploading' | 'verifying' | 'completed' | 'failed'
  errorCode: string | null
  deviceId: string
  appVersion: string
  databaseVersion: number
  expiresAt: string | null
}

export interface BackupHealth {
  lastSuccessfulBackup: string | null
  lastFailedBackup: string | null
  successCount30d: number
  failureCount30d: number
  storageUsedBytes: number
  storageLimitBytes: number
  needsAttention: boolean
}

interface WrappedKey {
  iv: string
  key: string
}

export class CloudBackupService {
  constructor(
    private readonly core: LocalCore,
    private readonly api: ApiClient,
    private readonly exports: ExportService,
    private readonly imports: ImportService,
    private readonly appVersion: string,
  ) {}

  list(): Promise<CloudBackupRecord[]> {
    return this.api.request<CloudBackupRecord[]>('/backups')
  }

  health(): Promise<BackupHealth> {
    return this.api.request<BackupHealth>('/backups/health')
  }

  /**
   * Runs the whole pipeline. The local attempt is recorded first so a failure
   * halfway through is visible rather than silent (docs/backup.md §5).
   */
  async create(accountKey: CryptoKey): Promise<CloudBackupRecord> {
    const attempt = await this.core.backups.start({
      kind: 'cloud_backup',
      deviceId: this.core.context.deviceId,
      appVersion: this.appVersion,
    })

    try {
      // The cloud attempt above already represents this action in the local
      // history; the export step must not add a second row.
      const archive = await this.exports.createArchive({ record: false })
      const plaintext = new Uint8Array(await archive.blob.arrayBuffer()) as Bytes

      const { cipher, wrapped } = await createBackupCipher(accountKey)
      const ciphertext = await cipher.seal(plaintext)
      // The digest is of what is actually uploaded, so the server can verify
      // it without being able to read it.
      const checksum = await sha256Hex(ciphertext)

      const init = await this.api.request<{
        backupId: string
        upload: { url: string; headers: Record<string, string>; expiresAt: string }
      }>('/backups/init', {
        method: 'POST',
        body: {
          deviceId: this.core.context.deviceId,
          sizeBytes: ciphertext.byteLength,
          checksum,
          wrappedDek: wrapped,
          appVersion: this.appVersion,
          databaseVersion: DATABASE_VERSION,
        },
      })

      await this.upload(init.upload, ciphertext)

      const completed = await this.api.request<CloudBackupRecord>(
        `/backups/${init.backupId}/complete`,
        { method: 'POST', body: { checksum } },
      )

      await this.core.backups.complete(attempt.id, {
        sizeBytes: ciphertext.byteLength,
        checksum,
      })
      return completed
    } catch (error) {
      const appError = error instanceof AppError ? error : toAppError(error)
      await this.core.backups.fail(attempt.id, appError.code)
      throw appError
    }
  }

  /**
   * Downloads, decrypts and restores (docs/backup.md §7).
   *
   * The restore itself is the Phase 5 import: it takes a safety copy of the
   * current data, verifies the archive, and only then replaces anything.
   */
  async restore(backupId: string, accountKey: CryptoKey): Promise<ImportOutcome> {
    const link = await this.api.request<{
      url: string
      wrappedDek: WrappedKey
      checksum: string
    }>(`/backups/${backupId}/download`)

    const response = await fetch(link.url)
    if (!response.ok) {
      throw new AppError('restore_failed', {
        message: 'The backup could not be downloaded. Nothing has been changed.',
      })
    }

    const ciphertext = new Uint8Array(await response.arrayBuffer()) as Bytes
    if ((await sha256Hex(ciphertext)) !== link.checksum) {
      // Refuse before decrypting: a damaged download must not reach the
      // restore path at all.
      throw new AppError('backup_checksum_mismatch', {
        message: 'The downloaded backup is damaged. Nothing has been changed.',
      })
    }

    const cipher = await openBackupCipher(accountKey, link.wrappedDek)
    const archive = await cipher.open(ciphertext)

    return this.imports.apply(new Blob([archive as unknown as BlobPart]), 'replace')
  }

  async remove(backupId: string): Promise<void> {
    await this.api.request(`/backups/${backupId}`, { method: 'DELETE' })
  }

  private async upload(
    upload: { url: string; headers: Record<string, string> },
    body: Bytes,
  ): Promise<void> {
    let response: Response
    try {
      response = await fetch(upload.url, {
        method: 'PUT',
        // Sent straight to storage, never through the API (docs/backup.md §4).
        headers: stripUnsettableHeaders(upload.headers),
        body: body as unknown as BodyInit,
      })
    } catch (cause) {
      throw new AppError('network_unavailable', {
        message: 'The backup could not be uploaded. Your data is unaffected.',
        cause,
      })
    }

    if (!response.ok) {
      throw new AppError('internal', {
        message: 'The backup could not be uploaded. Please try again.',
        details: { status: response.status },
      })
    }
  }
}

/**
 * `content-length` is set by the browser and cannot be assigned from script;
 * sending it explicitly throws. The signature still covers it.
 */
function stripUnsettableHeaders(headers: Record<string, string>): Record<string, string> {
  const { 'content-length': _length, ...rest } = headers
  return rest
}

export { toBase64, fromBase64 }
