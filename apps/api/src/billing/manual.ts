/**
 * Development billing provider.
 *
 * It stands in for a payment processor so the whole flow — checkout, webhook,
 * entitlement change, cancellation — can be exercised without one. It takes no
 * money and must never run in production; `createBillingProvider` refuses.
 *
 * The webhook signature is a real HMAC, because getting signature verification
 * wrong is exactly the kind of thing a fake would let through.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { AppError } from '@clinote/shared'
import type { SubscriptionRecord } from '../storage'
import type {
  BillingEvent,
  BillingEventType,
  BillingProvider,
  CheckoutInput,
  CheckoutSession,
} from './provider'

export interface ManualProviderOptions {
  webhookSecret: string
  /** Where the stand-in "payment page" lives. */
  checkoutBaseUrl: string
}

const EVENT_TYPES = new Set<BillingEventType>([
  'subscription.activated',
  'subscription.renewed',
  'subscription.past_due',
  'subscription.canceled',
  'subscription.expired',
])

export function createManualBillingProvider(options: ManualProviderOptions): BillingProvider {
  return {
    name: 'manual',

    async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
      const externalId = `chk_${randomUUID()}`
      const url = new URL(options.checkoutBaseUrl)
      url.searchParams.set('session', externalId)
      url.searchParams.set('plan', input.planId)
      url.searchParams.set('success', input.successUrl)
      url.searchParams.set('cancel', input.cancelUrl)
      return { url: url.toString(), externalId }
    },

    async cancelSubscription(_subscription: SubscriptionRecord): Promise<void> {
      // A real provider would schedule the cancellation; here the webhook that
      // follows is what changes the state, exactly as in production.
    },

    async restoreSubscription(): Promise<BillingEvent | null> {
      // Nothing to restore from: this provider holds no state of its own.
      return null
    },

    async handleWebhook(rawBody: string, signature: string | undefined): Promise<BillingEvent[]> {
      if (!signature || !verify(rawBody, signature, options.webhookSecret)) {
        throw new AppError('forbidden', { message: 'Invalid webhook signature.' })
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        throw new AppError('validation_failed', { message: 'Webhook body is not JSON.' })
      }

      const event = parsed as Partial<BillingEvent> & { type?: string }
      if (
        typeof event.externalId !== 'string' ||
        typeof event.userId !== 'string' ||
        typeof event.planId !== 'string' ||
        !event.type ||
        !EVENT_TYPES.has(event.type as BillingEventType)
      ) {
        throw new AppError('validation_failed', { message: 'Webhook body is not a billing event.' })
      }

      return [
        {
          externalId: event.externalId,
          type: event.type as BillingEventType,
          userId: event.userId,
          planId: event.planId,
          currentPeriodEnd: event.currentPeriodEnd ?? null,
          providerSubscriptionId: event.providerSubscriptionId ?? null,
        },
      ]
    },
  }
}

export function signWebhook(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

function verify(rawBody: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signWebhook(rawBody, secret))
  const actual = Buffer.from(signature)
  // Constant time: a signature check that leaks timing is not a check.
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
