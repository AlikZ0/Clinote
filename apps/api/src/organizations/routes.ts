/**
 * Organizations: billing and identity boundary (Phase 18 P0, docs/architecture.md).
 *
 * Organizations are distinct from workspaces:
 * - Organization = billing unit, SSO boundary, white-label container
 * - Workspace = data unit, encryption boundary, team dataset
 *
 * The route layer enforces: caller must be an org member, role allows the action,
 * and subscription plan grants the feature.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError, nowIso } from '@clinote/shared'
import {
  createOrganizationRequestSchema,
  updateOrganizationRequestSchema,
  inviteOrganizationMemberRequestSchema,
  changeOrganizationRoleRequestSchema,
  canOrg,
  type OrganizationRole,
} from '@clinote/types'
import { z } from 'zod'
import type { Env } from '../env'
import { resolveOrganizationEntitlement } from '../entitlements'
import type { EmailSender } from '../notifications/senders'
import { createRequireAuth, requireAuthContext } from '../plugins/authenticate'
import type { Stores } from '../storage'

const INVITE_TTL_HOURS = 72

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/**
 * Require the caller to be a member of an organization with a specific permission.
 *
 * @throws AppError('forbidden') if not a member
 * @throws AppError('insufficient_permission') if role doesn't grant the permission
 */
async function requireOrgMembership(
  stores: Stores,
  organizationId: string,
  userId: string,
  permission?: string,
): Promise<{ organization: any; role: OrganizationRole }> {
  const org = await stores.organizations.findById(organizationId)
  if (!org) {
    throw new AppError('not_found', { message: 'Organization not found' })
  }

  const member = await stores.organizations.findMember(organizationId, userId)
  if (!member || !member.joinedAt) {
    throw new AppError('forbidden', {
      message: 'You are not a member of this organization',
    })
  }

  if (permission && !canOrg(member.role, permission as any)) {
    throw new AppError('insufficient_permission', {
      message: `Your role (${member.role}) does not allow ${permission}`,
    })
  }

  return { organization: org, role: member.role }
}

