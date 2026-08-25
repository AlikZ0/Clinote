/**
 * Authentication contract (docs/api.md §2, §3; docs/security.md §3).
 *
 * Shared by the API and the web client so the two cannot drift.
 */
import { z } from 'zod'
import { entitlementSchema } from './entitlements'

/**
 * Long enough to matter, short enough to be typed on a phone. Length beats
 * composition rules, which mostly produce `Password1!`.
 */
export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 200

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH)
export const emailSchema = z.email().max(254).toLowerCase()

export const userSchema = z.object({
  id: z.uuid(),
  email: emailSchema,
  name: z.string().max(120).nullable(),
  locale: z.string().max(16).nullable(),
  timezone: z.string().max(64).nullable(),
  emailVerifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})

export const tokensSchema = z.object({
  accessToken: z.string().min(1),
  /** Seconds until the access token expires; the client refreshes before then. */
  expiresIn: z.number().int().positive(),
})

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().max(120).optional(),
})

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
})

export const authResponseSchema = z.object({
  user: userSchema,
  tokens: tokensSchema,
  entitlement: entitlementSchema,
})

export const forgotPasswordRequestSchema = z.object({ email: emailSchema })

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
})

export const updateProfileRequestSchema = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  locale: z.string().max(16).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
})

export const meResponseSchema = z.object({
  user: userSchema,
  entitlement: entitlementSchema,
})

export const platformSchema = z.enum(['ios', 'android', 'web', 'desktop', 'unknown'])

/**
 * The device id is generated on the device and sent by the client.
 *
 * It has to be: the same id stamps every sync envelope and every hybrid clock
 * value (docs/sync.md §2), so a server-assigned id would make the queue refer
 * to a device that does not exist.
 */
export const registerDeviceRequestSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  platform: platformSchema,
})

export type User = z.infer<typeof userSchema>
export type Tokens = z.infer<typeof tokensSchema>
export type AuthResponse = z.infer<typeof authResponseSchema>
export type MeResponse = z.infer<typeof meResponseSchema>
export type RegisterRequest = z.infer<typeof registerRequestSchema>
export type LoginRequest = z.infer<typeof loginRequestSchema>
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>
export type Platform = z.infer<typeof platformSchema>
