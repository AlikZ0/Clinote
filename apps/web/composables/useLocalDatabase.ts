/**
 * Reactive view of the local core (docs/local-first.md §3).
 *
 * Components never touch Dexie or a repository directly; they use this
 * composable, which owns the lifecycle and translates failures into messages.
 */
import { AppError, toAppError } from '@clinote/shared'
import {
  estimateStorage,
  getLocalCore,
  requestPersistentStorage,
  type LocalCore,
  type SyncSummary,
} from '~/database'

export interface DatabaseCounts {
  clients: number
  works: number
  files: number
  appointments: number
}

export interface StorageState {
  usageBytes: number
  quotaBytes: number
  available: boolean
  /**
   * Whether the browser promised not to evict this origin. On iOS Safari a
   * "false" here means the data can disappear after about a week
   * (docs/architecture.md R1) and the UI has to say so.
   */
  persisted: boolean
}

export function useLocalDatabase() {
  const ready = useState('database.ready', () => false)
  const errorMessage = useState<string | null>('database.error', () => null)
  const counts = useState<DatabaseCounts>('database.counts', () => ({
    clients: 0,
    works: 0,
    files: 0,
    appointments: 0,
  }))
  const storage = useState<StorageState>('database.storage', () => ({
    usageBytes: 0,
    quotaBytes: 0,
    available: false,
    persisted: false,
  }))
  const sync = useState<SyncSummary | null>('database.sync', () => null)

  async function withCore<T>(operation: (core: LocalCore) => Promise<T>): Promise<T | null> {
    try {
      const core = await getLocalCore()
      const result = await operation(core)
      errorMessage.value = null
      return result
    } catch (error) {
      const appError = error instanceof AppError ? error : toAppError(error)
      errorMessage.value = appError.message
      return null
    }
  }

  async function refresh(): Promise<void> {
    await withCore(async (core) => {
      counts.value = {
        clients: await core.clients.count(),
        works: await core.works.count(),
        files: await core.files.count(),
        appointments: await core.appointments.count(),
      }
      sync.value = await core.sync.summary(navigator.onLine)
      const estimate = await estimateStorage()
      storage.value = {
        ...estimate,
        persisted:
          typeof navigator !== 'undefined' && navigator.storage?.persisted
            ? await navigator.storage.persisted()
            : false,
      }
      ready.value = true
    })
  }

  /** Asked for explicitly, because browsers only grant it on a user gesture. */
  async function enablePersistentStorage(): Promise<boolean> {
    const granted = await requestPersistentStorage()
    storage.value = { ...storage.value, persisted: granted }
    return granted
  }

  onMounted(() => {
    void refresh()
  })

  return { ready, errorMessage, counts, storage, sync, refresh, enablePersistentStorage }
}
