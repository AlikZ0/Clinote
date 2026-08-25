/**
 * Subscription state (docs/subscriptions.md §6, §7).
 *
 * Webhooks are the source of truth; a checkout redirect is only a UX signal.
 * Every state change an account can undergo passes through here, so the rules
 * can be read in one place.
 */
import { randomUUID } from 'node:crypto'
import { AppError } from '@clinote/shared'
import { FREE_PLAN_ID } from '@clinote/config'
import type { Entitlement } from '@clinote/types'
import { resolveEntitlement } from '../entitlements'
import type { Stores, SubscriptionRecord } from '../storage'
import type { BillingEvent, BillingProvider } from './provider'

export interface BillingStores {
  /** Records a processed webhook so a redelivery changes nothing. */
  recordEvent(event: {
    id: string
    provider: string
    externalId: string
    type: string
    userId: string | null
    payload: unknown
  }): Promise<boolean>
  recordCheckout(checkout: {
    id: string
    userId: string
    planId: string
    provider: string
    externalId: string | null
  }): Promise<void>
}

const STATUS_FOR_EVENT: Record<BillingEvent['type'], SubscriptionRecord['status']> = {
  'subscription.activated': 'active',
  'subscription.renewed': 'active',
  'subscription.past_due': 'past_due',
  'subscription.canceled': 'canceled',
  'subscription.expired': 'expired',
}

export class BillingService {
  constructor(
    private readonly stores: Stores,
    private readonly billing: BillingStores,
    private readonly provider: BillingProvider,
  ) {}

  async startCheckout(input: {
    userId: string
    planId: string
    interval: 'month' | 'year'
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string }> {
    const plan = await this.stores.plans.findById(input.planId)
    if (!plan || !plan.isPublic || plan.id === FREE_PLAN_ID) {
      throw new AppError('validation_failed', { message: 'That plan cannot be purchased.' })
    }

    const user = await this.stores.users.findById(input.userId)
    if (!user) throw new AppError('unauthenticated', { message: 'Please sign in again.' })

    const session = await this.provider.createCheckout({
      userId: user.id,
      email: user.email,
      planId: plan.id,
      interval: input.interval,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    })

    await this.billing.recordCheckout({
      id: randomUUID(),
      userId: user.id,
      planId: plan.id,
      provider: this.provider.name,
      externalId: session.externalId,
    })

    // Deliberately no subscription row yet: a started checkout is not a paid
    // subscription, and the webhook is what says otherwise.
    return { url: session.url }
  }

  async cancel(userId: string): Promise<{ subscription: SubscriptionRecord | null }> {
    const subscription = await this.stores.subscriptions.findByUserId(userId)
    if (!subscription) {
      throw new AppError('not_found', { message: 'There is no subscription to cancel.' })
    }

    await this.provider.cancelSubscription(subscription)

    // The provider's webhook decides when access actually ends. Until then the
    // account keeps what it paid for.
    return { subscription }
  }

  async restore(userId: string): Promise<{ entitlement: Entitlement }> {
    const event = await this.provider.restoreSubscription(userId)
    if (event) await this.apply(event)
    return { entitlement: await resolveEntitlement(this.stores, userId) }
  }

  /** Verifies, de-duplicates and applies. */
  async handleWebhook(
    rawBody: string,
    signature: string | undefined,
  ): Promise<{ applied: number }> {
    const events = await this.provider.handleWebhook(rawBody, signature)
    let applied = 0

    for (const event of events) {
      // An event may name an account that has since been deleted. It is still
      // recorded — the payload keeps what the provider said — but the column
      // stays null so the reference remains honest.
      const user = await this.stores.users.findById(event.userId)

      const fresh = await this.billing.recordEvent({
        id: randomUUID(),
        provider: this.provider.name,
        externalId: event.externalId,
        type: event.type,
        userId: user ? event.userId : null,
        payload: event,
      })

      // Redelivery is normal, not an error: providers retry.
      if (!fresh) continue

      if (user) await this.apply(event)
      applied += 1
    }

    return { applied }
  }

  private async apply(event: BillingEvent): Promise<void> {
    await this.stores.subscriptions.upsert({
      userId: event.userId,
      planId: event.planId,
      status: STATUS_FOR_EVENT[event.type],
      currentPeriodEnd: event.currentPeriodEnd,
    })
  }
}
