/**
 * Entitlement snapshot (docs/subscriptions.md §4).
 *
 * The client never derives capability from a plan id; it reads this object.
 * The server is authoritative and re-checks on every paid route.
 */
import { z } from 'zod'

export const featureFlags = [
  'cloudSync',
  'cloudBackup',
  'cloudRestore',
  'multiDevice',
  'appointments',
  'calendar',
  'notifications',
  'pushNotifications',
  'emailNotifications',
  'teams',
  'workspaces',
  'auditLog',
] as const

export const featureFlagSchema = z.enum(featureFlags)

export const limitKeys = [
  'storageBytes',
  'backupRetentionDays',
  'maxDevices',
  'maxWorkspaces',
  'maxMembers',
] as const

export const limitKeySchema = z.enum(limitKeys)

export const subscriptionStatuses = [
  'active',
  'trialing',
  'past_due',
  'canceled',
  'expired',
] as const
export const subscriptionStatusSchema = z.enum(subscriptionStatuses)

export const planSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.object({
    /** Minor units, so no floating point money ever reaches the UI. */
    amount: z.number().int().nonnegative(),
    currency: z.string().length(3),
    interval: z.enum(['month', 'year']),
  }),
  features: z.record(featureFlagSchema, z.boolean()),
  limits: z.record(limitKeySchema, z.number().int().nonnegative()),
  isPublic: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
})

export const entitlementSchema = z.object({
  planId: z.string().min(1),
  status: subscriptionStatusSchema,
  // Partial on purpose: an unknown or absent flag means "denied". A client
  // running against a newer server must fail closed, never open.
  features: z.partialRecord(featureFlagSchema, z.boolean()),
  limits: z.partialRecord(limitKeySchema, z.number().int().nonnegative()),
  usage: z.object({
    storageBytes: z.number().int().nonnegative().default(0),
    devices: z.number().int().nonnegative().default(0),
    members: z.number().int().nonnegative().default(0),
  }),
  expiresAt: z.iso.datetime().nullable().default(null),
})

export type FeatureFlag = z.infer<typeof featureFlagSchema>
export type LimitKey = z.infer<typeof limitKeySchema>
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>
export type Plan = z.infer<typeof planSchema>
export type Entitlement = z.infer<typeof entitlementSchema>
