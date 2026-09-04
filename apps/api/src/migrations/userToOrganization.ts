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
import { nowIso } from '@clinote/shared'
import type { Stores, UserRecord } from '../storage/ports'

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
  const users = userIds
    ? await Promise.all(userIds.map((id) => stores.users.findById(id)))
    : ((await stores.users.listAll?.()) ?? [])
  const activeUsers = users.filter((u): u is UserRecord => u !== null && !u.deletedAt)

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
        const orgSlug = await allocateOrgSlug(stores, user.email)
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
        const subscription = await stores.subscriptions.findByUserId(user.id)
        if (subscription) {
          // Same row, now naming the organization as well. user_id stays for
          // audit; the organization is what drives entitlements from here.
          await stores.subscriptions.upsert({ ...subscription, organizationId: orgId })
          progress.migratedSubscriptions++
        }

        // Link the workspaces this account owns. listForUser answers by
        // membership, so using it here handed a colleague's practice to
        // whichever member happened to be migrated last — a workspace's billing
        // owner decided by iteration order.
        for (const workspace of await ownedWorkspaces(stores, user.id)) {
          await stores.workspaces.update(workspace.id, { organizationId: orgId })
          progress.migratedWorkspaces++
        }
      } else {
        // Dry-run: count exactly what a real run would write, so the preview
        // an operator approves is the preview they get.
        progress.migratedOrganizations++
        if (await stores.subscriptions.findByUserId(user.id)) progress.migratedSubscriptions++

        progress.migratedWorkspaces += (await ownedWorkspaces(stores, user.id)).length
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
 * The workspaces an account owns, as opposed to the ones it can merely open.
 *
 * A workspace belongs to exactly one organization, and the one that pays for it
 * is its owner's — not that of every colleague invited into it.
 */
async function ownedWorkspaces(stores: Stores, userId: string) {
  const workspaces = await stores.workspaces.listForUser(userId)
  return workspaces.filter((workspace) => workspace.ownerUserId === userId)
}

/**
 * The slug an organization would like, from the owner's email.
 *
 * `organizationSchema` allows `[a-z0-9-]` only, so dots and underscores become
 * hyphens: an earlier version kept them and produced slugs its own schema
 * rejected — including the "john.doe" the documentation gave as the example.
 *
 * Examples: "john.doe@example.com" → "john-doe", "alice+tag@company.co" → "alice-tag"
 */
function baseOrgSlug(email: string): string {
  const local = email.split('@')[0] ?? email
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (base.length < 3) return `org-${base}`.replace(/-+$/, '').slice(0, 50)
  return base.slice(0, 50)
}

/**
 * Claim a slug nobody else holds.
 *
 * `organizations.slug` is UNIQUE, and two accounts at different domains share a
 * local part often enough — john@a.example and john@b.example both wanted
 * "john". The second insert failed, the user was filed under `errors` and the
 * migration still reported success. Suffix until the name is free.
 */
async function allocateOrgSlug(stores: Stores, email: string): Promise<string> {
  const base = baseOrgSlug(email)
  if (!(await stores.organizations.findBySlug(base))) return base

  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base.slice(0, 50 - String(suffix).length - 1)}-${suffix}`
    if (!(await stores.organizations.findBySlug(candidate))) return candidate
  }

  throw new Error(`Could not find a free organization slug for "${base}"`)
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
  const workspacesWithoutOrg = workspaces.filter((w) => !w || !w.organizationId).length

  return { usersWithoutOrg, usersWithOrg, workspacesWithoutOrg }
}

/**
 * Rolling the migration back is not implemented.
 *
 * It would mean deleting organizations, moving subscriptions back onto their
 * users and unlinking workspaces — destructive work whose safety depends on
 * knowing which organizations the migration itself created. Restore from the
 * dump taken before the run instead (docs/MIGRATION_USERS_TO_ORGS.md).
 *
 * This function existed as a stub that reported `rolled: 0` and read, from a
 * call site, exactly like a rollback that had found nothing to do.
 */
