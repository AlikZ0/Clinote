/**
 * Local database schema (docs/indexeddb.md §2).
 *
 * Row types = domain entity + derived index fields. The derived fields exist
 * only to make IndexedDB queries exact and are stripped before an entity leaves
 * the repository layer, so nothing above this file knows they exist.
 */
import type { Appointment, Client, EntityType, FileMeta, OutboxState, Work } from '@clinote/types'

export const DATABASE_NAME = 'clinote'

/** Dexie version. This is the `databaseVersion` written into a backup manifest. */
export const DATABASE_VERSION = 1

/** Business workspaces get their own database (docs/indexeddb.md §1). */
export function databaseNameFor(workspaceId?: string): string {
  return workspaceId ? `${DATABASE_NAME}_ws_${workspaceId}` : DATABASE_NAME
}

/**
 * Separator used to build unique sort keys.
 *
 * It must sort below every character that can appear in user text, otherwise
 * "Van" would order after "Van Dijk". NUL satisfies that and cannot occur in a
 * name, a date or an id.
 */
const KEY_SEPARATOR = '\u0000'

export type DeletedFlag = 0 | 1

export interface DerivedRow {
  /**
   * IndexedDB omits records whose indexed value is null/undefined, so deletion
   * is indexed as a number and `deletedAt` stays the data.
   */
  isDeleted: DeletedFlag
}

export interface ClientRow extends Client, DerivedRow {
  /** lastName + firstName + id, lower-cased: unique, sortable, prefix-searchable. */
  sortKey: string
}

export interface WorkRow extends Work, DerivedRow {
  /** date + id: unique, so cursor pagination over one client's works is exact. */
  dateKey: string
}

export interface FileRow extends FileMeta, DerivedRow {
  createdKey: string
}

export interface AppointmentRow extends Appointment, DerivedRow {
  startKey: string
}

/** Bytes live apart from metadata (docs/indexeddb.md §4). */
export interface FileBlobRow {
  id: string
  original: Blob
  thumbnail: Blob | null
}

export interface OutboxRow {
  /** Auto-incremented drain order. */
  seq?: number
  operationId: string
  entityType: EntityType
  entityId: string
  operation: 'put' | 'delete'
  hlc: string
  /**
   * The record's clock value *before* this change, or null for a creation.
   *
   * This is what makes divergence detectable: a receiver whose own value
   * differs from the sender's base knows the sender never saw its version
   * (docs/sync.md §5).
   */
  baseHlc: string | null
  deviceId: string
  state: OutboxState
  attempts: number
  lastError?: string
  createdAt: string
}

export interface SettingRow {
  key: string
  value: unknown
  updatedAt: string
}

export interface SyncStateRow {
  key: string
  value: unknown
  updatedAt: string
}

export type LocalBackupKind = 'local_export' | 'cloud_backup'
export type LocalBackupStatus = 'pending' | 'completed' | 'failed'

/**
 * Local index of exports and cloud backups. The server remains authoritative
 * for cloud backup history (docs/backup.md §5); this table is what the app can
 * show while offline, and what proves an export actually happened.
 */
export interface LocalBackupRow {
  id: string
  kind: LocalBackupKind
  status: LocalBackupStatus
  createdAt: string
  completedAt: string | null
  sizeBytes: number
  checksum: string | null
  deviceId: string
  appVersion: string
  databaseVersion: number
  errorCode: string | null
}

/**
 * A key handle kept so a reload does not demand the passphrase again.
 *
 * The keys are non-extractable: the browser will use them for encryption but
 * will not hand their bytes to anything. Exposure is no greater than the local
 * database itself, which is plaintext on this device by design.
 */
export interface CryptoKeyRow {
  /**
   * Either the account data key, or — in a workspace database — the workspace
   * key a colleague sealed for this device. The passphrase-derived KEK is
   * never stored, and neither is anything that could rebuild it.
   */
  id: 'dek' | 'workspace-dek'
  key: CryptoKey
  storedAt: string
}

export interface ConflictRow {
  id: string
  entityType: EntityType
  entityId: string
  detectedAt: string
  /** Our version at detection time, kept until the user chooses (docs/sync.md §5). */
  localSnapshot: unknown
  remoteSnapshot: unknown
  resolvedAt: string | null
}

export function uniqueKey(sortValue: string, id: string): string {
  return `${sortValue}${KEY_SEPARATOR}${id}`
}

export function clientSortKey(client: Pick<Client, 'id' | 'firstName' | 'lastName'>): string {
  return [client.lastName, client.firstName, client.id].join(KEY_SEPARATOR).toLowerCase()
}

export function toClientRow(client: Client): ClientRow {
  return { ...client, isDeleted: client.deletedAt ? 1 : 0, sortKey: clientSortKey(client) }
}

export function toWorkRow(work: Work): WorkRow {
  return { ...work, isDeleted: work.deletedAt ? 1 : 0, dateKey: uniqueKey(work.date, work.id) }
}

export function toFileRow(file: FileMeta): FileRow {
  return {
    ...file,
    isDeleted: file.deletedAt ? 1 : 0,
    createdKey: uniqueKey(file.createdAt, file.id),
  }
}

export function toAppointmentRow(appointment: Appointment): AppointmentRow {
  return {
    ...appointment,
    isDeleted: appointment.deletedAt ? 1 : 0,
    startKey: uniqueKey(appointment.startAt, appointment.id),
  }
}

/** Derived fields never leave the repository layer. */
export const DERIVED_FIELDS = ['isDeleted', 'sortKey', 'dateKey', 'createdKey', 'startKey'] as const

export function stripDerived<T>(row: Record<string, unknown>): T {
  const copy = { ...row }
  for (const field of DERIVED_FIELDS) delete copy[field]
  return copy as T
}
