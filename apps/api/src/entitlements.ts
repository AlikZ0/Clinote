/**
 * Entitlement resolution (docs/subscriptions.md §4, Phase 18 P0).
 *
 * The server is the authority. This is the only place that turns a plan and a
 * subscription status into what an account may do.
 *
 * INVARIANT I7: Plan catalog is loaded from the database, never hardcoded.
 * This enables per-org plan overrides (Phase 22) and plan catalog management.
 */
import { FREE_PLAN_ID } from '@clinote/config'
import type { Entitlement } from '@clinote/types'
import type { Stores } from './storage'

const ENTITLED_STATUSES = new Set(['active', 'trialing'])

/**
 * Resolve entitlements for a user (legacy path, deprecated in Phase 18).
 *
 * Users have entitlements through their organization's subscription.
 * This function is kept for backwards compatibility during migration.
 * TODO Phase 19: Remove when all code paths use resolveOrganizationEntitlement.
 */
export async function resolveEntitlement(stores: Stores, userId: string): Promise<Entitlement> {
  const subscription = await stores.subscriptions.findByUserId(userId)
  const devices = await stores.devices.listForUser(userId)
  const storageUsage = await stores.storageUsage.find(userId)

  const entitled = subscription !== null && ENTITLED_STATUSES.has(subscription.status)
  const planId = entitled ? subscription.planId : FREE_PLAN_ID

  // FIXED: Load plan from database, not hardcoded DEFAULT_PLANS (Invariant I7)
  const plan = await stores.plans.findById(planId)
  if (!plan) {
    const freePlan = await stores.plans.findById(FREE_PLAN_ID)
    if (!freePlan) {
      throw new Error(
        `Plan catalog missing: neither "${planId}" nor free plan "${FREE_PLAN_ID}" found in database`,
      )
    }
  }

  const resolvedPlan = plan || (await stores.plans.findById(FREE_PLAN_ID))
  if (!resolvedPlan) {
    throw new Error(`Plan catalog corrupted: free plan "${FREE_PLAN_ID}" not found in database`)
  }

  return {
    planId: resolvedPlan.id,
    status: subscription?.status ?? 'active',
    features: resolvedPlan.features,
    limits: resolvedPlan.limits,
    usage: {
      // FIXED: Calculate from actual storage, not hardcoded 0
      storageBytes: storageUsage?.bytesUsed ?? 0,
      devices: devices.length,
      // FIXED: Members is org-based, not hardcoded 1; for now use device count as proxy
      // TODO Phase 19: Pass organizationId and count actual org members
      members: 1,
    },
    expiresAt: subscription?.currentPeriodEnd ?? null,
  }
}

/**
 * Resolve entitlements for an organization (Phase 18, new path).
 *
 * Organizations hold subscriptions and billing information.
 * This is the authoritative path for Phase 18+.
 *
 * @param organizationId - The organization's UUID
 * @returns Entitlement resolved from the org's subscription
 */
export async function resolveOrganizationEntitlement(
  stores: Stores,
  organizationId: string,
): Promise<Entitlement> {
  const subscription = await stores.subscriptions.findByOrganizationId(organizationId)

  const entitled = subscription !== null && ENTITLED_STATUSES.has(subscription.status)
  const planId = entitled ? subscription.planId : FREE_PLAN_ID

  // I7: the catalog is data. An unknown plan id degrades to free rather than
  // handing out a plan the operator never published.
  const plan = (await stores.plans.findById(planId)) ?? (await stores.plans.findById(FREE_PLAN_ID))
  if (!plan) {
    throw new Error(
      `Plan catalog missing: neither "${planId}" nor free plan "${FREE_PLAN_ID}" found in database`,
    )
  }

  return {
    planId: plan.id,
    status: subscription?.status ?? 'active',
    features: plan.features,
    limits: plan.limits,
    usage: {
      // Storage and devices are still measured per account, not per
      // organization: an org's quota is the sum over its workspaces, and
      // nothing aggregates that yet. Reporting zero is honest about what is
      // measured; the members count is the one the invite path gates on, and
      // it is real.
      storageBytes: 0,
      devices: 0,
      members: await stores.organizations.countMembers(organizationId),
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
