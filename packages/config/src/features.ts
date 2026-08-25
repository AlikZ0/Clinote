/**
 * Feature access (docs/subscriptions.md §4, product spec §45).
 *
 * There is exactly one place in the codebase that answers "can this user do
 * this?", and it reads the server-issued entitlement snapshot. Frontend gating
 * is UX; the backend re-checks every paid route.
 */
import type { Entitlement, FeatureFlag, LimitKey } from '@clinote/types'

/** Statuses that keep paid capability switched on. */
const ENTITLED_STATUSES = new Set(['active', 'trialing'])

export const ANONYMOUS_ENTITLEMENT: Entitlement = {
  planId: 'free',
  status: 'active',
  features: {},
  limits: {},
  usage: { storageBytes: 0, devices: 0, members: 0 },
  expiresAt: null,
}

export class FeatureAccessService {
  constructor(private entitlement: Entitlement = ANONYMOUS_ENTITLEMENT) {}

  setEntitlement(entitlement: Entitlement): void {
    this.entitlement = entitlement
  }

  get planId(): string {
    return this.entitlement.planId
  }

  canUse(feature: FeatureFlag): boolean {
    if (!ENTITLED_STATUSES.has(this.entitlement.status)) return false
    return this.entitlement.features[feature] === true
  }

  limit(key: LimitKey): number {
    return this.entitlement.limits[key] ?? 0
  }

  /** Remaining headroom for a numeric limit; never negative. */
  remaining(key: Extract<LimitKey, 'storageBytes' | 'maxDevices' | 'maxMembers'>): number {
    const used =
      key === 'storageBytes'
        ? this.entitlement.usage.storageBytes
        : key === 'maxDevices'
          ? this.entitlement.usage.devices
          : this.entitlement.usage.members
    return Math.max(0, this.limit(key) - used)
  }

  isWithinLimit(
    key: Extract<LimitKey, 'storageBytes' | 'maxDevices' | 'maxMembers'>,
    additional = 0,
  ): boolean {
    return this.remaining(key) >= additional
  }
}
