import type { Table } from 'dexie'
import { clientSchema, type Client, type EntityType } from '@clinote/types'
import { toClientRow, type ClientRow } from '../schema'
import { RecordRepository, type Page, type PageOptions } from './base'

/** Above every character that occurs in a name. */
const MAX_STRING_KEY = '￿'

export class ClientRepository extends RecordRepository<Client, ClientRow> {
  protected readonly entityType: EntityType = 'client'

  protected get table(): Table<ClientRow, string> {
    return this.db.clients
  }

  protected parse(input: unknown): Client {
    return clientSchema.parse(input)
  }

  protected toRow(domain: Client): ClientRow {
    return toClientRow(domain)
  }

  /** Alphabetical page of live clients — the default list screen. */
  async listPage(options: PageOptions<ClientRow> = {}): Promise<Page<Client>> {
    return this.page('[isDeleted+sortKey]', 0, (row) => row.sortKey, options)
  }

  /**
   * Prefix search on surname, served by the same index as the list, so it stays
   * index-backed at 1,000+ clients instead of scanning the table.
   */
  async searchByLastName(prefix: string, limit = 20): Promise<Client[]> {
    const normalized = prefix.trim().toLowerCase()
    if (!normalized) return (await this.listPage({ limit })).items

    const rows = await this.run(() =>
      this.db.clients
        .where('[isDeleted+sortKey]')
        .between([0, normalized], [0, `${normalized}${MAX_STRING_KEY}`], true, true)
        .limit(limit)
        .toArray(),
    )
    return rows.map((row) => this.fromRow(row))
  }

  private fromRow(row: ClientRow): Client {
    const { isDeleted: _isDeleted, sortKey: _sortKey, ...client } = row
    return client
  }
}
