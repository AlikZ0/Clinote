/**
 * Writes an imported snapshot into the local database.
 *
 * This lives in the database layer, not in a service, because it owns a
 * transaction: the whole import commits or none of it does, which is what keeps
 * the promise that a failed import leaves the current data untouched
 * (docs/architecture.md I5).
 */
import { AppError, createId, nowIso, toAppError } from '@clinote/shared'
import { emptyTally, record as tally, resolveMerge, type MergeTally } from '@clinote/backup'
import type { Appointment, Client, EntityType, FileMeta, Work } from '@clinote/types'
import type { Table } from 'dexie'
import type { ClinoteDatabase } from './db'
import { toAppointmentRow, toClientRow, toFileRow, toWorkRow, type OutboxRow } from './schema'

export interface PreparedFile {
  meta: FileMeta
  original: Blob
  /** Regenerated locally; the archive carries originals only. */
  thumbnail: Blob | null
}

export interface ImportPayload {
  clients: Client[]
  works: Work[]
  appointments: Appointment[]
  files: PreparedFile[]
}

export interface ImportTallies {
  clients: MergeTally
  works: MergeTally
  files: MergeTally
  appointments: MergeTally
}

interface Syncable {
  id: string
  hlc: string
  deletedAt: string | null
}

export class ImportWriter {
  constructor(
    private readonly db: ClinoteDatabase,
    private readonly deviceId: string,
  ) {}

  private tables(): Table<unknown, unknown>[] {
    return [
      this.db.clients,
      this.db.works,
      this.db.files,
      this.db.fileBlobs,
      this.db.appointments,
      this.db.outbox,
    ] as unknown as Table<unknown, unknown>[]
  }

  /**
   * Replaces the entire database.
   *
   * The destructive step and the write are the same transaction, so there is no
   * moment where the old data is gone and the new data is not yet there. The
   * archive was parsed, checksum-verified and fully materialised before this
   * runs (docs/backup.md §7).
   */
  async replace(payload: ImportPayload): Promise<ImportTallies> {
    try {
      return await this.db.transaction('rw', this.tables(), async () => {
        await this.db.clients.clear()
        await this.db.works.clear()
        await this.db.files.clear()
        await this.db.fileBlobs.clear()
        await this.db.appointments.clear()
        // The queue described records that no longer exist.
        await this.db.outbox.clear()

        await this.db.clients.bulkPut(payload.clients.map(toClientRow))
        await this.db.works.bulkPut(payload.works.map(toWorkRow))
        await this.db.appointments.bulkPut(payload.appointments.map(toAppointmentRow))
        await this.db.files.bulkPut(payload.files.map((file) => toFileRow(file.meta)))
        await this.db.fileBlobs.bulkPut(
          payload.files.map((file) => ({
            id: file.meta.id,
            original: file.original,
            thumbnail: file.thumbnail,
          })),
        )

        await this.enqueue([
          ...payload.clients.map((entity) => this.outboxRow('client', entity)),
          ...payload.works.map((entity) => this.outboxRow('work', entity)),
          ...payload.appointments.map((entity) => this.outboxRow('appointment', entity)),
          ...payload.files.map((file) => this.outboxRow('file', file.meta)),
        ])

        await this.verify(payload)

        return {
          clients: fullTally(payload.clients.length),
          works: fullTally(payload.works.length),
          files: fullTally(payload.files.length),
          appointments: fullTally(payload.appointments.length),
        }
      })
    } catch (error) {
      throw asRestoreFailure(error)
    }
  }

