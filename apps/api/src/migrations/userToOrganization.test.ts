/**
 * The user-to-organization migration (Phase 19 P0).
 *
 * This runs once against real accounts, so the dry-run an operator approves has
 * to be the run they get, and a single unlucky pair of addresses must not leave
 * somebody without an organization while the summary still says "complete".
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { nowIso } from '@clinote/shared'
import { resolveOrganizationEntitlement } from '../entitlements'
import type { Storage } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'
import { migrateUsersToOrganizations, verifyMigration } from './userToOrganization'

let storage: Storage

const stores = () => storage.stores

async function addUser(email: string, name: string | null = null): Promise<string> {
  const id = randomUUID()
  const now = nowIso()
  await stores().users.create({
    id,
    email,
    passwordHash: 'argon2id$not-a-real-hash',
    name,
    locale: null,
    timezone: null,
    emailVerifiedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  return id
}

async function addWorkspace(ownerUserId: string, name: string): Promise<string> {
  const id = randomUUID()
  const now = nowIso()
  await stores().workspaces.create({
    id,
    ownerUserId,
    name,
    organizationId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  await stores().workspaces.putMember({
    workspaceId: id,
    userId: ownerUserId,
    role: 'owner',
    invitedAt: now,
    joinedAt: now,
  })
  return id
}

beforeEach(async () => {
  storage = await createTestStorage()
})

afterEach(async () => {
  await storage.close()
})

afterAll(closeTestStorage)

describe('migrateUsersToOrganizations', () => {
  it('gives each account a personal organization it owns', async () => {
    const userId = await addUser('sole@example.com', 'Sole Practitioner')

    const progress = await migrateUsersToOrganizations(stores())

    expect(progress.errors).toEqual([])
    expect(progress.migratedOrganizations).toBe(1)

    const [organization] = await stores().organizations.listForUser(userId)
    expect(organization).toBeDefined()
    expect(organization!.ownerUserId).toBe(userId)

    const member = await stores().organizations.findMember(organization!.id, userId)
    expect(member?.role).toBe('owner')
    expect(member?.joinedAt).toBeTruthy()
  })

  it('links the account’s workspaces to that organization', async () => {
    const userId = await addUser('clinic@example.com')
    const first = await addWorkspace(userId, 'Front desk')
    const second = await addWorkspace(userId, 'Back office')

    const progress = await migrateUsersToOrganizations(stores())
    expect(progress.migratedWorkspaces).toBe(2)

    const [organization] = await stores().organizations.listForUser(userId)
    for (const workspaceId of [first, second]) {
      const workspace = await stores().workspaces.findById(workspaceId)
      expect(workspace?.organizationId).toBe(organization!.id)
    }
  })

  it('leaves a colleague’s workspace with its owner’s organization', async () => {
    const owner = await addUser('owner@example.com')
    const colleague = await addUser('colleague@example.com')
    const workspaceId = await addWorkspace(owner, 'Front desk')

    // The colleague can open the practice, but does not pay for it.
    const now = nowIso()
    await stores().workspaces.putMember({
      workspaceId,
      userId: colleague,
      role: 'admin',
      invitedAt: now,
      joinedAt: now,
    })

    await migrateUsersToOrganizations(stores())

    const [ownerOrg] = await stores().organizations.listForUser(owner)
    const workspace = await stores().workspaces.findById(workspaceId)
    expect(workspace?.organizationId).toBe(ownerOrg!.id)
  })

  it('moves the subscription onto the organization, and entitlements follow it', async () => {
    const userId = await addUser('paying@example.com')
    await stores().subscriptions.upsert({
      userId,
      planId: 'pro',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    })

    const progress = await migrateUsersToOrganizations(stores())
    expect(progress.migratedSubscriptions).toBe(1)

    const [organization] = await stores().organizations.listForUser(userId)
    const entitlement = await resolveOrganizationEntitlement(stores(), organization!.id)
    expect(entitlement.planId).toBe('pro')

    // One subscription, now owned by both: the organization drives entitlements
    // and the user id stays for audit. Two rows here would mean the upsert had
    // created a rival record rather than updating the account's own.
    const byOrganization = await stores().subscriptions.findByOrganizationId(organization!.id)
    const byUser = await stores().subscriptions.findByUserId(userId)
    expect(byOrganization?.id).toBe(byUser?.id)
  })

  it('gives two accounts with the same email local part distinct slugs', async () => {
    const first = await addUser('john.doe@first.example')
    const second = await addUser('john.doe@second.example')

    const progress = await migrateUsersToOrganizations(stores())

    expect(progress.errors).toEqual([])
    expect(progress.migratedOrganizations).toBe(2)

    const [one] = await stores().organizations.listForUser(first)
    const [two] = await stores().organizations.listForUser(second)
    expect(one!.slug).not.toBe(two!.slug)
    // The schema allows [a-z0-9-] only, so the dot cannot survive.
    for (const slug of [one!.slug, two!.slug]) expect(slug).toMatch(/^[a-z0-9-]+$/)
  })

  it('writes nothing in a dry run, and counts what the real run would write', async () => {
    const withSubscription = await addUser('counted@example.com')
    await addUser('uncounted@example.com')
    await addWorkspace(withSubscription, 'Front desk')
    await stores().subscriptions.upsert({
      userId: withSubscription,
      planId: 'pro',
      status: 'active',
      currentPeriodEnd: null,
    })

    const preview = await migrateUsersToOrganizations(stores(), { dryRun: true })

    expect(preview.migratedOrganizations).toBe(2)
    // Only one of the two accounts pays for anything.
    expect(preview.migratedSubscriptions).toBe(1)
    expect(preview.migratedWorkspaces).toBe(1)
    expect(await stores().organizations.listForUser(withSubscription)).toEqual([])

    const real = await migrateUsersToOrganizations(stores())
    expect(real.migratedOrganizations).toBe(preview.migratedOrganizations)
    expect(real.migratedSubscriptions).toBe(preview.migratedSubscriptions)
    expect(real.migratedWorkspaces).toBe(preview.migratedWorkspaces)
  })

  it('is safe to run twice', async () => {
    await addUser('idempotent@example.com')

    await migrateUsersToOrganizations(stores())
    const second = await migrateUsersToOrganizations(stores())

    expect(second.migratedOrganizations).toBe(0)
    expect(second.skippedUsers).toBe(1)
  })

  it('reports an incomplete migration, and a complete one', async () => {
    const userId = await addUser('checked@example.com')
    await addWorkspace(userId, 'Front desk')

    const before = await verifyMigration(stores())
    expect(before.usersWithoutOrg).toEqual([userId])
    expect(before.workspacesWithoutOrg).toBe(1)

    await migrateUsersToOrganizations(stores())

    const after = await verifyMigration(stores())
    expect(after.usersWithoutOrg).toEqual([])
    expect(after.usersWithOrg).toBe(1)
    expect(after.workspacesWithoutOrg).toBe(0)
  })
})
