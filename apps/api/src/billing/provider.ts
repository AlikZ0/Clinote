/**
 * Billing provider port (docs/subscriptions.md §7, product spec §72).
 *
 * No provider SDK type appears outside an adapter. App Store and Play in-app
 * purchase, which a mobile wrapper will eventually require, are another
 * implementation of this same interface — which is why `restoreSubscription`
 * is in the contract from day one.
 */
import type { SubscriptionRecord } from '../storage'

export interface CheckoutInput {
  userId: string
  email: string
  planId: string
  interval: 'month' | 'year'
  successUrl: string
  cancelUrl: string
}

export interface CheckoutSession {
  /** The page the person is sent to in order to pay. */
  url: string
  externalId: string | null
}

export type BillingEventType =
  | 'subscription.activated'
  | 'subscription.renewed'
  | 'subscription.past_due'
  | 'subscription.canceled'
  | 'subscription.expired'

export interface BillingEvent {
  /** The provider's event id: used to make redelivery harmless. */
  externalId: string
  type: BillingEventType
  userId: string
  planId: string
  currentPeriodEnd: string | null
  providerSubscriptionId: string | null
}

export interface BillingProvider {
  readonly name: string
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>
  cancelSubscription(subscription: SubscriptionRecord): Promise<void>
  /** Re-reads the provider's state; used by "restore purchases". */
  restoreSubscription(userId: string): Promise<BillingEvent | null>
  /**
   * Verifies a webhook and turns it into events.
   *
   * Throws when the signature does not verify: an unverified webhook is not a
   * malformed request, it is an attempt to change what an account may do.
   */
  handleWebhook(rawBody: string, signature: string | undefined): Promise<BillingEvent[]>
}
