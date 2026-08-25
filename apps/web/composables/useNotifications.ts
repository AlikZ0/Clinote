/**
 * Reminders on this device (docs/notifications.md §3, §6).
 *
 * Push is never assumed to work: iOS grants it only to an installed app, a
 * browser can refuse permission, and a server may not be configured for it.
 * Every one of those is reported as itself.
 */
import { AppError } from '@clinote/shared'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '@clinote/types'
import { getLocalCore } from '~/database'
import { ReminderService } from '~/services/reminderService'

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on'

export function useNotifications() {
  const preferences = useState<NotificationPreferences>(
    'notifications.preferences',
    () => DEFAULT_NOTIFICATION_PREFERENCES,
  )
  const pushState = useState<PushState>('notifications.push', () => 'off')
  const busy = useState('notifications.busy', () => false)
  const errorMessage = useState<string | null>('notifications.error', () => null)

  const { canUse } = useFeatureAccess()
  const { isAuthenticated } = useAuth()

  const eligible = computed(() => isAuthenticated.value && canUse('notifications'))

  async function service(): Promise<ReminderService> {
    return new ReminderService(await getLocalCore(), useApi())
  }

  async function refresh(): Promise<void> {
    if (!eligible.value) return
    try {
      preferences.value = await (await service()).preferences()
    } catch (error) {
      errorMessage.value = describeError(error)
    }
    await refreshPushState()
  }

  async function refreshPushState(): Promise<void> {
    if (
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      !('PushManager' in window)
    ) {
      pushState.value = 'unsupported'
      return
    }
    if (Notification.permission === 'denied') {
      pushState.value = 'denied'
      return
    }

    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    pushState.value = subscription ? 'on' : 'off'
  }

  async function save(next: NotificationPreferences): Promise<boolean> {
    return run(async () => {
      preferences.value = await (await service()).savePreferences(next)
      // Schedules were computed from the old answer; make the server agree.
      await (await service()).publishUpcoming(preferences.value)
    })
  }

  async function enablePush(): Promise<boolean> {
    return run(async () => {
      if (pushState.value === 'unsupported') {
        throw new AppError('feature_not_available', {
          message:
            'This browser cannot receive push notifications. On iPhone, add Clinote to your Home Screen first.',
        })
      }

      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        pushState.value = permission === 'denied' ? 'denied' : 'off'
        throw new AppError('forbidden', {
          message: 'Notifications are blocked for Clinote in this browser.',
        })
      }

      const { publicKey } = await useApi().request<{ publicKey: string }>('/notifications/push/key')
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        // Required by every browser that implements Web Push: a push must
        // result in something the user sees.
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(publicKey) as BufferSource,
      })

      const json = subscription.toJSON() as { endpoint: string; keys: Record<string, string> }
      await useApi().request('/notifications/push/subscribe', {
        method: 'POST',
        body: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          deviceId: (await getLocalCore()).context.deviceId,
        },
      })

      pushState.value = 'on'
    })
  }

  async function disablePush(): Promise<boolean> {
    return run(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (!subscription) {
        pushState.value = 'off'
        return
      }

      await useApi()
        .request('/notifications/push/subscribe', {
          method: 'DELETE',
          body: { endpoint: subscription.endpoint },
        })
        .catch(() => undefined)
      await subscription.unsubscribe()
      pushState.value = 'off'
    })
  }

  /** Called after appointments change, so the server's schedule matches. */
  async function republish(): Promise<void> {
    if (!eligible.value) return
    try {
      await (await service()).publishUpcoming(preferences.value)
    } catch {
      // A missed reminder is bad; a screen that will not load is worse.
    }
  }

  async function run(operation: () => Promise<void>): Promise<boolean> {
    busy.value = true
    errorMessage.value = null
    try {
      await operation()
      return true
    } catch (error) {
      errorMessage.value = describeError(error)
      return false
    } finally {
      busy.value = false
    }
  }

  return {
    preferences,
    pushState,
    busy,
    errorMessage,
    eligible,
    refresh,
    save,
    enablePush,
    disablePush,
    republish,
  }
}

/** VAPID keys travel as base64url; `subscribe` wants raw bytes. */
function decodeVapidKey(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.padEnd(key.length + ((4 - (key.length % 4)) % 4), '=')
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
