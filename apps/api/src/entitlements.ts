/**
 * Entitlement resolution (docs/subscriptions.md §4).
 *
 * The server is the authority. This is the only place that turns a plan and a
 * subscription status into what an account may do.
 */
import { DEFAULT_PLANS, FREE_PLAN_ID, findPlan } from '@clinote/config'
import type { Entitlement } from '@clinote/types'
import type { Stores } from './storage'

const ENTITLED_STATUSES = new Set(['active', 'trialing'])

export async function resolveEntitlement(stores: Stores, userId: string): Promise<Entitlement> {
  const subscription = await stores.subscriptions.findByUserId(userId)
  const devices = await stores.devices.listForUser(userId)

  const entitled = subscription !== null && ENTITLED_STATUSES.has(subscription.status)
  const planId = entitled ? subscription.planId : FREE_PLAN_ID
  const plan = findPlan(DEFAULT_PLANS, planId) ?? findPlan(DEFAULT_PLANS, FREE_PLAN_ID)

  if (!plan) throw new Error('Plan catalog is empty: the free plan must always exist')

  return {
    planId: plan.id,
    status: subscription?.status ?? 'active',
    features: plan.features,
    limits: plan.limits,
    usage: {
      storageBytes: 0,
      devices: devices.length,
      members: 1,
    },
    expiresAt: subscription?.currentPeriodEnd ?? null,
  }
}

/**
 * How many devices this person may register.
 *
 * Their own plan is the floor. A workspace they belong to can raise it, because
 * a member has to be able to register the computer they work on — the clinic's
 * Business plan is what pays for that, and an assistant who was invited into it
 * should not have to buy their own subscription to open the app at work.
 *
 * This does not hand them anything else. Their *personal* stream is still
 * governed by their own plan, so a free member gets a working device and no
 * free cloud sync of their own (docs/subscriptions.md §4).
 */
export async function resolveDeviceLimit(stores: Stores, userId: string): Promise<number> {
  const own = await resolveEntitlement(stores, userId)
  let limit = own.limits.maxDevices ?? 0

  for (const workspace of await stores.workspaces.listForUser(userId)) {
    const owner = await resolveEntitlement(stores, workspace.ownerUserId)
    if (owner.features.teams !== true) continue
    limit = Math.max(limit, owner.limits.maxDevices ?? 0)
  }

  return limit
}