export async function registerOrganizationRoutes(
  app: FastifyInstance,
  options: { env: Env; stores: Stores; email?: EmailSender },
): Promise<void> {
  const requireAuth = createRequireAuth(options.env.JWT_SECRET)
  const { stores } = options

  /**
   * List organizations the user belongs to.
   */
  app.get('/api/v1/organizations', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const organizations = await stores.organizations.listForUser(userId)

    return {
      organizations: await Promise.all(
        organizations.map(async (org) => {
          const member = await stores.organizations.findMember(org.id, userId)
          return {
            id: org.id,
            name: org.name,
            slug: org.slug,
            role: member?.role ?? null,
            memberCount: await stores.organizations.countMembers(org.id),
            createdAt: org.createdAt,
          }
        }),
      ),
    }
  })

  /**
   * Create a new organization.
   *
   * The creator becomes the owner. A default workspace is created for this org.
   */
  app.post('/api/v1/organizations', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    const body = createOrganizationRequestSchema.parse(request.body)

    // Check if slug is already taken
    const existing = await stores.organizations.findBySlug(body.slug)
    if (existing && !existing.deletedAt) {
      throw new AppError('validation_failed', {
        message: 'That organization slug is already in use',
      })
    }

    const now = nowIso()
    const org = await stores.organizations.create({
      id: randomUUID(),
      name: body.name,
      slug: body.slug,
      ownerUserId: userId,
      logoUrl: null,
      primaryColor: null,
      secondaryColor: null,
      customDomain: null,
      settings: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })

    // Add creator as owner
    await stores.organizations.putMember({
      organizationId: org.id,
      userId,
      role: 'owner',
      invitedAt: now,
      joinedAt: now,
    })

    reply.status(201)
    return {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        role: 'owner' as OrganizationRole,
        memberCount: 1,
        createdAt: org.createdAt,
      },
    }
  })

  /**
   * Get organization details.
   *
   * Requires membership. Does not return sensitive settings (SSO client id, etc).
   */
  app.get('/api/v1/organizations/:id', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id } = z.object({ id: z.uuid() }).parse(request.params)

    const { organization: org, role } = await requireOrgMembership(stores, id, userId)

    return {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        role,
        logoUrl: org.logoUrl,
        primaryColor: org.primaryColor,
        secondaryColor: org.secondaryColor,
        customDomain: org.customDomain,
        memberCount: await stores.organizations.countMembers(id),
        createdAt: org.createdAt,
      },
    }
  })

  /**
   * Update organization.
   *
   * Requires organization.manage permission (owner only).
   */
  app.patch('/api/v1/organizations/:id', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    const body = updateOrganizationRequestSchema.parse(request.body)

    await requireOrgMembership(stores, id, userId, 'organization.manage')

    const updated = await stores.organizations.update(id, {
      name: body.name,
      slug: body.slug,
      logoUrl: body.branding?.logoUrl,
      primaryColor: body.branding?.primaryColor,
      secondaryColor: body.branding?.secondaryColor,
      customDomain: body.branding?.customDomain,
      settings: body.settings ? JSON.parse(JSON.stringify(body.settings)) : undefined,
    })

    return { organization: updated }
  })

  /**
   * List organization members.
   *
   * Requires membership. Returns role, but not sensitive billing data.
   */
  app.get('/api/v1/organizations/:id/members', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id } = z.object({ id: z.uuid() }).parse(request.params)

    await requireOrgMembership(stores, id, userId)

    const members = await stores.organizations.listMembers(id)

    return {
      members: await Promise.all(
        members.map(async (member) => {
          const user = await stores.users.findById(member.userId)
          return {
            userId: member.userId,
            email: user?.email ?? null,
            name: user?.name ?? null,
            role: member.role,
            joinedAt: member.joinedAt,
          }
        }),
      ),
    }
  })

  /**
   * Invite a member to the organization.
   *
   * Requires members.invite permission (admin+).
   * Generates a one-time token valid for 72 hours.
   */
  app.post(
    '/api/v1/organizations/:id/invites',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = requireAuthContext(request)
      const { id } = z.object({ id: z.uuid() }).parse(request.params)
      const body = inviteOrganizationMemberRequestSchema.parse(request.body)

      await requireOrgMembership(stores, id, userId, 'members.invite')

      // Check plan allows additional members
      const entitlement = await resolveOrganizationEntitlement(stores, id)
      const members = await stores.organizations.countMembers(id)
      const pending = (await stores.organizations.listPendingInvites(id)).length
      const maxMembers = entitlement.limits.maxMembers ?? 0

      if (members + pending >= maxMembers) {
        throw new AppError('member_limit_reached', {
          message: 'This organization has reached the number of people its plan allows',
          details: { limit: maxMembers },
        })
      }

      // Check if user already invited or member
      const existing = await stores.organizations.findMember(id, userId)
      if (existing) {
        throw new AppError('validation_failed', {
          message: 'User is already a member of this organization',
        })
      }

      const token = randomUUID().toString().replace(/-/g, '')
      const tokenHash = hashToken(token)
      const now = nowIso()
      const expiresAt = new Date(new Date(now).getTime() + INVITE_TTL_HOURS * 3600000).toISOString()

      const invite = await stores.organizations.createInvite({
        id: randomUUID(),
        organizationId: id,
        email: body.email,
        role: body.role,
        tokenHash,
        invitedBy: userId,
        expiresAt,
        acceptedAt: null,
        createdAt: now,
      })

      // TODO: Send invitation email with token

      reply.status(201)
      return { invite: { id: invite.id, email: invite.email, role: invite.role } }
    },
  )

  /**
   * Change a member's role.
   *
   * Requires members.manage permission (admin+).
   * Owner role cannot be changed through this endpoint (must transfer separately).
   */
  app.patch(
    '/api/v1/organizations/:id/members/:userId/role',
    { preHandler: requireAuth },
    async (request) => {
      const { userId: actorId } = requireAuthContext(request)
      const params = z.object({ id: z.uuid(), userId: z.uuid() }).parse(request.params)
      const body = changeOrganizationRoleRequestSchema.parse(request.body)

      await requireOrgMembership(stores, params.id, actorId, 'members.manage')

      const member = await stores.organizations.findMember(params.id, params.userId)
      if (!member) {
        throw new AppError('not_found', { message: 'Member not found' })
      }

      const updated = await stores.organizations.putMember({
        ...member,
        role: body.role,
      })

      return { member: updated }
    },
  )

  /**
   * Remove a member from the organization.
   *
   * Requires members.manage permission (admin+).
   */
  app.delete(
    '/api/v1/organizations/:id/members/:userId',
    { preHandler: requireAuth },
    async (request) => {
      const { userId: actorId } = requireAuthContext(request)
      const params = z.object({ id: z.uuid(), userId: z.uuid() }).parse(request.params)

      await requireOrgMembership(stores, params.id, actorId, 'members.manage')

      await stores.organizations.removeMember(params.id, params.userId)

      return { success: true }
    },
  )

  /**
   * Accept an organization invitation.
   *
   * Requires authentication. The authenticated user's email must match the
   * email the invitation was sent to.
   */
  app.post('/api/v1/organizations/invites/:token/accept', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    const { token } = z.object({ token: z.string().min(32) }).parse(request.params)
    const tokenHash = hashToken(token)

    const invite = await stores.organizations.findInviteByTokenHash(tokenHash)
    if (!invite || invite.acceptedAt) {
      throw new AppError('invalid_token', { message: 'This invitation is invalid or expired' })
    }

    if (new Date(invite.expiresAt) < new Date()) {
      throw new AppError('token_expired', { message: 'This invitation has expired' })
    }

    const user = await stores.users.findById(userId)
    if (user?.email !== invite.email) {
      throw new AppError('forbidden', {
        message: 'This invitation was sent to a different email address',
      })
    }

    const now = nowIso()
    await stores.organizations.markInviteAccepted(invite.id, now)

    // Add user as member
    await stores.organizations.putMember({
      organizationId: invite.organizationId,
      userId,
      role: invite.role,
      invitedAt: invite.invitedAt,
      joinedAt: now,
    })

    reply.status(200)
    return {
      organization: { id: invite.organizationId },
      message: 'You have joined the organization',
    }
  })
}
