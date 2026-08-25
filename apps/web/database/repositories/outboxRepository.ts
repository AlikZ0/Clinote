/**
 * Outbox (docs/sync.md §3, docs/indexeddb.md §8).
 *
 * Written on every plan, drained only when Cloud Sync is entitled. Keeping one
 * write path means enabling Pro needs no migration and no special first-upload
 * code path that is exercised exactly once in production.
 *
 * Rows carry intent, not content: the envelope is serialized from the current
 * record at drain time.
 */
import { createId, nowIso } from '@clinote/shared'
import type { EntityType, OutboxState } from '@clinote/types'
import type { ClinoteDatabase } from '../db'
import type { OutboxRow } from '../schema'

export interface EnqueueInput {
  entityType: EntityType
  entityId: string
  operation: 'put' | 'delete'
  hlc: string
  /** Clock value this change was based on; null when the record was created. */
  baseHlc: string | null
  deviceId: string
}

/** States that a newer operation for the same entity can safely replace. */
const COALESCEABLE: OutboxState[] = ['pending', 'failed']

export class OutboxRepository {
  constructor(private readonly db: ClinoteDatabase) {}

  /**
   * Must be called inside the same transaction as the data write. Dexie joins
   * the ambient transaction automatically, which is what makes the "no write
   * without an outbox entry" invariant hold.
   */
  async enqueue(input: EnqueueInput): Promise<void> {
    // Coalesce: an entity with an undelivered operation does not need two,
    // because the payload is built from the current record when it is drained.
    const supersededRows = await this.db.outbox
      .where('[entityType+entityId]')
      .equals([input.entityType, input.entityId])
      .filter((row) => COALESCEABLE.includes(row.state))
      .toArray()

    if (supersededRows.length > 0) {
      await this.db.outbox.bulkDelete(supersededRows.map((row) => row.seq as number))
    }

    // Coalescing keeps the *oldest* base: what matters is the last version this
    // device had seen from anyone else, not its own intermediate edits.
    const oldest = supersededRows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0]
    const baseHlc = oldest ? oldest.baseHlc : input.baseHlc

    await this.db.outbox.add({
      operationId: createId(),
      entityType: input.entityType,
      entityId: input.entityId,
      operation: input.operation,
      hlc: input.hlc,
      baseHlc,
      deviceId: input.deviceId,
      state: 'pending',
      attempts: 0,
      createdAt: nowIso(),
    })
  }

  /** Next batch to upload, in drain order. */
  async listPending(limit = 200): Promise<OutboxRow[]> {
    return this.db.outbox.where('state').equals('pending').limit(limit).sortBy('seq')
  }

  async countByState(): Promise<Record<OutboxState, number>> {
    const counts: Record<OutboxState, number> = {
      pending: 0,
      uploading: 0,
      synced: 0,
      failed: 0,
      conflict: 0,
    }
    await this.db.outbox.each((row) => {
      counts[row.state] += 1
    })
    return counts
  }

  async markState(seqs: number[], state: OutboxState): Promise<void> {
    if (seqs.length === 0) return
    await this.db.outbox.where('seq').anyOf(seqs).modify({ state })
  }

  async markFailed(seq: number, errorCode: string): Promise<void> {
    await this.db.outbox
      .where('seq')
      .equals(seq)
      .modify((row) => {
        row.state = 'failed'
        row.attempts += 1
        row.lastError = errorCode
      })
  }

  /**
   * Drops undelivered operations for one entity.
   *
   * Used when a newer version arrives from another device: our queued change
   * lost, and pushing it afterwards would send the *current* record under a
   * stale clock value.
   */
  async discard(entityType: EntityType, entityId: string): Promise<number> {
    const superseded = await this.db.outbox
      .where('[entityType+entityId]')
      .equals([entityType, entityId])
      .filter((row) => COALESCEABLE.includes(row.state))
      .primaryKeys()

    if (superseded.length === 0) return 0
    await this.db.outbox.bulkDelete(superseded)
    return superseded.length
  }

  /** True when this device holds a change for that entity the server has not seen. */
  async hasUndelivered(entityType: EntityType, entityId: string): Promise<boolean> {
    const rows = await this.db.outbox
      .where('[entityType+entityId]')
      .equals([entityType, entityId])
      .filter((row) => row.state !== 'synced')
      .count()
    return rows > 0
  }

  /** Delivered operations are not history; sync history lives on the server. */
  async clearSynced(): Promise<number> {
    return this.db.outbox.where('state').equals('synced').delete()
  }

  /**
   * Bounds the queue for accounts that will never drain it (Free, or a lapsed
   * subscription — docs/sync.md §3). Only the queue is pruned; the records it
   * refers to are untouched, so nothing the user created is lost.
   */
  async prune(maxEntries: number): Promise<number> {
    const total = await this.db.outbox.count()
    if (total <= maxEntries) return 0

    const excess = total - maxEntries
    const oldest = await this.db.outbox.orderBy('seq').limit(excess).primaryKeys()
    await this.db.outbox.bulkDelete(oldest)
    return oldest.length
  }
}
