/**
 * Local core assembly.
 *
 * One database handle, one mutation context, one outbox — shared by every
 * repository, because HLC monotonicity and the "write + enqueue in one
 * transaction" invariant depend on them being singletons per database.
 */
import { AppError } from '@clinote/shared'
import { type ClinoteDatabase, openDatabase } from './db'
import { createMutationContext, type MutationContext } from './context'
import { databaseNameFor } from './schema'
import { AppointmentRepository } from './repositories/appointmentRepository'
import { BackupRepository } from './repositories/backupRepository'
import { ClientRepository } from './repositories/clientRepository'
import { FileRepository } from './repositories/fileRepository'
import { OutboxRepository } from './repositories/outboxRepository'
import { SettingsRepository } from './repositories/settingsRepository'
import { SyncRepository } from './repositories/syncRepository'
import { WorkRepository } from './repositories/workRepository'

export interface LocalCore {
  /** Null for the personal dataset (docs/indexeddb.md §1). */
  workspaceId: string | null
  db: ClinoteDatabase
  context: MutationContext
  clients: ClientRepository
  works: WorkRepository
  files: FileRepository
  appointments: AppointmentRepository
  settings: SettingsRepository
  sync: SyncRepository
  outbox: OutboxRepository
  backups: BackupRepository
  close: () => void
}

export async function createLocalCore(
  options: { name?: string; workspaceId?: string; deviceId?: string } = {},
): Promise<LocalCore> {
  const name = options.name ?? databaseNameFor(options.workspaceId)
  const db = await openDatabase(name)
  const context = await createMutationContext(db, options.deviceId)
  const outbox = new OutboxRepository(db)
  const deps = { db, context, outbox }

  return {
    workspaceId: options.workspaceId ?? null,
    db,
    context,
    outbox,
    clients: new ClientRepository(deps),
    works: new WorkRepository(deps),
    files: new FileRepository(deps),
    appointments: new AppointmentRepository(deps),
    settings: new SettingsRepository(db),
    sync: new SyncRepository(db, outbox),
    backups: new BackupRepository(db),
    close: () => db.close(),
  }
}

let corePromise: Promise<LocalCore> | null = null
let activeWorkspace: string | null = null

export const ACTIVE_WORKSPACE_SETTING = 'workspace.active'

/**
 * Which dataset the app is currently showing.
 *
 * Each workspace gets its own IndexedDB database rather than a column on every
 * row (docs/indexeddb.md §1). Two reasons, and both matter more than the
 * convenience of one database: a query can never accidentally cross a
 * workspace boundary, and losing access to a workspace becomes a database that
 * is simply not opened, rather than rows that have to be hunted down.
 */
export function activeWorkspaceId(): string | null {
  return activeWorkspace
}

function assertIndexedDb(): void {
  if (typeof indexedDB === 'undefined') {
    throw new AppError('storage_unavailable', {
      message: 'Clinote needs local storage, which is unavailable in this browser mode.',
    })
  }
}

/**
 * Process-wide handle for the running app. Never call this during SSR or in a
 * worker without IndexedDB — the failure would otherwise surface as an opaque
 * `ReferenceError` far from its cause.
 */
export function getLocalCore(): Promise<LocalCore> {
  try {
    assertIndexedDb()
  } catch (error) {
    return Promise.reject(error)
  }
  corePromise ??= createLocalCore(activeWorkspace ? { workspaceId: activeWorkspace } : {})
  return corePromise
}

/**
 * Runs something against the personal database, whichever workspace is open.
 *
 * The personal database is the device's home base: the device id and the choice
 * of active workspace live there, because both have to be readable before any
 * workspace database can be opened. When it is not the active one it is opened
 * briefly and closed again — a second permanently open handle would be one more
 * thing to keep consistent for no gain.
 */
export async function withPersonalCore<T>(operation: (core: LocalCore) => Promise<T>): Promise<T> {
  if (activeWorkspace === null) return operation(await getLocalCore())

  const personal = await createLocalCore()
  try {
    return await operation(personal)
  } finally {
    personal.close()
  }
}

/** Restores the workspace this device was last working in. */
export async function restoreActiveWorkspace(): Promise<string | null> {
  assertIndexedDb()
  const workspaceId = await withPersonalCore(async (core) => {
    const stored = await core.settings.get(ACTIVE_WORKSPACE_SETTING, '')
    return stored.length > 0 ? stored : null
  })

  if (workspaceId !== activeWorkspace) await switchWorkspace(workspaceId)
  return activeWorkspace
}

/**
 * Opens another dataset.
 *
 * The previous core is closed first: two open handles to two databases would
 * let a screen keep rendering rows from the workspace the user just left.
 */
export async function switchWorkspace(workspaceId: string | null): Promise<LocalCore> {
  assertIndexedDb()

  const deviceId = await withPersonalCore(async (core) => {
    await core.settings.set(ACTIVE_WORKSPACE_SETTING, workspaceId ?? '')
    return core.context.deviceId
  })

  await closeLocalCore()
  activeWorkspace = workspaceId
  corePromise = createLocalCore(workspaceId ? { workspaceId, deviceId } : { deviceId })
  return corePromise
}

export async function closeLocalCore(): Promise<void> {
  const existing = corePromise
  corePromise = null
  if (existing) (await existing).close()
}

export {
  ClinoteDatabase,
  openDatabase,
  estimateStorage,
  requestPersistentStorage,
  assertStorageHeadroom,
} from './db'
export { DATABASE_NAME, DATABASE_VERSION, databaseNameFor } from './schema'
export type {
  AppointmentRow,
  ClientRow,
  ConflictRow,
  CryptoKeyRow,
  FileRow,
  LocalBackupRow,
  OutboxRow,
  WorkRow,
} from './schema'
export type { MutationContext } from './context'
export type { Page, PageOptions } from './repositories/base'
export type { SyncSummary, SyncStatus } from './repositories/syncRepository'
export type { BackupHealth } from './repositories/backupRepository'
export type { AddFileInput } from './repositories/fileRepository'
export { ImportWriter } from './importWriter'
export type { ImportPayload, ImportTallies, PreparedFile } from './importWriter'
