/**
 * Repository base (docs/local-first.md §3, docs/indexeddb.md §8).
 *
 * Owns the single write path: stamp -> validate -> write -> enqueue, all inside
 * one Dexie transaction. There is no way to mutate a record and miss the HLC,
 * the tombstone or the outbox entry, because the transaction is here and not in
 * the callers.
 */
import type { Table } from 'dexie'
import { AppError, createId, toAppError } from '@clinote/shared'
import type { EntityType } from '@clinote/types'
import type { ClinoteDatabase } from '../db'
import { rememberHlc, type MutationContext } from '../context'
import { stripDerived } from '../schema'
import type { OutboxRepository } from './outboxRepository'

export interface DomainRecord {
  id: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  hlc: string
}

export interface BaseRow extends DomainRecord {
  isDeleted: 0 | 1
}

/** Fields the caller supplies; the rest is stamped by the repository. */
export type Draft<TDomain extends DomainRecord> = Omit<TDomain, keyof DomainRecord> & {
  id?: string
}

export type Patch<TDomain extends DomainRecord> = Partial<Omit<TDomain, keyof DomainRecord>>

export interface PageOptions<TRow = unknown> {
  cursor?: string | null
  limit?: number
  reverse?: boolean
  /** Applied during iteration, before `limit` counts a row. */
  filter?: (row: TRow) => boolean
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

export const DEFAULT_PAGE_SIZE = 50

/** Above every character that occurs in names, ISO dates and uuids. */
const MAX_STRING_KEY = '￿'

export interface RepositoryDeps {
  db: ClinoteDatabase
  context: MutationContext
  outbox: OutboxRepository
}

export abstract class RecordRepository<TDomain extends DomainRecord, TRow extends BaseRow> {
  protected readonly db: ClinoteDatabase
  protected readonly context: MutationContext
  protected readonly outbox: OutboxRepository

  constructor(deps: RepositoryDeps) {
    this.db = deps.db
    this.context = deps.context
    this.outbox = deps.outbox
  }

  protected abstract readonly entityType: EntityType
  protected abstract get table(): Table<TRow, string>
  /** Validates against the shared zod schema; invalid data never reaches disk. */
  protected abstract parse(input: unknown): TDomain
  protected abstract toRow(domain: TDomain): TRow

  /** Tables besides its own and the outbox that a write must lock. */
  protected extraWriteTables(): Table<unknown, unknown>[] {
    return []
  }

  async getById(id: string, options: { includeDeleted?: boolean } = {}): Promise<TDomain | null> {
    const row = await this.run(() => this.table.get(id))
    if (!row) return null
    if (row.isDeleted === 1 && !options.includeDeleted) return null
    return stripDerived<TDomain>(row as unknown as Record<string, unknown>)
  }

  /** Bulk lookup for resolving references (a calendar needs client names). */
  async getByIds(ids: readonly string[]): Promise<TDomain[]> {
    if (ids.length === 0) return []
    const rows = await this.run(() => this.table.bulkGet([...ids]))
    return rows
      .filter((row): row is TRow => row !== undefined)
      .map((row) => stripDerived<TDomain>(row as unknown as Record<string, unknown>))
  }

  async count(options: { includeDeleted?: boolean } = {}): Promise<number> {
    return this.run(() =>
      options.includeDeleted ? this.table.count() : this.table.where('isDeleted').equals(0).count(),
    )
  }

  /**
   * Every record, tombstones included.
   *
   * For export and backup only: an archive that dropped tombstones would
   * resurrect deleted clients on the next import (docs/backup.md §8). No screen
   * uses this — screens page.
   */
  async listAll(): Promise<TDomain[]> {
    const rows = await this.run(() => this.table.toArray())
    return rows.map((row) => stripDerived<TDomain>(row as unknown as Record<string, unknown>))
  }

  async create(draft: Draft<TDomain>): Promise<TDomain> {
    const timestamp = this.context.now()
    const candidate = {
      ...draft,
      id: draft.id ?? createId(),
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      hlc: this.context.clock.tick(),
    }
    return this.write(this.parse(candidate), 'put')
  }

