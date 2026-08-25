/**
 * Local export (product spec §29).
 *
 * Available on every plan, including Free: a user must always be able to take
 * their data with them (docs/architecture.md I2).
 */
import {
  backupFileName,
  buildArchive,
  filePath,
  type ArchiveFileEntry,
  type BackupManifest,
  type DatabaseSnapshot,
} from '@clinote/backup'
import { AppError, toAppError } from '@clinote/shared'
import { DATABASE_VERSION, type LocalCore } from '~/database'

export interface ExportResult {
  blob: Blob
  filename: string
  manifest: BackupManifest
  sizeBytes: number
}

export class ExportService {
  constructor(
    private readonly core: LocalCore,
    private readonly appVersion: string,
  ) {}

  /**
   * Builds the archive and records the attempt.
   *
   * The whole archive is assembled in memory. That is fine for a device-sized
   * database and is the honest bound of this implementation; the streaming path
   * belongs with the cloud upload in Phase 10 (docs/backup.md §3).
   */
  async createArchive(
    options: {
      filenamePrefix?: string
      /**
       * Whether to record an attempt in the local history.
       *
       * A cloud backup builds an archive as one of its steps and records its
       * own attempt; a second `local_export` row for the same action would make
       * the history lie about what the user did.
       */
      record?: boolean
    } = {},
  ): Promise<ExportResult> {
    const record = options.record !== false
    const attempt = record
      ? await this.core.backups.start({
          kind: 'local_export',
          deviceId: this.core.context.deviceId,
          appVersion: this.appVersion,
        })
      : null

    try {
      const createdAt = new Date()
      const [clients, works, appointments, fileMetas] = await Promise.all([
        this.core.clients.listAll(),
        this.core.works.listAll(),
        this.core.appointments.listAll(),
        this.core.files.listAll(),
      ])

      const snapshotFiles: DatabaseSnapshot['files'] = []
      const entries: ArchiveFileEntry[] = []

      for (const meta of fileMetas) {
        const path = filePath(meta.clientId, meta.id, extensionOf(meta.name, meta.mimeType))
        const original = await this.core.files.getOriginal(meta.id)
        entries.push({
          path,
          fileId: meta.id,
          hash: meta.hash,
          bytes: new Uint8Array(await original.arrayBuffer()),
        })
        snapshotFiles.push({ meta, path })
      }

      const { bytes, manifest } = await buildArchive({
        snapshot: { clients, works, appointments, files: snapshotFiles },
        files: entries,
        appVersion: this.appVersion,
        databaseVersion: DATABASE_VERSION,
        deviceId: this.core.context.deviceId,
        createdAt: createdAt.toISOString(),
      })

      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' })
      if (attempt) {
        await this.core.backups.complete(attempt.id, {
          sizeBytes: blob.size,
          checksum: manifest.checksum,
        })
      }

      const name = backupFileName(createdAt)
      return {
        blob,
        filename: options.filenamePrefix ? `${options.filenamePrefix}-${name}` : name,
        manifest,
        sizeBytes: blob.size,
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : toAppError(error)
      if (attempt) await this.core.backups.fail(attempt.id, appError.code)
      throw appError
    }
  }

  /** Most recent successful export, for the "your data is not backed up" nudge. */
  async lastSuccessfulExportAt(): Promise<string | null> {
    const latest = await this.core.backups.latestSuccessful('local_export')
    return latest?.completedAt ?? latest?.createdAt ?? null
  }
}

function extensionOf(name: string, mimeType: string): string {
  const fromName = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  if (fromName && fromName.length <= 8) return fromName
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('image/')) return mimeType.slice('image/'.length)
  return 'bin'
}
