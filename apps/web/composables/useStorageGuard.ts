/**
 * Storage durability (docs/architecture.md R1, docs/mobile.md §2).
 *
 * The whole product rests on the local database surviving. This composable is
 * what tells the user whether it will, and what to do about it.
 */
import { estimateStorage, getLocalCore, requestPersistentStorage } from '~/database'
import {
  assessStorageRisk,
  detectPlatform,
  installInstructions,
  type Platform,
  type StorageAdvice,
} from '~/utils/platform'

/** Records that we already asked, so the request is not repeated on every write. */
const PERSISTENCE_ASKED_SETTING = 'storage.persistenceAskedAt'

export function useStorageGuard() {
  const platform = useState<Platform>('storage.platform', () => 'unknown')
  const standalone = useState('storage.standalone', () => false)
  const persisted = useState('storage.persisted', () => false)
  const usageBytes = useState('storage.usage', () => 0)
  const quotaBytes = useState('storage.quota', () => 0)
  const quotaKnown = useState('storage.quotaKnown', () => false)
  const installPromptAvailable = useState('storage.installPromptAvailable', () => false)

  const advice = computed<StorageAdvice>(() =>
    assessStorageRisk({
      platform: platform.value,
      standalone: standalone.value,
      persisted: persisted.value,
    }),
  )

  const instructions = computed(() => installInstructions(platform.value))

  async function refresh(): Promise<void> {
    if (typeof navigator === 'undefined') return

    platform.value = detectPlatform(navigator.userAgent, navigator.maxTouchPoints)
    standalone.value = detectStandalone()
    persisted.value = (await navigator.storage?.persisted?.()) ?? false

    const estimate = await estimateStorage()
    usageBytes.value = estimate.usageBytes
    quotaBytes.value = estimate.quotaBytes
    quotaKnown.value = estimate.available
  }

  /** Requires a user gesture on most browsers, so it is bound to a button. */
  async function requestPersistence(): Promise<boolean> {
    const granted = await requestPersistentStorage()
    persisted.value = granted
    await markAsked()
    return granted
  }

  /**
   * Asked once, right after the first real write — the moment the user has
   * something to lose and the browser is most likely to say yes.
   */
  async function ensureRequestedAfterFirstWrite(): Promise<void> {
    if (persisted.value) return
    try {
      const core = await getLocalCore()
      const askedAt = await core.settings.get<string | null>(PERSISTENCE_ASKED_SETTING, null)
      if (askedAt) return
      persisted.value = await requestPersistentStorage()
      await markAsked()
    } catch {
      // Never let a durability hint break a save that already succeeded.
    }
  }

  async function markAsked(): Promise<void> {
    try {
      const core = await getLocalCore()
      await core.settings.set(PERSISTENCE_ASKED_SETTING, new Date().toISOString())
    } catch {
      // Not worth surfacing: the worst case is that we ask again.
    }
  }

  return {
    platform,
    standalone,
    persisted,
    usageBytes,
    quotaBytes,
    quotaKnown,
    installPromptAvailable,
    advice,
    instructions,
    refresh,
    requestPersistence,
    ensureRequestedAfterFirstWrite,
  }
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  // iOS Safari predates the display-mode media query for installed web apps.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}
