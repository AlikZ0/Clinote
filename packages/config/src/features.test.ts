import { describe, expect, it } from 'vitest'
import type { Entitlement } from '@clinote/types'
import { FeatureAccessService } from './features'
import { DEFAULT_PLANS, findPlan } from './plans'

function entitlementFor(planId: string, overrides: Partial<Entitlement> = {}): Entitlement {
  const plan = findPlan(DEFAULT_PLANS, planId)
  if (!plan) throw new Error(`missing seed plan ${planId}`)
  return {
    planId: plan.id,
    status: 'active',
    features: plan.features,
    limits: plan.limits,
    usage: { storageBytes: 0, devices: 0, members: 0 },
    expiresAt: null,
    ...overrides,
  }
}

describe('FeatureAccessService', () => {
  it('denies cloud features on free', () => {
    const access = new FeatureAccessService(entitlementFor('free'))
    expect(access.canUse('cloudSync')).toBe(false)
    expect(access.canUse('appointments')).toBe(false)
    expect(access.canUse('teams')).toBe(false)
  })

  it('grants sync, backup and appointments on pro but not teams', () => {
    const access = new FeatureAccessService(entitlementFor('pro'))
    expect(access.canUse('cloudSync')).toBe(true)
    expect(access.canUse('cloudBackup')).toBe(true)
    expect(access.canUse('appointments')).toBe(true)
    expect(access.canUse('teams')).toBe(false)
  })

  it('grants team features on business', () => {
    const access = new FeatureAccessService(entitlementFor('business'))
    expect(access.canUse('teams')).toBe(true)
    expect(access.canUse('auditLog')).toBe(true)
  })

  it('revokes paid capability once the subscription is no longer active', () => {
    const access = new FeatureAccessService(entitlementFor('pro', { status: 'expired' }))
    expect(access.canUse('cloudSync')).toBe(false)
    expect(access.canUse('cloudBackup')).toBe(false)
  })

  it('reports storage headroom against the plan limit', () => {
    const access = new FeatureAccessService(
      entitlementFor('pro', { usage: { storageBytes: 9.5 * 1024 ** 3, devices: 2, members: 1 } }),
    )
    expect(access.isWithinLimit('storageBytes', 0.25 * 1024 ** 3)).toBe(true)
    expect(access.isWithinLimit('storageBytes', 2 * 1024 ** 3)).toBe(false)
    expect(access.remaining('maxDevices')).toBe(1)
  })
})
