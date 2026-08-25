/**
 * Local import (product spec §30) and the safety rules around it
 * (docs/backup.md §7, §8).
 *
 * Order matters and is not negotiable:
 *   parse → validate → checksum → safety copy → write in one transaction.
 * Nothing touches the database until the archive has proven itself.
 */
import { readArchive, type BackupManifest } from '@clinote/backup'
import { AppError } from '@clinote/shared'
import {
  DATABASE_VERSION,
  ImportWriter,
  type ImportTallies,
  type LocalCore,
  type PreparedFile,
} from '~/database'
import { createThumbnail } from '~/utils/thumbnails'
import type { ExportService, ExportResult } from './exportService'

export type ImportMode = 'replace' | 'merge'

export interface ImportPreview {
  manifest: BackupManifest
  counts: BackupManifest['counts']
  createdAt: string
  deviceId: string
  appVersion: string
}

export interface ImportOutcome {
  mode: ImportMode
  tallies: ImportTallies
  manifest: BackupManifest
  /** The archive of the data as it was before this import. */
  safetyCopy: ExportResult | null
}

export interface ImportOptions {
  /**
   * Skipping the safety copy is for tests and for a device with no data yet.
   * A user-facing import always takes one first.
   */
  safetyCopy?: boolean
}

export class ImportService {
  constructor(
    private readonly core: LocalCore,
    private readonly exports: ExportService,
  ) {}

  /** Reads and validates without writing anything, so the user can look first. */
  async inspect(source: Blob): Promise<ImportPreview> {
    const parsed = await this.parse(source)
    return {
      manifest: parsed.manifest,
      counts: parsed.manifest.counts,
      createdAt: parsed.manifest.createdAt,
      deviceId: parsed.manifest.deviceId,
      appVersion: parsed.manifest.appVersion,
    }
  }

  async apply(source: Blob, mode: ImportMode, options: ImportOptions = {}): Promise<ImportOutcome> {
    const parsed = await this.parse(source)

    let safetyCopy: ExportResult | null = null
    if (options.safetyCopy !== false) {
      try {
        safetyCopy = await this.exports.createArchive({ filenamePrefix: 'before-import' })
      } catch (cause) {
        // Refusing is the right answer: an import that cannot be undone is not
        // an import a user should be allowed to start by accident.
        throw new AppError('restore_failed', {
          message:
            'Clinote could not save a copy of your current data, so the import was not started.',
          cause,
        })
      }
    }

    const files: PreparedFile[] = []
    for (const entry of parsed.snapshot.files) {
      const bytes = parsed.files.get(entry.path)
      if (!bytes) {
        throw new AppError('backup_checksum_mismatch', {
          message: 'This backup is incomplete: some files are missing. Nothing was imported.',
        })
      }
      const original = new Blob([bytes as unknown as BlobPart], { type: entry.meta.mimeType })
      files.push({
        meta: entry.meta,
        original,
        // Previews are derived data and are not carried in the archive; they
        // are rebuilt here, outside the write transaction.
        thumbnail: await createThumbnail(original),
      })
    }

    const writer = new ImportWriter(this.core.db, this.core.context.deviceId)
    const payload = {
      clients: parsed.snapshot.clients,
      works: parsed.snapshot.works,
      appointments: parsed.snapshot.appointments,
      files,
    }

    const tallies = mode === 'replace' ? await writer.replace(payload) : await writer.merge(payload)

    return { mode, tallies, manifest: parsed.manifest, safetyCopy }
  }

  private async parse(source: Blob) {
    const bytes = new Uint8Array(await source.arrayBuffer())
    const result = await readArchive(bytes, { supportedDatabaseVersion: DATABASE_VERSION })
    if (!result.ok) throw result.error
    return result.value
  }
}
