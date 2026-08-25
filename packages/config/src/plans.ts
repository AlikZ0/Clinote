/**
 * Seed plan catalog.
 *
 * IMPORTANT: this file is a *default*, used to seed an empty database and to
 * render the pricing page before the API responds. The runtime source of truth
 * is `GET /api/v1/plans`, served from the `plans` table, so prices and limits
 * change without a frontend deploy (product spec §7, docs/subscriptions.md §2).
 *
 * Nothing in the application may branch on a plan id. Branch on features.
 */
import type { FeatureFlag, LimitKey, Plan } from '@clinote/types'

const GB = 1024 ** 3

type FeatureMap = Record<FeatureFlag, boolean>
type LimitMap = Record<LimitKey, number>

const NO_FEATURES: FeatureMap = {
  cloudSync: false,
  cloudBackup: false,
  cloudRestore: false,
  multiDevice: false,
  appointments: false,
  calendar: false,
  notifications: false,
  pushNotifications: false,
  emailNotifications: false,
  teams: false,
  workspaces: false,
  auditLog: false,
}

const PRO_FEATURES: FeatureMap = {
  ...NO_FEATURES,
  cloudSync: true,
  cloudBackup: true,
  cloudRestore: true,
  multiDevice: true,
  appointments: true,
  calendar: true,
  notifications: true,
  pushNotifications: true,
  emailNotifications: true,
}

const BUSINESS_FEATURES: FeatureMap = {
  ...PRO_FEATURES,
  teams: true,
  workspaces: true,
  auditLog: true,
}

export const DEFAULT_PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Clinote Free',
    price: { amount: 0, currency: 'USD', interval: 'month' },
    features: NO_FEATURES,
    limits: {
      storageBytes: 0,
      backupRetentionDays: 0,
      maxDevices: 0,
      maxWorkspaces: 0,
      maxMembers: 0,
    } satisfies LimitMap,
    isPublic: true,
    sortOrder: 0,
  },
  {
    id: 'pro',
    name: 'Clinote Pro',
    price: { amount: 599, currency: 'USD', interval: 'month' },
    features: PRO_FEATURES,
    limits: {
      storageBytes: 10 * GB,
      backupRetentionDays: 30,
      maxDevices: 3,
      maxWorkspaces: 1,
      maxMembers: 1,
    } satisfies LimitMap,
    isPublic: true,
    sortOrder: 1,
  },
  {
    id: 'business',
    name: 'Clinote Business',
    price: { amount: 1499, currency: 'USD', interval: 'month' },
    features: BUSINESS_FEATURES,
    limits: {
      storageBytes: 100 * GB,
      backupRetentionDays: 365,
      maxDevices: 10,
      maxWorkspaces: 10,
      maxMembers: 25,
    } satisfies LimitMap,
    isPublic: true,
    sortOrder: 2,
  },
]

export const FREE_PLAN_ID = 'free'

export function findPlan(plans: readonly Plan[], planId: string): Plan | undefined {
  return plans.find((plan) => plan.id === planId)
}
