/**
 * Client use cases (docs/local-first.md §3).
 *
 * Services own the rules that span more than one repository; repositories own
 * persistence. Nothing above this layer knows that a client and its works live
 * in different tables.
 */
import type { Appointment, Client, FileMeta, Work } from '@clinote/types'
import type { LocalCore } from '~/database'
import type { Draft, Page, PageOptions, Patch } from '~/database/repositories/base'

export interface ClientOverview {
  client: Client
  workCount: number
  fileCount: number
  nextAppointment: Appointment | null
}

export class ClientService {
  constructor(private readonly core: LocalCore) {}

  list(options: PageOptions = {}): Promise<Page<Client>> {
    return this.core.clients.listPage(options)
  }

  search(query: string, limit = 20): Promise<Client[]> {
    return this.core.clients.searchByLastName(query, limit)
  }

  get(id: string): Promise<Client | null> {
    return this.core.clients.getById(id)
  }

  create(draft: Draft<Client>): Promise<Client> {
    return this.core.clients.create(normalize(draft))
  }

  update(id: string, patch: Patch<Client>): Promise<Client> {
    return this.core.clients.update(id, normalize(patch))
  }

  /** Display names for a set of ids, for screens that reference clients. */
  async namesByIds(ids: readonly string[]): Promise<Record<string, string>> {
    const unique = [...new Set(ids)]
    const clients = await this.core.clients.getByIds(unique)
    return Object.fromEntries(
      clients.map((client) => [client.id, `${client.lastName} ${client.firstName}`]),
    )
  }

  count(): Promise<number> {
    return this.core.clients.count()
  }

  async overview(id: string): Promise<ClientOverview | null> {
    const client = await this.core.clients.getById(id)
    if (!client) return null

    return {
      client,
      workCount: await this.core.works.countByClient(id),
      fileCount: (await this.core.files.listByClient(id, { limit: 1000 })).items.length,
      nextAppointment: await this.core.appointments.nextForClient(id, new Date().toISOString()),
    }
  }

  /**
   * Deleting a client removes what belongs to it: its works, its files and its
   * future appointments (docs/appointments.md §7).
   *
   * One transaction, so a half-deleted client cannot exist. Dexie joins the
   * repositories' own transactions into this one because their scope is a
   * subset of it.
   */
  async remove(id: string): Promise<void> {
    const db = this.core.db
    await db.transaction(
      'rw',
      [db.clients, db.works, db.files, db.fileBlobs, db.appointments, db.outbox, db.settings],
      async () => {
        const works = await this.core.works.listByClient(id, { limit: 10_000 })
        for (const work of works.items) await this.core.works.softDelete(work.id)

        const files = await this.core.files.listByClient(id, { limit: 10_000 })
        for (const file of files.items) await this.core.files.softDelete(file.id)

        const appointments = await this.core.appointments.listByClient(id, { limit: 10_000 })
        for (const appointment of appointments.items) {
          await this.core.appointments.softDelete(appointment.id)
        }

        await this.core.clients.softDelete(id)
      },
    )
  }
}

/** Empty optional strings are absent values, not empty data. */
function normalize<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = { ...input }
  for (const key of ['phone', 'email', 'notes'] as const) {
    if (typeof output[key] === 'string' && output[key].trim() === '') delete output[key]
  }
  return output as T
}

export type { Client, Work, FileMeta }
