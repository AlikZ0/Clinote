/**
 * Runs the sync engine on this device (docs/sync.md §3, §7).
 *
 * Everything here is best-effort. A failure updates a chip and is retried; it
 * never blocks a local operation, and it never surfaces as a modal.
 */
import { AppError } from '@clinote/shared'
import { getLocalCore } from '~/database'
import type { SyncStatus } from '~/database'
import { createHttpSyncTransport } from '~/services/httpSyncTransport'
import { SyncEngine } from '~/services/syncEngine'
import { ConflictService } from '~/services/conflictService'

/**
 * How often this device looks at its own queue.
 *
 * Driven by the outbox rather than by every screen calling a sync hook: all
 * writes already land there, so one cheap local count catches every mutation
 * without scattering sync concerns through the UI.
 */
const TICK_MS = 15_000

export function useSync() {
  const status = useState<SyncStatus>('sync.status', () => 'synced')
  const pending = useState('sync.pending', () => 0)
  const conflicts = useState('sync.conflicts', () => 0)
  const lastSyncAt = useState<string | null>('sync.lastAt', () => null)
  const errorMessage = useState<string | null>('sync.error', () => null)
  const running = useState('sync.running', () => false)

  const { canUse } = useFeatureAccess()
  const { isAuthenticated } = useAuth()
  const encryption = useEncryption()
  const workspace = useWorkspace()

  async function refreshStatus(): Promise<void> {
    try {
      const core = await getLocalCore()
      const summary = await core.sync.summary(navigator.onLine)
      pending.value = summary.pending
      conflicts.value = summary.conflicts
      lastSyncAt.value = summary.lastPullAt
      if (!running.value) status.value = summary.status
    } catch {
      // The chip is not worth an error message of its own.
    }
  }

  /**
   * The key this device syncs the open dataset with.
   *
   * A workspace has its own key, shared with its members; the personal dataset
   * uses the account key. Getting this wrong would mean pushing envelopes
   * colleagues cannot open, so it is one decision in one place.
   */
  function activeCipher() {
    return workspace.activeId.value ? workspace.cipher() : encryption.cipher()
  }

  /** True when this device is able to sync at all right now. */
  function ready(): boolean {
    if (typeof navigator === 'undefined' || !navigator.onLine) return false
    if (!isAuthenticated.value || !encryption.isUnlocked.value) return false

    // In a workspace the clinic's plan is what pays for sync, and the server
    // decides that. What this device needs locally is the workspace key.
    return workspace.activeId.value ? workspace.keyState.value === 'ready' : canUse('cloudSync')
  }

  async function syncNow(): Promise<void> {
    if (running.value || !ready()) {
      await refreshStatus()
      return
    }

    const cipher = activeCipher()
    if (!cipher) return

    running.value = true
    status.value = 'syncing'
    errorMessage.value = null

    try {
      const core = await getLocalCore()
      const engine = new SyncEngine(core, createHttpSyncTransport(useApi()), cipher)
      const outcome = await engine.syncOnce()

      conflicts.value = await new ConflictService(core).count()
      status.value = conflicts.value > 0 ? 'conflict' : 'synced'
      lastSyncAt.value = new Date().toISOString()

      if (outcome.conflicts > 0) {
        errorMessage.value = `${outcome.conflicts} change(s) need your decision.`
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : null
      status.value = appError?.code === 'network_unavailable' ? 'offline' : 'failed'
      errorMessage.value = describeError(error)
    } finally {
      running.value = false
      await refreshStatus()
    }
  }

  function start(): void {
    void refreshStatus()
    void syncNow()

    const onOnline = () => void syncNow()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncNow()
    }

    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      await refreshStatus()
      // Sync when there is something to say, or when the server may have
      // something to tell us.
      if (pending.value > 0 || Date.now() - Date.parse(lastSyncAt.value ?? '0') > 60_000) {
        void syncNow()
      }
    }, TICK_MS)

    onBeforeUnmount(() => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    })
  }

  return {
    status,
    pending,
    conflicts,
    lastSyncAt,
    errorMessage,
    running,
    ready,
    syncNow,
    refreshStatus,
    start,
  }
}
