/**
 * File ingest: photos, x-rays and PDFs (product spec §16, §67).
 *
 * Validation happens here so that an unsupported or oversized file is refused
 * with a sentence, before any bytes are written.
 */
import { AppError } from '@clinote/shared'
import type { FileMeta } from '@clinote/types'
import type { LocalCore } from '~/database'
import type { Page, PageOptions } from '~/database/repositories/base'
import { createThumbnail } from '~/utils/thumbnails'

/** Large enough for a full-resolution x-ray, small enough to protect the device. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024

export const ACCEPTED_TYPES = ['image/', 'application/pdf'] as const

export interface AddFilesResult {
  added: FileMeta[]
  /** Files that were refused, with a message the UI can show verbatim. */
  rejected: { name: string; reason: string }[]
}

export class FileService {
  constructor(private readonly core: LocalCore) {}

  listByClient(clientId: string, options: PageOptions = {}): Promise<Page<FileMeta>> {
    return this.core.files.listByClient(clientId, options)
  }

  listByWork(workId: string): Promise<FileMeta[]> {
    return this.core.files.listByWork(workId)
  }

  get(id: string): Promise<FileMeta | null> {
    return this.core.files.getById(id)
  }

  getOriginal(id: string): Promise<Blob> {
    return this.core.files.getOriginal(id)
  }

  getThumbnail(id: string): Promise<Blob | null> {
    return this.core.files.getThumbnail(id)
  }

  totalBytes(): Promise<number> {
    return this.core.files.totalBytes()
  }

  remove(id: string): Promise<FileMeta> {
    return this.core.files.softDelete(id)
  }

  /**
   * Adds a batch. One bad file does not fail the batch: the rest are stored and
   * the refusals are reported, because a person selecting twelve photos should
   * not lose eleven of them to one unsupported format.
   */
  async addFiles(
    clientId: string,
    files: readonly File[],
    options: { workId?: string } = {},
  ): Promise<AddFilesResult> {
    const result: AddFilesResult = { added: [], rejected: [] }

    for (const file of files) {
      const rejection = validate(file)
      if (rejection) {
        result.rejected.push({ name: file.name, reason: rejection })
        continue
      }

      try {
        const thumbnail = await createThumbnail(file)
        result.added.push(
          await this.core.files.addFile({
            clientId,
            workId: options.workId,
            name: file.name,
            original: file,
            thumbnail,
          }),
        )
      } catch (error) {
        result.rejected.push({
          name: file.name,
          reason:
            error instanceof AppError
              ? error.message
              : 'This file could not be saved on this device.',
        })
      }
    }

    return result
  }
}

function validate(file: File): string | null {
  if (file.size === 0) return 'This file is empty.'
  if (file.size > MAX_FILE_BYTES) {
    return `This file is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`
  }
  if (!ACCEPTED_TYPES.some((prefix) => file.type.startsWith(prefix))) {
    return 'Only images and PDF files can be attached.'
  }
  return null
}
