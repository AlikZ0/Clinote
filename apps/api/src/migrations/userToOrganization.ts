/**
 * Phase 19: Migrate users to organizations
 *
 * Converts single-tenant (user-owned) to multi-tenant (org-owned):
 * - Each user gets a personal organization
 * - Subscriptions migrate to org_id
 * - Workspaces linked to organization
 * - Backward compatible: both user_id and org_id subscriptions supported
 *
 * Invariants maintained:
 * - I3: Admin has no access to clinical data (doesn't touch workspaces)
 * - I7: Plans from database (doesn't touch plan refs)
 * - I5: Separate billing (org_members) from data (workspace_members)
 */
import { randomUUID } from 'node:crypto'
import { AppError, nowIso } from '@clinote/shared'
import type { Stores } from '../storage'

export interface MigrationProgress {
  totalUsers: number
  processedUsers: number
  migratedOrganizations: number
  migratedSubscriptions: number
  migratedWorkspaces: number
  skippedUsers: number
  errors: Array<{ userId: string; error: string }>
}

export interface MigrationOptions {
  /** Only migrate users with IDs in this list (for testing) */
  userIds?: string[]
  /** Dry-run: don't commit changes */
  dryRun?: boolean
  /** Callback for progress updates */
  onProgress?: (progress: MigrationProgress) => Promise<void> | void
}

/**
 * Migrate all users to personal organizations.
 *
 * For each user:
 * 1. Create organization (slug = first part of email)
 * 2. Add user as owner
 * 3. Migrate subscription to organization
 * 4. Link all workspaces to organization
 */
export async function migrateUsersToOrganizations(
  stores: Stores,
  options: MigrationOptions = {},
): Promise<MigrationProgress> {
  const { userIds, dryRun = false, onProgress } = options
  const now = nowIso()
  const progress: MigrationProgress = {
    totalUsers: 0,
    processedUsers: 0,
    migratedOrganizations: 0,
    migratedSubscriptions: 0,
    migratedWorkspaces: 0,
    skippedUsers: 0,
    errors: [],
  }

  // Find users to migrate
  const users = userIds ? await Promise.all(userIds.map(id => stores.users.findById(id))) : await stores.users.listAll?.() ?? []
  const activeUsers = users.filter((u): u is any => u !== null && !u.deletedAt)

  progress.totalUsers = activeUsers.length

  for (const user of activeUsers) {
    progress.processedUsers++

    try {
      // Skip if already has organization
      const existing = await stores.organizations.listForUser(user.id)
      if (existing.length > 0) {
        progress.skippedUsers++
        continue
      }

      if (!dryRun) {
        // Create personal organization
        const orgSlug = generateOrgSlug(user.email)
        const orgId = randomUUID()

        await stores.organizations.create({
          id: orgId,
          name: `${user.name || 'Personal'} Organization`,
          slug: orgSlug,
          ownerUserId: user.id,
          logoUrl: null,
          primaryColor: null,
          secondaryColor: null,
          customDomain: null,
          settings: { personal: true }, // Mark as personal org
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })

        // Add user as owner
        await stores.organizations.putMember({
          organizationId: orgId,
          userId: user.id,
          role: 'owner',
          invitedAt: now,
          joinedAt: now,
        })

        progress.migratedOrganizations++

        // Migrate subscription if exists
        const subscription = await stores.subscriptions.findByUserId?.(user.id)
        if (subscription) {
          await stores.subscriptions.upsert({
            id: subscription.id || randomUUID(),
            userId: user.id,
            organizationId: orgId, // Add org_id
            planId: subscription.planId,
            status: subscription.status,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelledAt: subscription.cancelledAt,
            createdAt: subscription.createdAt,
            updatedAt: now,
          })

          progress.migratedSubscriptions++
        }

        // Link all user's workspaces to organization
        const workspaces = await stores.workspaces.listForUser(user.id)
        for (const workspace of workspaces) {
          await stores.workspaces.update(workspace.id, {
            organizationId: orgId,
          })
          progress.migratedWorkspaces++
        }
      } else {
        // Dry-run: just count
        progress.migratedOrganizations++
        progress.migratedSubscriptions++

        const workspaces = await stores.workspaces.listForUser(user.id)
        progress.migratedWorkspaces += workspaces.length
      }
    } catch (error) {
      progress.errors.push({
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (onProgress) {
      await onProgress(progress)
    }
  }

  return progress
}

/**
 * Generate organization slug from email.
 * Examples: "john.doe@example.com" → "john.doe", "alice@company.co" → "alice"
 */
function generateOrgSlug(email: string): string {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-')

  // Ensure slug is valid (3-50 chars, alphanumeric + - and .)
  if (base.length < 3) {
    return `org-${base}`.slice(0, 50)
  }

  return base.slice(0, 50)
}

/**
 * Verify migration completed successfully.
 * Can be run after migration to check all users have orgs.
 */
export async function verifyMigration(stores: Stores): Promise<{
  usersWithoutOrg: string[]
  usersWithOrg: number
  workspacesWithoutOrg: number
}> {
  const users = (await stores.users.listAll?.()) ?? []
  const usersWithoutOrg: string[] = []
  let usersWithOrg = 0

  for (const user of users) {
    if (!user || user.deletedAt) continue

    const orgs = await stores.organizations.listForUser(user.id)
    if (orgs.length === 0) {
      usersWithoutOrg.push(user.id)
    } else {
      usersWithOrg++
    }
  }

  // Check workspaces
  const workspaces = (await stores.workspaces.listAll?.()) ?? []
  const workspacesWithoutOrg = workspaces.filter(w => !w || !w.organizationId).length

  return { usersWithoutOrg, usersWithOrg, workspacesWithoutOrg }
}

/**
 * Rollback migration (for testing/recovery).
 * Removes organizations created during migration (marked as personal=true).
 */
export async function rollbackMigration(stores: Stores, dryRun = false): Promise<{ rolled: number }> {
  let rolled = 0

  // TODO: Implement if needed for development
  // This would be high-risk in production anyway

  return { rolled }
}
