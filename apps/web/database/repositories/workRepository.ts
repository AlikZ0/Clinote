import type { Table } from 'dexie'
import { workSchema, type EntityType, type Work } from '@clinote/types'
import { toWorkRow, type WorkRow } from '../schema'
import { RecordRepository, type Page, type PageOptions } from './base'

const LIVE = (row: WorkRow) => row.isDeleted === 0

export class WorkRepository extends RecordRepository<Work, WorkRow> {
  protected readonly entityType: EntityType = 'work'

  protected get table(): Table<WorkRow, string> {
    return this.db.works
  }

  protected parse(input: unknown): Work {
    return workSchema.parse(input)
  }

  protected toRow(domain: Work): WorkRow {
    return toWorkRow(domain)
  }

  /** One client's works, newest first — the client detail screen. */
  async listByClient(clientId: string, options: PageOptions<WorkRow> = {}): Promise<Page<Work>> {
    return this.page('[clientId+dateKey]', clientId, (row) => row.dateKey, {
      reverse: true,
      filter: LIVE,
      ...options,
    })
  }

  async countByClient(clientId: string): Promise<number> {
    return this.run(() => this.db.works.where('clientId').equals(clientId).filter(LIVE).count())
  }

  /** All works across clients, newest first — the recent-activity list. */
  async listRecent(options: PageOptions<WorkRow> = {}): Promise<Page<Work>> {
    return this.page('[isDeleted+dateKey]', 0, (row) => row.dateKey, { reverse: true, ...options })
  }
}
