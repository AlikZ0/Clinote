/**
 * Sync engine (docs/sync.md).
 *
 * Local first, always: the engine only ever moves what the repositories have
 * already committed. It can fail, stall or be switched off without a single
 * local operation noticing.
 */
import { AppError, compareHlc, toAppError } from '@clinote/shared'
import type {
  Appointment,
  Client,
  EntityType,
  FileMeta,
  SyncChange,
  SyncEnvelope,
  Work,
} from '@clinote/types'
import { fromUtf8, utf8 } from '@clinote/crypto'
import type { LocalCore } from '~/database'
import { decodePayload, encodePayload, type EnvelopeCipher } from './encryption'

export interface SyncTransport {
  push(envelopes: SyncEnvelope[]): Promise<{ seq: Record<string, number> }>
  changes(
    since: number,
    limit: number,
  ): Promise<{
    items: SyncChange[]
    nextCursor: number | null
    hasMore: boolean
  }>
  setCursor(deviceId: string, seq: number): Promise<void>
}

export interface SyncOutcome {
  pushed: number
  applied: number
  skipped: number
  conflicts: number
}

export const PUSH_BATCH = 200
export const PULL_BATCH = 200

type SyncedRecord = Client | Work | FileMeta | Appointment

/**
 * The slice of a repository the engine uses.
 *
 * Without it, TypeScript intersects the four repositories' parameter types and
 * no record can satisfy all of them at once. Narrowing here keeps the cast in
 * one place instead of at every call.
 */
interface SyncableRepository {
  getById(id: string, options?: { includeDeleted?: boolean }): Promise<SyncedRecord | null>
  applyRemote(record: SyncedRecord): Promise<SyncedRecord>
}

/** Fields where two people editing at once is a real loss, not a detail. */
export const CONTESTED_FIELDS: Partial<Record<EntityType, string[]>> = {
  client: ['notes'],
  work: ['description', 'notes'],
  appointment: ['startAt', 'endAt', 'notes'],
}

export class SyncEngine {
  constructor(
    private readonly core: LocalCore,
    private readonly transport: SyncTransport,
    private readonly cipher: EnvelopeCipher,
  ) {}

  async syncOnce(): Promise<SyncOutcome> {
    // Push first: a device should not resolve a conflict against a change it
    // has not yet told the server about.
    const pushed = await this.drain()
    const pulled = await this.pull()
    return { pushed, ...pulled }
  }

  /** Uploads queued changes. Returns how many were accepted. */
  async drain(limit = PUSH_BATCH): Promise<number> {
    const pending = await this.core.outbox.listPending(limit)
    if (pending.length === 0) return 0

    const envelopes: SyncEnvelope[] = []
    const sent: number[] = []
    const vanished: number[] = []

    for (const row of pending) {
      const record = await this.load(row.entityType, row.entityId)
      if (!record) {
        // Purged locally before it was ever sent: there is nothing to say.
        vanished.push(row.seq as number)
        continue
      }

      envelopes.push({
        operationId: row.operationId,
        entityType: row.entityType,
        entityId: row.entityId,
        operation: record.deletedAt ? 'delete' : 'put',
        // The record's own clock value, not the queue row's: they can differ
        // once a remote change has been applied, and the payload is the truth.
        hlc: record.hlc,
        baseHlc: row.baseHlc,
        deviceId: this.core.context.deviceId,
        payload: encodePayload(await this.cipher.seal(utf8(JSON.stringify(record)))),
      })
      sent.push(row.seq as number)
    }

    if (vanished.length > 0) await this.core.outbox.markState(vanished, 'synced')
    if (envelopes.length === 0) {
      await this.core.outbox.clearSynced()
      return 0
    }

    await this.core.outbox.markState(sent, 'uploading')
    try {
      await this.transport.push(envelopes)
      await this.core.outbox.markState(sent, 'synced')
      await this.core.outbox.clearSynced()
      return envelopes.length
    } catch (error) {
      const appError = toAppError(error)
      for (const seq of sent) await this.core.outbox.markFailed(seq, appError.code)
      throw appError
    }
  }

