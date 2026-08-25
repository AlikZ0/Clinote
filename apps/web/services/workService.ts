import type { Work } from '@clinote/types'
import type { LocalCore } from '~/database'
import type { Draft, Page, PageOptions, Patch } from '~/database/repositories/base'

/** The schema defaults these to empty, so callers should not have to pass them. */
export type WorkDraft = Omit<Draft<Work>, 'description' | 'notes'> &
  Partial<Pick<Work, 'description' | 'notes'>>

export class WorkService {
  constructor(private readonly core: LocalCore) {}

  listByClient(clientId: string, options: PageOptions = {}): Promise<Page<Work>> {
    return this.core.works.listByClient(clientId, options)
  }

  listRecent(options: PageOptions = {}): Promise<Page<Work>> {
    return this.core.works.listRecent(options)
  }

  get(id: string): Promise<Work | null> {
    return this.core.works.getById(id)
  }

  create(draft: WorkDraft): Promise<Work> {
    return this.core.works.create({ description: '', notes: '', ...draft })
  }

  update(id: string, patch: Patch<Work>): Promise<Work> {
    return this.core.works.update(id, patch)
  }

  /** Files attached to a work are part of it and go with it. */
  async remove(id: string): Promise<void> {
    const db = this.core.db
    await db.transaction(
      'rw',
      [db.works, db.files, db.fileBlobs, db.outbox, db.settings],
      async () => {
        for (const file of await this.core.files.listByWork(id)) {
          await this.core.files.softDelete(file.id)
        }
        await this.core.works.softDelete(id)
      },
    )
  }
}
