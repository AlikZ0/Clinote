/**
 * Local index of exports and cloud backups (docs/indexeddb.md §2).
 *
 * The server stays authoritative for cloud backup history; this table is what
 * the app can show offline, and it is what proves to a Free user that an export
 * actually happened.
 */
import { createId, nowIso, toAppError } from '@clinote/shared'
import type { ClinoteDatabase } from '../db'
import type { LocalBackupKind, LocalBackupRow, LocalBackupStatus } from '../schema'
import { DATABASE_VERSION } from '../schema'

export interface RecordBackupInput {
  kind: LocalBackupKind
  deviceId: string
  appVersion: string
  sizeBytes?: number
  checksum?: string | null
}

export interface BackupHealth {
  lastSuccessfulAt: string | null
  lastFailedAt: string | null
  successCount: number
  failureCount: number
  /** True when the most recent attempt failed, or nothing has ever succeeded. */
  needsAttention: boolean
}

export class BackupRepository {
  constructor(private readonly db: ClinoteDatabase) {}

  /** Opens an attempt in `pending`; the caller completes or fails it. */
  async start(input: RecordBackupInput): Promise<LocalBackupRow> {
    const row: LocalBackupRow = {
      id: createId(),
      kind: input.kind,
      status: 'pending',
      createdAt: nowIso(),
      completedAt: null,
      sizeBytes: input.sizeBytes ?? 0,
      checksum: input.checksum ?? null,
      deviceId: input.deviceId,
      appVersion: input.appVersion,
      databaseVersion: DATABASE_VERSION,
      errorCode: null,
    }
    try {
      await this.db.backups.put(row)
      return row
    } catch (error) {
      throw toAppError(error)
    }
  }

  async complete(id: string, patch: { sizeBytes: number; checksum: string }): Promise<void> {
    await this.db.backups.update(id, {
      status: 'completed' satisfies LocalBackupStatus,
      completedAt: nowIso(),
      sizeBytes: patch.sizeBytes,
      checksum: patch.checksum,
      errorCode: null,
    })
  }

  async fail(id: string, errorCode: string): Promise<void> {
    await this.db.backups.update(id, {
      status: 'failed' satisfies LocalBackupStatus,
      completedAt: nowIso(),
      errorCode,
    })
  }

  async list(limit = 30): Promise<LocalBackupRow[]> {
    return this.db.backups.orderBy('createdAt').reverse().limit(limit).toArray()
  }

  async latestSuccessful(kind?: LocalBackupKind): Promise<LocalBackupRow | null> {
    const rows = await this.db.backups
      .orderBy('createdAt')
      .reverse()
      .filter((row) => row.status === 'completed' && (!kind || row.kind === kind))
      .limit(1)
      .toArray()
    return rows[0] ?? null
  }

  /** Backup health for the dashboard (docs/backup.md §5). */
  async health(sinceIso: string): Promise<BackupHealth> {
    let lastSuccessfulAt: string | null = null
    let lastFailedAt: string | null = null
    let successCount = 0
    let failureCount = 0
    let mostRecentStatus: LocalBackupStatus | null = null
    let mostRecentAt = ''

    await this.db.backups.each((row) => {
      if (row.createdAt >= sinceIso) {
        if (row.status === 'completed') successCount += 1
        if (row.status === 'failed') failureCount += 1
      }
      if (row.status === 'completed' && (!lastSuccessfulAt || row.createdAt > lastSuccessfulAt)) {
        lastSuccessfulAt = row.createdAt
      }
      if (row.status === 'failed' && (!lastFailedAt || row.createdAt > lastFailedAt)) {
        lastFailedAt = row.createdAt
      }
      if (row.status !== 'pending' && row.createdAt > mostRecentAt) {
        mostRecentAt = row.createdAt
        mostRecentStatus = row.status
      }
    })

    return {
      lastSuccessfulAt,
      lastFailedAt,
      successCount,
      failureCount,
      needsAttention: mostRecentStatus !== 'completed',
    }
  }
}