  async update(id: string, patch: Patch<TDomain>): Promise<TDomain> {
    const current = await this.requireRecord(id)
    const candidate = {
      ...current,
      ...patch,
      // Identity and creation time are not patchable: they are what makes a
      // record the same record across export, import and sync.
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.context.now(),
      hlc: this.context.clock.tick(),
    }
    return this.write(this.parse(candidate), 'put')
  }

  /** Soft delete: a tombstone, so the deletion can propagate (docs/local-first.md §5). */
  async softDelete(id: string): Promise<TDomain> {
    const current = await this.requireRecord(id)
    if (current.deletedAt) return current

    const timestamp = this.context.now()
    return this.write(
      this.parse({
        ...current,
        deletedAt: timestamp,
        updatedAt: timestamp,
        hlc: this.context.clock.tick(),
      }),
      'delete',
    )
  }

  async restore(id: string): Promise<TDomain> {
    const current = await this.requireRecord(id, { includeDeleted: true })
    const timestamp = this.context.now()
    return this.write(
      this.parse({
        ...current,
        deletedAt: null,
        updatedAt: timestamp,
        hlc: this.context.clock.tick(),
      }),
      'put',
    )
  }

  /**
   * Applies a record that arrived from another device. Bypasses HLC stamping
   * (the incoming HLC is authoritative) and does not enqueue an outbox entry —
   * echoing a received change back to the server would loop forever.
   */
  async applyRemote(record: TDomain): Promise<TDomain> {
    const parsed = this.parse(record)
    await this.run(() => this.table.put(this.toRow(parsed)))
    return parsed
  }

  protected async requireRecord(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<TDomain> {
    const record = await this.getById(id, options)
    if (!record) {
      throw new AppError('not_found', {
        message: 'This record no longer exists on this device.',
        details: { entityType: this.entityType },
      })
    }
    return record
  }

  /** stamp -> write -> enqueue, atomically. */
  protected async write(
    domain: TDomain,
    operation: 'put' | 'delete',
    /** Extra writes that must commit or roll back together with the record. */
    sideEffect?: () => Promise<void>,
  ): Promise<TDomain> {
    const tables = [this.table, this.db.outbox, this.db.settings, ...this.extraWriteTables()]
    await this.run(() =>
      this.db.transaction('rw', tables, async () => {
        // Read inside the transaction: the version this change is replacing.
        const previous = await this.table.get(domain.id)
        await this.table.put(this.toRow(domain))
        if (sideEffect) await sideEffect()
        await this.outbox.enqueue({
          entityType: this.entityType,
          entityId: domain.id,
          operation,
          hlc: domain.hlc,
          baseHlc: previous?.hlc ?? null,
          deviceId: this.context.deviceId,
        })
        // Stored in the same transaction: a reload must never re-issue an HLC
        // that a committed record already carries.
        await rememberHlc(this.db, domain.hlc)
      }),
    )
    return domain
  }

  /** Single place where storage failures become AppErrors (product spec §68). */
  protected async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      throw toAppError(error)
    }
  }

  protected async page(
    indexName: string,
    scope: string | number,
    keyOf: (row: TRow) => string,
    options: PageOptions<TRow> = {},
  ): Promise<Page<TDomain>> {
    const limit = Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE)
    const cursor = options.cursor ?? null

    const rows = await this.run(() => {
      const range = options.reverse
        ? this.table
            .where(indexName)
            .between([scope, ''], [scope, cursor ?? MAX_STRING_KEY], true, cursor === null)
            .reverse()
        : this.table
            .where(indexName)
            .between([scope, cursor ?? ''], [scope, MAX_STRING_KEY], cursor === null, true)
      const collection = options.filter ? range.filter(options.filter) : range
      return collection.limit(limit + 1).toArray()
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)

    return {
      items: page.map((row) => stripDerived<TDomain>(row as unknown as Record<string, unknown>)),
      nextCursor: hasMore && last ? keyOf(last) : null,
      hasMore,
    }
  }
}