  /** Applies everything the server has that this device has not seen. */
  async pull(limit = PULL_BATCH): Promise<{ applied: number; skipped: number; conflicts: number }> {
    let cursor = await this.core.sync.getCursor()
    let applied = 0
    let skipped = 0
    let conflicts = 0
    let hasMore = true

    while (hasMore) {
      const page = await this.transport.changes(cursor, limit)

      for (const change of page.items) {
        cursor = Math.max(cursor, change.seq)

        // Our own envelope coming back: nothing to apply, but the cursor moves.
        if (change.deviceId === this.core.context.deviceId) continue

        const outcome = await this.apply(change)
        if (outcome === 'applied') applied += 1
        else if (outcome === 'conflict') conflicts += 1
        else skipped += 1
      }

      await this.core.sync.setCursor(cursor)
      hasMore = page.hasMore && page.items.length > 0
    }

    await this.core.sync.markPulled()
    // Best effort: the server copy of the cursor is a convenience, the local
    // one is authoritative for this device.
    try {
      await this.transport.setCursor(this.core.context.deviceId, cursor)
    } catch {
      /* the next sync will carry it */
    }

    return { applied, skipped, conflicts }
  }

  private async apply(change: SyncChange): Promise<'applied' | 'skipped' | 'conflict'> {
    const record = await this.decode(change)
    const repository = this.repositoryFor(change.entityType)
    if (!repository) return 'skipped'

    const local = await repository.getById(change.entityId, { includeDeleted: true })

    if (!local) {
      await repository.applyRemote(record)
      return 'applied'
    }

    /*
     * Divergence, not timing: the sender based its change on a version that is
     * not the one we hold, so it never saw ours.
     *
     * Checked before deciding who wins, and therefore symmetric — both devices
     * surface the conflict and both keep the other's text. A heuristic like
     * "do we still have something queued?" only fires on whichever device
     * happened to push last, and silently loses the other's work.
     */
    const diverged = change.baseHlc !== null && change.baseHlc !== local.hlc
    const contested = diverged && this.contests(change.entityType, local, record)
    const incomingWins = compareHlc(record.hlc, local.hlc) > 0

    if (contested) {
      // Both sides changed something that matters, without seeing each other.
      // The remote version wins so every device converges, and ours is kept
      // until a person decides (docs/sync.md §5).
      await this.core.sync.recordConflict({
        entityType: change.entityType,
        entityId: change.entityId,
        localSnapshot: local,
        remoteSnapshot: record,
      })
    }

    // Ours is the same or newer: it stands, and the sender will take it from
    // our push. The conflict, if any, is already recorded.
    if (!incomingWins) return contested ? 'conflict' : 'skipped'

    // Our queued change lost: pushing it later would send the current record
    // under a stale clock value.
    await this.core.outbox.discard(change.entityType, change.entityId)

    await repository.applyRemote(record)
    return contested ? 'conflict' : 'applied'
  }

  private contests(entityType: EntityType, local: SyncedRecord, remote: SyncedRecord): boolean {
    const fields = CONTESTED_FIELDS[entityType]
    if (!fields) return false

    return fields.some((field) => {
      const ours = (local as unknown as Record<string, unknown>)[field]
      const theirs = (remote as unknown as Record<string, unknown>)[field]
      return ours !== theirs && ours !== undefined && ours !== '' && theirs !== undefined
    })
  }

  private async decode(change: SyncChange): Promise<SyncedRecord> {
    const plaintext = await this.cipher.open(decodePayload(change.payload))
    try {
      return JSON.parse(fromUtf8(plaintext)) as SyncedRecord
    } catch (cause) {
      throw new AppError('sync_conflict', {
        message: 'A change arrived in a format this version of Clinote cannot read.',
        cause,
      })
    }
  }

  private async load(entityType: EntityType, entityId: string): Promise<SyncedRecord | null> {
    const repository = this.repositoryFor(entityType)
    if (!repository) return null
    return repository.getById(entityId, { includeDeleted: true })
  }

  private repositoryFor(entityType: EntityType): SyncableRepository | null {
    switch (entityType) {
      case 'client':
        return this.core.clients as unknown as SyncableRepository
      case 'work':
        return this.core.works as unknown as SyncableRepository
      case 'file':
        return this.core.files as unknown as SyncableRepository
      case 'appointment':
        return this.core.appointments as unknown as SyncableRepository
      default:
        // `settings` is device-local until it has a stable id namespace.
        return null
    }
  }
}
