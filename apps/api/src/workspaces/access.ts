/**
 * Who may act inside a workspace (product spec §42, docs/security.md §10).
 *
 * Two questions are answered here and nowhere else:
 *   - is this person a member of this workspace, and what may their role do?
 *   - is the workspace *entitled* to exist, which depends on the plan of the
 *     person who owns it, not on the plan of whoever is asking.
 *
 * The second point matters: an assistant on the Free plan works in their
 * clinic's Business workspace. Charging them again for it would be wrong, and
 * checking their own plan would lock them out of their job.
 */
import { AppError } from '@clinote/shared'
import { can, type Permission, type WorkspaceRole } from '@clinote/types'
import { resolveEntitlement } from '../entitlements'
import type { Stores, SyncScope, WorkspaceRecord } from '../storage'

export interface WorkspaceAccess {
  workspace: WorkspaceRecord
  role: WorkspaceRole
}

/**
 * Membership is checked before existence is admitted: a non-member gets the
 * same answer for a workspace that exists and one that does not.
 */
export async function requireMembership(
  stores: Stores,
  workspaceId: string,
  userId: string,
  permission?: Permission,
): Promise<WorkspaceAccess> {
  const member = await stores.workspaces.findMember(workspaceId, userId)
  const workspace = member ? await stores.workspaces.findById(workspaceId) : null

  if (!member || !workspace) {
    throw new AppError('not_found', { message: 'Workspace not found.' })
  }

  if (permission && !can(member.role, permission)) {
    throw new AppError('forbidden', {
      message: 'Your role in this workspace does not allow that.',
      details: { role: member.role, permission },
    })
  }

  return { workspace, role: member.role }
}

/** The owner's plan is what keeps a workspace alive. */
export async function requireWorkspaceFeature(
  stores: Stores,
  workspace: WorkspaceRecord,
  feature: 'workspaces' | 'teams' | 'auditLog',
): Promise<void> {
  const entitlement = await resolveEntitlement(stores, workspace.ownerUserId)
  if (entitlement.features[feature] !== true) {
    throw new AppError('feature_not_available', {
      message: 'This workspace needs an active Clinote Business subscription.',
      details: { feature },
    })
  }
}

/**
 * Turns an optional workspace id into the stream a sync request is about.
 *
 * No workspace id means the personal stream, which is the only stream a Pro
 * account has. A workspace id must be backed by membership *and* the right to
 * take part in sync, which a Viewer deliberately still has: reading is what a
 * viewer does, and reading requires receiving.
 */
export async function resolveSyncScope(
  stores: Stores,
  userId: string,
  workspaceId: string | null,
): Promise<SyncScope> {
  if (!workspaceId) return { userId, workspaceId: null }

  const access = await requireMembership(stores, workspaceId, userId, 'sync.participate')
  await requireWorkspaceFeature(stores, access.workspace, 'workspaces')

  return { userId, workspaceId }
}

/**
 * A write into a shared stream needs more than membership.
 *
 * A Viewer may pull every envelope and may not push a single one — the server
 * enforces that, because a modified client would otherwise simply push anyway.
 */
export async function requireWriteScope(
  stores: Stores,
  userId: string,
  workspaceId: string | null,
): Promise<SyncScope> {
  if (!workspaceId) return { userId, workspaceId: null }

  const access = await requireMembership(stores, workspaceId, userId, 'clients.write')
  await requireWorkspaceFeature(stores, access.workspace, 'workspaces')

  return { userId, workspaceId }
}
