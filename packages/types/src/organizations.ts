/**
 * Organizations: billing and identity boundary (Phase 18, docs/architecture.md).
 *
 * An organization is distinct from a workspace:
 * - Organization = billing unit, SSO boundary, white-label container
 * - Workspace = data unit, encryption boundary, team dataset
 *
 * Organization members are the billing team (manage plan, seats, payment).
 * Workspace members are the data team (access encrypted records).
 * These are separate by design.
 */
import { z } from 'zod'

/**
 * Organization roles: billing/admin only, never 'doctor' or 'patient'.
 * Separate from workspace roles to enforce billing ≠ data access.
 */
export const organizationRoles = ['owner', 'admin', 'billing'] as const
export const organizationRoleSchema = z.enum(organizationRoles)
export type OrganizationRole = (typeof organizationRoles)[number]

/**
 * Organization permissions: billing, member, and org management.
 * Data access (client.read, etc.) is determined by workspace roles only.
 */
export const organizationPermissions = [
  /** Rename, delete, or transfer org. */
  'organization.manage',
  /** Invite/remove billing members. */
  'members.invite',
  'members.manage',
  /** View org audit log. */
  'audit.read',
  /** Manage subscription, plan, seats. */
  'billing.manage',
  /** Read analytics (metadata only, never sync data). */
  'analytics.read',
  /** Configure white-label branding, SSO. */
  'settings.configure',
] as const

export type OrganizationPermission = (typeof organizationPermissions)[number]

const BILLING: OrganizationPermission[] = ['audit.read', 'billing.manage', 'analytics.read']

const ADMIN: OrganizationPermission[] = [
  ...BILLING,
  'members.invite',
  'members.manage',
  'settings.configure',
]

const OWNER: OrganizationPermission[] = ['organization.manage', ...ADMIN]

export const ORG_ROLE_PERMISSIONS: Record<OrganizationRole, readonly OrganizationPermission[]> = {
  billing: BILLING,
  admin: ADMIN,
  owner: OWNER,
}

export function canOrg(role: OrganizationRole, permission: OrganizationPermission): boolean {
  return ORG_ROLE_PERMISSIONS[role].includes(permission)
}

/**
 * White-label customization per organization.
 */
export const organizationBrandingSchema = z.object({
  logoUrl: z.string().url().nullable().default(null),
  primaryColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable()
    .default(null),
  secondaryColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable()
    .default(null),
  customDomain: z.string().min(3).max(253).nullable().default(null), // e.g., clinic.example.com
})

/**
 * Organization settings: SSO, feature flags, configuration.
 */
export const organizationSettingsSchema = z.object({
  ssoEnabled: z.boolean().default(false),
  ssoProvider: z.enum(['google', 'azure', 'okta']).optional(),
  ssoClientId: z.string().optional(), // Never returned to client
  scimEnabled: z.boolean().default(false),
  featureFlagOverrides: z.record(z.string(), z.boolean()).default({}), // Per-org feature flags
})

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  role: organizationRoleSchema,
  branding: organizationBrandingSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const organizationMemberSchema = z.object({
  userId: z.uuid(),
  email: z.email(),
  name: z.string().max(255).nullable(),
  role: organizationRoleSchema,
  joinedAt: z.iso.datetime().nullable(),
})

export const createOrganizationRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
})

export const updateOrganizationRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  branding: organizationBrandingSchema.partial().optional(),
  settings: organizationSettingsSchema.partial().optional(),
})

export const inviteOrganizationMemberRequestSchema = z.object({
  email: z.email().max(254).toLowerCase(),
  role: organizationRoleSchema.exclude(['owner']),
})

export const changeOrganizationRoleRequestSchema = z.object({
  role: organizationRoleSchema.exclude(['owner']),
})

/**
 * Org audit log actions.
 */
export const organizationAuditActions = [
  'ORG_CREATED',
  'ORG_UPDATED',
  'MEMBER_INVITED',
  'MEMBER_JOINED',
  'MEMBER_REMOVED',
  'ROLE_CHANGED',
  'PLAN_CHANGED',
  'SEATS_UPDATED',
  'BRANDING_UPDATED',
  'SSO_ENABLED',
  'BILLING_METHOD_UPDATED',
] as const

export const organizationAuditActionSchema = z.enum(organizationAuditActions)
export type OrganizationAuditAction = (typeof organizationAuditActions)[number]

export const organizationAuditEventSchema = z.object({
  id: z.string(),
  action: organizationAuditActionSchema,
  actorEmail: z.email().nullable(),
  resourceType: z.string().nullable(),
  resourceId: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
})

export type Organization = z.infer<typeof organizationSchema>
export type OrganizationMember = z.infer<typeof organizationMemberSchema>
export type OrganizationAuditEvent = z.infer<typeof organizationAuditEventSchema>
