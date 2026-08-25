/**
 * Dexie database handle.
 *
 * This module owns opening, storage-persistence negotiation and the translation
 * of storage failures into the shared error taxonomy. Nothing above it ever
 * sees a `DOMException` (product spec §68).
 */
import Dexie, { type Table } from 'dexie'
import { AppError, toAppError } from '@clinote/shared'
import { applyMigrations } from './migrations'
import {
  DATABASE_VERSION,
  databaseNameFor,
  type AppointmentRow,
  type ClientRow,
  type ConflictRow,
  type CryptoKeyRow,
  type FileBlobRow,
  type FileRow,
  type LocalBackupRow,
  type OutboxRow,
  type SettingRow,
  type SyncStateRow,
  type WorkRow,
} from './schema'

export class ClinoteDatabase extends Dexie {
  clients!: Table<ClientRow, string>
  works!: Table<WorkRow, string>
  files!: Table<FileRow, string>
  fileBlobs!: Table<FileBlobRow, string>
  appointments!: Table<AppointmentRow, string>
  settings!: Table<SettingRow, string>
  syncState!: Table<SyncStateRow, string>
  outbox!: Table<OutboxRow, number>
  backups!: Table<LocalBackupRow, string>
  conflicts!: Table<ConflictRow, string>
  cryptoKeys!: Table<CryptoKeyRow, string>

  constructor(name: string = databaseNameFor()) {
    super(name)
    applyMigrations(this)
  }

  get schemaVersion(): number {
    return DATABASE_VERSION
  }
}

export async function openDatabase(name: string = databaseNameFor()): Promise<ClinoteDatabase> {
  const db = new ClinoteDatabase(name)
  try {
    await db.open()
    return db
  } catch (error) {
    // A failed open is the one storage error a user cannot work around by
    // deleting a file, so it gets its own message rather than the generic one.
    if (
      error instanceof Error &&
      (error.name === 'VersionError' || error.name === 'InvalidStateError')
    ) {
      throw new AppError('database_corrupted', {
        message:
          'Clinote could not open the local database on this device. Your data may need to be restored from a backup.',
        cause: error,
      })
    }
    throw toAppError(error)
  }
}

/**
 * Ask the browser to exempt this origin from storage eviction.
 *
 * On iOS Safari a non-installed site loses IndexedDB after ~7 days of
 * inactivity, which for a Free user is the loss of the system of record
 * (docs/architecture.md R1). The answer is surfaced in the UI; it is never
 * assumed to be `true`.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export interface StorageEstimate {
  usageBytes: number
  quotaBytes: number
  available: boolean
}

export async function estimateStorage(): Promise<StorageEstimate> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { usageBytes: 0, quotaBytes: 0, available: false }
  }
  try {
    const estimate = await navigator.storage.estimate()
    return {
      usageBytes: estimate.usage ?? 0,
      quotaBytes: estimate.quota ?? 0,
      available: typeof estimate.quota === 'number',
    }
  } catch {
    return { usageBytes: 0, quotaBytes: 0, available: false }
  }
}

/**
 * Refuses a write that would obviously exceed the device quota, so the user
 * gets a sentence instead of a `QuotaExceededError` mid-transaction.
 */
export async function assertStorageHeadroom(requiredBytes: number): Promise<void> {
  const estimate = await estimateStorage()
  if (!estimate.available || estimate.quotaBytes === 0) return
  const remaining = estimate.quotaBytes - estimate.usageBytes
  if (remaining < requiredBytes) {
    throw new AppError('storage_quota_exceeded', {
      message: 'Not enough storage on this device.',
      details: { requiredBytes, remainingBytes: Math.max(0, remaining) },
    })
  }
}
