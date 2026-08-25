/**
 * Files: photos, x-rays and PDFs.
 *
 * Metadata and bytes live in different tables (docs/indexeddb.md §4) but are
 * written in one transaction, so a metadata row can never point at bytes that
 * are not there.
 */
import type { Table } from 'dexie'
import { sha256Hex } from '@clinote/crypto'
import { AppError, createId } from '@clinote/shared'
import { fileMetaSchema, type EntityType, type FileMeta } from '@clinote/types'
import { assertStorageHeadroom } from '../db'
import { toFileRow, type FileRow } from '../schema'
import { RecordRepository, type Page, type PageOptions } from './base'

export interface AddFileInput {
  clientId: string
  workId?: string
  name: string
  /** The original bytes, untouched. An x-ray is never recompressed. */
  original: Blob
  /** Small preview generated on ingest; lists render this, never the original. */
  thumbnail?: Blob | null
}

const LIVE = (row: FileRow) => row.isDeleted === 0

export class FileRepository extends RecordRepository<FileMeta, FileRow> {
  protected readonly entityType: EntityType = 'file'

  protected get table(): Table<FileRow, string> {
    return this.db.files
  }

  protected parse(input: unknown): FileMeta {
    return fileMetaSchema.parse(input)
  }

  protected toRow(domain: FileMeta): FileRow {
    return toFileRow(domain)
  }

  protected override extraWriteTables(): Table<unknown, unknown>[] {
    return [this.db.fileBlobs as unknown as Table<unknown, unknown>]
  }

  /**
   * Stores a file and returns its metadata.
   *
   * Content-addressed: re-adding identical bytes for the same client returns the
   * existing record, which is what makes import and restore idempotent
   * (docs/backup.md §8).
   */
  async addFile(input: AddFileInput): Promise<FileMeta> {
    const buffer = await input.original.arrayBuffer()
    const hash = await sha256Hex(new Uint8Array(buffer))

    const existing = await this.findByHash(input.clientId, hash)
    if (existing) return existing

    // Reserve headroom for the thumbnail and IndexedDB overhead as well.
    await assertStorageHeadroom(input.original.size + (input.thumbnail?.size ?? 0) + 64 * 1024)

    const timestamp = this.context.now()
    const domain = this.parse({
      id: createId(),
      clientId: input.clientId,
      workId: input.workId,
      name: input.name,
      mimeType: input.original.type || 'application/octet-stream',
      size: input.original.size,
      hash,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      hlc: this.context.clock.tick(),
    })

    return this.write(domain, 'put', async () => {
      await this.db.fileBlobs.put({
        id: domain.id,
        original: input.original,
        thumbnail: input.thumbnail ?? null,
      })
    })
  }

  async findByHash(clientId: string, hash: string): Promise<FileMeta | null> {
    const rows = await this.run(() =>
      this.db.files.where('hash').equals(hash).filter(LIVE).toArray(),
    )
    const match = rows.find((row) => row.clientId === clientId)
    return match ? this.fromRow(match) : null
  }

  /** Original bytes, loaded only when someone actually opens the file. */
  async getOriginal(id: string): Promise<Blob> {
    const row = await this.run(() => this.db.fileBlobs.get(id))
    if (!row) {
      throw new AppError('not_found', {
        message: 'This file is not stored on this device.',
        details: { entityType: 'file' },
      })
    }
    return row.original
  }

  async getThumbnail(id: string): Promise<Blob | null> {
    const row = await this.run(() => this.db.fileBlobs.get(id))
    return row?.thumbnail ?? null
  }

  async listByClient(
    clientId: string,
    options: PageOptions<FileRow> = {},
  ): Promise<Page<FileMeta>> {
    return this.page('[clientId+createdKey]', clientId, (row) => row.createdKey, {
      reverse: true,
      filter: LIVE,
      ...options,
    })
  }

  async listByWork(workId: string): Promise<FileMeta[]> {
    const rows = await this.run(() =>
      this.db.files.where('workId').equals(workId).filter(LIVE).toArray(),
    )
    return rows.map((row) => this.fromRow(row))
  }

  /** Bytes held by live files on this device, for the storage indicator. */
  async totalBytes(): Promise<number> {
    let total = 0
    await this.run(() =>
      this.db.files
        .where('isDeleted')
        .equals(0)
        .each((row) => {
          total += row.size
        }),
    )
    return total
  }

  /**
   * Hard-deletes tombstoned files and their bytes.
   *
   * Deliberately separate from `softDelete`: keeping the bytes until a purge
   * makes undo possible and lets a tombstone that arrives from another device
   * be reversed (docs/indexeddb.md §4).
   */
  async purgeDeletedBefore(cutoffIso: string): Promise<number> {
    const stale = await this.run(() =>
      this.db.files
        .where('isDeleted')
        .equals(1)
        .filter((row) => (row.deletedAt ?? '') < cutoffIso)
        .primaryKeys(),
    )
    if (stale.length === 0) return 0

    await this.run(() =>
      this.db.transaction('rw', [this.db.files, this.db.fileBlobs], async () => {
        await this.db.fileBlobs.bulkDelete(stale)
        await this.db.files.bulkDelete(stale)
      }),
    )
    return stale.length
  }

  private fromRow(row: FileRow): FileMeta {
    const { isDeleted: _isDeleted, createdKey: _createdKey, ...file } = row
    return file
  }
}