  /**
   * Merges by UUID. Which version wins is the hybrid clock's decision, the same
   * one sync makes, so importing an archive twice changes nothing.
   */
  async merge(payload: ImportPayload): Promise<ImportTallies> {
    try {
      return await this.db.transaction('rw', this.tables(), async () => {
        const clients = await this.decide(this.db.clients, payload.clients)
        const works = await this.decide(this.db.works, payload.works)
        const appointments = await this.decide(this.db.appointments, payload.appointments)
        const files = await this.decide(
          this.db.files,
          payload.files.map((file) => file.meta),
        )

        const winningFiles = payload.files.filter((file) =>
          files.winners.some((winner) => winner.id === file.meta.id),
        )

        await this.db.clients.bulkPut(clients.winners.map(toClientRow))
        await this.db.works.bulkPut(works.winners.map(toWorkRow))
        await this.db.appointments.bulkPut(appointments.winners.map(toAppointmentRow))
        await this.db.files.bulkPut(files.winners.map(toFileRow))
        await this.db.fileBlobs.bulkPut(
          winningFiles.map((file) => ({
            id: file.meta.id,
            original: file.original,
            thumbnail: file.thumbnail,
          })),
        )

        await this.enqueue([
          ...clients.winners.map((entity) => this.outboxRow('client', entity)),
          ...works.winners.map((entity) => this.outboxRow('work', entity)),
          ...appointments.winners.map((entity) => this.outboxRow('appointment', entity)),
          ...files.winners.map((entity) => this.outboxRow('file', entity)),
        ])

        return {
          clients: clients.tally,
          works: works.tally,
          files: files.tally,
          appointments: appointments.tally,
        }
      })
    } catch (error) {
      throw asRestoreFailure(error)
    }
  }

  private async decide<T extends Syncable>(
    table: Table<{ id: string; hlc: string; deletedAt: string | null }, string>,
    incoming: T[],
  ): Promise<{ winners: T[]; tally: MergeTally }> {
    const existing = await table.bulkGet(incoming.map((entity) => entity.id))
    const winners: T[] = []
    const counted = emptyTally()

    incoming.forEach((entity, index) => {
      const decision = resolveMerge(existing[index], entity)
      tally(counted, decision)
      if (decision !== 'skip') winners.push(entity)
    })

    return { winners, tally: counted }
  }

  private outboxRow(entityType: EntityType, entity: Syncable): OutboxRow {
    return {
      operationId: createId(),
      entityType,
      entityId: entity.id,
      operation: entity.deletedAt ? 'delete' : 'put',
      // The archive's clock value is kept: rewriting it would claim this device
      // authored changes it only received.
      hlc: entity.hlc,
      // An import is not based on a version this device had seen.
      baseHlc: null,
      deviceId: this.deviceId,
      state: 'pending',
      attempts: 0,
      createdAt: nowIso(),
    }
  }

  /** Replaces any undelivered operation for the same entity, then queues ours. */
  private async enqueue(rows: OutboxRow[]): Promise<void> {
    if (rows.length === 0) return

    const affected = new Set(rows.map((row) => row.entityId))
    const superseded = await this.db.outbox
      .filter(
        (row) => affected.has(row.entityId) && (row.state === 'pending' || row.state === 'failed'),
      )
      .primaryKeys()
    if (superseded.length > 0) await this.db.outbox.bulkDelete(superseded)

    await this.db.outbox.bulkAdd(rows)
  }

  /** Counts are re-read from the live tables; a mismatch rolls the import back. */
  private async verify(payload: ImportPayload): Promise<void> {
    const actual = {
      clients: await this.db.clients.count(),
      works: await this.db.works.count(),
      files: await this.db.files.count(),
      appointments: await this.db.appointments.count(),
      blobs: await this.db.fileBlobs.count(),
    }

    const expected = {
      clients: payload.clients.length,
      works: payload.works.length,
      files: payload.files.length,
      appointments: payload.appointments.length,
      blobs: payload.files.length,
    }

    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      if (actual[key] !== expected[key]) {
        throw new AppError('restore_failed', {
          message: 'The restore did not complete and was rolled back. Your data has not changed.',
          details: { table: key, expected: expected[key], actual: actual[key] },
        })
      }
    }
  }
}

function fullTally(count: number): MergeTally {
  return { inserted: count, updated: 0, skipped: 0 }
}

function asRestoreFailure(error: unknown): AppError {
  const appError = toAppError(error)
  if (appError.code === 'internal') {
    return new AppError('restore_failed', {
      message: 'The import did not complete and was rolled back. Your data has not changed.',
      cause: error,
    })
  }
  return appError
}
