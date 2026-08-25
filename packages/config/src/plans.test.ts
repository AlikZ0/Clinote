import { describe, expect, it } from 'vitest'
import { planSchema } from '@clinote/types'
import { DEFAULT_PLANS } from './plans'

describe('seed plan catalog', () => {
  it('matches the published plan contract', () => {
    for (const plan of DEFAULT_PLANS) {
      expect(() => planSchema.parse(plan)).not.toThrow()
    }
  })

  it('keeps prices in integer minor units', () => {
    for (const plan of DEFAULT_PLANS) {
      expect(Number.isInteger(plan.price.amount)).toBe(true)
    }
  })

  it('encodes the feature matrix from the product spec §8', () => {
    const byId = Object.fromEntries(DEFAULT_PLANS.map((plan) => [plan.id, plan]))
    expect(byId.free?.features.cloudBackup).toBe(false)
    expect(byId.pro?.features.cloudBackup).toBe(true)
    expect(byId.pro?.limits.backupRetentionDays).toBe(30)
    expect(byId.business?.limits.backupRetentionDays).toBeGreaterThanOrEqual(365)
  })
})
