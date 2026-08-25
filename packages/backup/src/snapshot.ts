/**
 * The `database.json` document inside an archive.
 *
 * What travels: client data and its tombstones. What does not: the device id,
 * the hybrid clock, sync cursors and the outbox. Those describe *this device*,
 * not the practice — importing them would give two devices the same identity
 * and corrupt causal ordering (docs/sync.md §2).
 */
import { z } from 'zod'
import { appointmentSchema, clientSchema, fileMetaSchema, workSchema } from '@clinote/types'

/** File metadata plus where its bytes live inside the archive. */
export const snapshotFileSchema = z.object({
  meta: fileMetaSchema,
  /** Path inside the zip, e.g. `files/clients/<clientId>/<fileId>.jpg`. */
  path: z.string().min(1),
})

export const databaseSnapshotSchema = z.object({
  clients: z.array(clientSchema),
  works: z.array(workSchema),
  files: z.array(snapshotFileSchema),
  appointments: z.array(appointmentSchema),
})

export type SnapshotFile = z.infer<typeof snapshotFileSchema>
export type DatabaseSnapshot = z.infer<typeof databaseSnapshotSchema>

export function countSnapshot(snapshot: DatabaseSnapshot): {
  clients: number
  works: number
  files: number
  appointments: number
} {
  return {
    clients: snapshot.clients.length,
    works: snapshot.works.length,
    files: snapshot.files.length,
    appointments: snapshot.appointments.length,
  }
}

/**
 * Serialized deterministically: the same database must produce the same bytes,
 * otherwise the checksum is not reproducible and "is this archive intact?"
 * cannot be answered.
 */
export function serializeSnapshot(snapshot: DatabaseSnapshot): string {
  const ordered: DatabaseSnapshot = {
    clients: [...snapshot.clients].sort(byId),
    works: [...snapshot.works].sort(byId),
    files: [...snapshot.files].sort((a, b) => compare(a.meta.id, b.meta.id)),
    appointments: [...snapshot.appointments].sort(byId),
  }
  return JSON.stringify(ordered)
}

export function parseSnapshot(json: string): DatabaseSnapshot {
  return databaseSnapshotSchema.parse(JSON.parse(json))
}

function byId(a: { id: string }, b: { id: string }): number {
  return compare(a.id, b.id)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
