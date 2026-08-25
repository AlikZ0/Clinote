/**
 * Sync state that lives on the device: the pull cursor, the outbox summary and
 * unresolved conflicts (docs/sync.md §4, §5, §7).
 *
 * Nothing here talks to the network. The sync engine (Phase 9) is built on top
 * of this and on the outbox repository.
 */
import { createId, nowIso, toAppError } from '@clinote/shared'
import type { EntityType, OutboxState } from '@clinote/types'
import type { ClinoteDatabase } from '../db'
import type { ConflictRow } from '../schema'
import type { OutboxRepository } from './outboxRepository'

export const SYNC_CURSOR_KEY = 'sync.cursor'
export const LAST_PULL_KEY = 'sync.lastPullAt'

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'conflict' | 'failed'

export interface SyncSummary {
  status: SyncStatus
  pending: number
  failed: number
  conflicts: number
  lastPullAt: string | null
}

export class SyncRepository {
  constructor(
    private readonly db: ClinoteDatabase,
    private readonly outbox: OutboxRepository,
  ) {}

  async getCursor(): Promise<number> {
    const row = await this.db.syncState.get(SYNC_CURSOR_KEY)
    return typeof row?.value === 'number' ? row.value : 0
  }

  /** Advances the pull cursor. Never moves backwards. */
  async setCursor(seq: number): Promise<void> {
    try {
      await this.db.transaction('rw', this.db.syncState, async () => {
        const current = await this.getCursor()
        if (seq <= current) return
        await this.db.syncState.put({ key: SYNC_CURSOR_KEY, value: seq, updatedAt: nowIso() })
      })
    } catch (error) {
      throw toAppError(error)
    }
  }

  async getLastPullAt(): Promise<string | null> {
    const row = await this.db.syncState.get(LAST_PULL_KEY)
    return typeof row?.value === 'string' ? row.value : null
  }

  async markPulled(at: string = nowIso()): Promise<void> {
    await this.db.syncState.put({ key: LAST_PULL_KEY, value: at, updatedAt: nowIso() })
  }

  /**
   * Records a conflict instead of discarding the losing version
   * (docs/sync.md §5). Both snapshots are kept until the user chooses.
   */
  async recordConflict(input: {
    entityType: EntityType
    entityId: string
    localSnapshot: unknown
    remoteSnapshot: unknown
  }): Promise<ConflictRow> {
    // An envelope can be delivered more than once; one open card per entity is
    // what a person can actually act on.
    const existing = await this.db.conflicts
      .where('entityId')
      .equals(input.entityId)
      .filter((row) => row.resolvedAt === null)
      .first()
    if (existing) return existing

    const conflict: ConflictRow = {
      id: createId(),
      entityType: input.entityType,
      entityId: input.entityId,
      detectedAt: nowIso(),
      localSnapshot: input.localSnapshot,
      remoteSnapshot: input.remoteSnapshot,
      resolvedAt: null,
    }
    await this.db.conflicts.put(conflict)
    return conflict
  }

  async listUnresolvedConflicts(): Promise<ConflictRow[]> {
    return this.db.conflicts.filter((row) => row.resolvedAt === null).toArray()
  }

  async resolveConflict(id: string): Promise<void> {
    await this.db.conflicts.update(id, { resolvedAt: nowIso() })
  }

  /** The single source for the sync chip (docs/sync.md §7). */
  async summary(isOnline: boolean): Promise<SyncSummary> {
    const counts: Record<OutboxState, number> = await this.outbox.countByState()
    const conflicts = (await this.listUnresolvedConflicts()).length
    const lastPullAt = await this.getLastPullAt()

    const status: SyncStatus = !isOnline
      ? 'offline'
      : conflicts > 0
        ? 'conflict'
        : counts.failed > 0
          ? 'failed'
          : counts.pending > 0 || counts.uploading > 0
            ? 'syncing'
            : 'synced'

    return { status, pending: counts.pending, failed: counts.failed, conflicts, lastPullAt }
  }
}
