/**
 * Subscription state (docs/subscriptions.md §7).
 *
 * The entitlement it returns replaces the local one immediately, so a screen
 * unlocks the moment the server says it may — and locks again the moment it
 * says otherwise.
 */
import type { Entitlement } from '@clinote/types'

export interface SubscriptionView {
  planId: string
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired'
  currentPeriodEnd: string | null
}

export function useSubscription() {
  const subscription = useState<SubscriptionView | null>('subscription.current', () => null)
  const busy = useState('subscription.busy', () => false)
  const errorMessage = useState<string | null>('subscription.error', () => null)

  const { isAuthenticated, registerDevice } = useAuth()
  const { setEntitlement } = useFeatureAccess()

  /**
   * A plan change can be the moment a device becomes allowed to exist.
   *
   * Registration is attempted at sign-in, where a Free account is refused —
   * correctly. Without repeating it here, somebody who upgrades keeps an
   * unregistered device until the next time they open the app, and every sync
   * push is refused in the meantime with nothing on screen to explain it.
   */
  async function applyEntitlement(next: Entitlement): Promise<void> {
    setEntitlement(next)
    try {
      await registerDevice()
    } catch {
      // Best effort: the entitlement is the thing that had to be applied.
    }
  }

  async function refresh(): Promise<void> {
    if (!isAuthenticated.value) {
      subscription.value = null
      return
    }
    try {
      const result = await useApi().request<{
        subscription: SubscriptionView | null
        entitlement: Entitlement
      }>('/subscriptions/me')
      subscription.value = result.subscription
      await applyEntitlement(result.entitlement)
    } catch (error) {
      errorMessage.value = describeError(error)
    }
  }

  /** Sends the person to the provider's page; the webhook decides the rest. */
  async function upgrade(planId: string): Promise<void> {
    busy.value = true
    errorMessage.value = null
    try {
      const { url } = await useApi().request<{ url: string }>('/subscriptions/checkout', {
        method: 'POST',
        body: { planId, interval: 'month' },
      })
      window.location.assign(url)
    } catch (error) {
      errorMessage.value = describeError(error)
    } finally {
      busy.value = false
    }
  }

  async function cancel(): Promise<boolean> {
    busy.value = true
    errorMessage.value = null
    try {
      const result = await useApi().request<{
        subscription: SubscriptionView | null
        entitlement: Entitlement
      }>('/subscriptions/cancel', { method: 'POST' })
      subscription.value = result.subscription
      await applyEntitlement(result.entitlement)
      return true
    } catch (error) {
      errorMessage.value = describeError(error)
      return false
    } finally {
      busy.value = false
    }
  }

  return { subscription, busy, errorMessage, refresh, upgrade, cancel }
}
