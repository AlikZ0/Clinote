/**
 * Workspaces, roles and permissions (product spec §41–§43).
 *
 * A role is a name for a set of permissions. Code asks whether a member *may*
 * do something, never what their role is called — so a future custom role
 * changes one table here and nothing else.
 */
import { z } from 'zod'

export const workspaceRoles = ['owner', 'admin', 'doctor', 'assistant', 'viewer'] as const
export const workspaceRoleSchema = z.enum(workspaceRoles)
export type WorkspaceRole = (typeof workspaceRoles)[number]

export const permissions = [
  /** Rename or delete the workspace. */
  'workspace.manage',
  'members.invite',
  'members.manage',
  'audit.read',
  'clients.read',
  'clients.write',
  'clients.delete',
  'appointments.manage',
  'backups.manage',
  'sync.participate',
] as const

export type Permission = (typeof permissions)[number]

const READ_ONLY: Permission[] = ['clients.read', 'sync.participate']

const ASSISTANT: Permission[] = [...READ_ONLY, 'clients.write', 'appointments.manage']

const DOCTOR: Permission[] = [...ASSISTANT, 'clients.delete']

const ADMIN: Permission[] = [
  ...DOCTOR,
  'members.invite',
  'members.manage',
  'audit.read',
  'backups.manage',
]

/**
 * Only the owner may rename or delete the workspace, or change the owner's own
 * role — otherwise an admin could lock the owner out of their own practice.
 */
const OWNER: Permission[] = [...ADMIN, 'workspace.manage']

export const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly Permission[]> = {
  owner: OWNER,
  admin: ADMIN,
  doctor: DOCTOR,
  assistant: ASSISTANT,
  viewer: READ_ONLY,
}

export function can(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission)
}

export const workspaceSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  role: workspaceRoleSchema,
  memberCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
})

export const workspaceMemberSchema = z.object({
  userId: z.uuid(),
  email: z.email(),
  name: z.string().max(120).nullable(),
  role: workspaceRoleSchema,
  joinedAt: z.iso.datetime().nullable(),
})

export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
})

export const inviteMemberRequestSchema = z.object({
  email: z.email().max(254).toLowerCase(),
  role: workspaceRoleSchema.exclude(['owner']),
})

export const changeRoleRequestSchema = z.object({
  role: workspaceRoleSchema.exclude(['owner']),
})

export const auditActions = [
  'LOGIN',
  'WORKSPACE_CREATED',
  'WORKSPACE_RENAMED',
  'MEMBER_INVITED',
  'MEMBER_JOINED',
  'MEMBER_REMOVED',
  'ROLE_CHANGED',
  'BACKUP_CREATED',
  'BACKUP_RESTORED',
  'CLIENT_CREATED',
  'CLIENT_UPDATED',
  'CLIENT_DELETED',
  'WORK_CREATED',
  'FILE_ADDED',
  'APPOINTMENT_CREATED',
] as const

export const auditActionSchema = z.enum(auditActions)
export type AuditAction = (typeof auditActions)[number]

export const auditEventSchema = z.object({
  id: z.string(),
  action: auditActionSchema,
  actorEmail: z.email().nullable(),
  resourceType: z.string().nullable(),
  resourceId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
})

export type Workspace = z.infer<typeof workspaceSchema>
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>
export type AuditEvent = z.infer<typeof auditEventSchema>
