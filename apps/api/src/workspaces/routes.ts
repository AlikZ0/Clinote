/**
 * Workspaces, members and the audit log (product spec §41–§44, docs/api.md §8).
 *
 * The route layer decides three things and delegates everything else: is the
 * caller a member, does their role allow this, and is the workspace's owner on
 * a plan that includes teams. The key material passing through here is opaque —
 * sealed by one device for another, verified by neither.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError, nowIso } from '@clinote/shared'
import {
  changeRoleRequestSchema,
  createWorkspaceRequestSchema,
  inviteMemberRequestSchema,
  can,
  type WorkspaceRole,
} from '@clinote/types'
import { z } from 'zod'
import type { Env } from '../env'
import { resolveEntitlement } from '../entitlements'
import type { EmailSender } from '../notifications/senders'
import { createRequireAuth, requireAuthContext } from '../plugins/authenticate'
import type { Stores } from '../storage'
import { requireMembership, requireWorkspaceFeature } from './access'
import { recordAudit } from './audit'

const INVITE_TTL_HOURS = 72
const AUDIT_PAGE_LIMIT = 100

/** Opaque to the server: whatever `sealKeyForMember` produced on a device. */
const sealedKeySchema = z.object({
  senderPublicKey: z.base64(),
  salt: z.base64(),
  iv: z.base64(),
  key: z.base64(),
})

const identitySchema = z.object({
  publicKey: z.base64(),
  wrappedPrivateKey: z.object({ iv: z.base64(), key: z.base64() }),
})

const createBodySchema = createWorkspaceRequestSchema.extend({
  /**
   * Chosen by the device, like every other id in this product.
   *
   * The workspace key has to be sealed *to* the workspace id, and sealing
   * happens on the device — so the device has to know the id before the request
   * is sent. Server-assigned ids would force a second round trip that could
   * fail halfway and leave a workspace nobody can open.
   */
  id: z.uuid(),
  /**
   * The creator's own copy of the new workspace key. Required, so that a
   * workspace can never exist in a state where nobody can read its data.
   */
  sealedKey: sealedKeySchema,
})

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  options: { env: Env; stores: Stores; email?: EmailSender },
): Promise<void> {
  const requireAuth = createRequireAuth(options.env.JWT_SECRET)
  const { stores } = options

  /** Identity keys are what makes sealing to a colleague possible at all. */
  app.put('/api/v1/users/me/identity', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const body = identitySchema.parse(request.body)

    const existing = await stores.identityKeys.find(userId)
    if (existing && existing.publicKey !== body.publicKey) {
      // Replacing a published public key would silently invalidate every
      // workspace key already sealed to it. Rotation is a deliberate,
      // re-grant-everything operation, not a side effect of a re-login.
      throw new AppError('forbidden', {
        message: 'This account already published a different identity key.',
      })
    }

    const now = nowIso()
    await stores.identityKeys.put({
      userId,
      publicKey: body.publicKey,
      wrappedPrivateKey: body.wrappedPrivateKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    return { publicKey: body.publicKey }
  })

  app.get('/api/v1/users/me/identity', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const record = await stores.identityKeys.find(userId)
    if (!record) {
      throw new AppError('key_unavailable', {
        message: 'This account has no identity key yet.',
      })
    }
    return { publicKey: record.publicKey, wrappedPrivateKey: record.wrappedPrivateKey }
  })

  app.get('/api/v1/workspaces', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const workspaces = await stores.workspaces.listForUser(userId)

    return {
      workspaces: await Promise.all(
        workspaces.map(async (workspace) => ({
          id: workspace.id,
          name: workspace.name,
          role: workspace.role,
          memberCount: await stores.workspaces.countMembers(workspace.id),
          createdAt: workspace.createdAt,
        })),
      ),
    }
  })

  app.post('/api/v1/workspaces', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    const body = createBodySchema.parse(request.body)

    const entitlement = await resolveEntitlement(stores, userId)
    if (entitlement.features.workspaces !== true) {
      throw new AppError('feature_not_available', {
        message: 'Workspaces are part of Clinote Business.',
      })
    }

    const owned = await stores.workspaces.listForUser(userId)
    const maxWorkspaces = entitlement.limits.maxWorkspaces ?? 0
    if (owned.filter((workspace) => workspace.ownerUserId === userId).length >= maxWorkspaces) {
      throw new AppError('workspace_limit_reached', {
        message: 'Your plan does not include another workspace.',
        details: { limit: maxWorkspaces },
      })
    }

    if (await stores.workspaces.findById(body.id)) {
      throw new AppError('validation_failed', { message: 'That workspace id is already in use.' })
    }

    // A workspace belongs to exactly one organization (docs/architecture.md).
    // Where the creator has a single organization — which is what the personal
    // organization each account gets makes true — that is the one paying for
    // this workspace, so link it now rather than leaving a row for a backfill
    // to find later. Choosing between several is a decision only the caller can
    // make, and needs an organizationId on the request before it can be made
    // here; until then those workspaces stay unlinked, as they were before.
    const memberOf = await stores.organizations.listForUser(userId)
    const organizationId = memberOf.length === 1 ? memberOf[0]!.id : null

    const now = nowIso()
    const workspace = await stores.workspaces.create({
      id: body.id,
      ownerUserId: userId,
      name: body.name,
      organizationId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })

    await stores.workspaces.putMember({
      workspaceId: workspace.id,
      userId,
      role: 'owner',
      invitedAt: now,
      joinedAt: now,
    })

    await stores.workspaceKeys.put({
      workspaceId: workspace.id,
      userId,
      sealedKey: body.sealedKey,
      grantedBy: userId,
      createdAt: now,
    })

    await recordAudit(stores, request, 'WORKSPACE_CREATED', {
      workspaceId: workspace.id,
      userId,
      resourceType: 'workspace',
      resourceId: workspace.id,
    })

    reply.status(201)
    return { workspace: { ...workspace, role: 'owner' as WorkspaceRole, memberCount: 1 } }
  })

  app.patch('/api/v1/workspaces/:id', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    const body = createWorkspaceRequestSchema.parse(request.body)

    await requireMembership(stores, id, userId, 'workspace.manage')
    const updated = await stores.workspaces.update(id, { name: body.name })

    await recordAudit(stores, request, 'WORKSPACE_RENAMED', {
      workspaceId: id,
      userId,
      resourceType: 'workspace',
      resourceId: id,
    })

    return { workspace: updated }
  })

  app.get('/api/v1/workspaces/:id/members', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    await requireMembership(stores, id, userId)

    const members = await stores.workspaces.listMembers(id)
    const holders = new Set(await stores.workspaceKeys.listHolders(id))

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
            /** False until somebody grants them the key; see §9 of encryption. */
            hasKey: holders.has(member.userId),
          }
        }),
      ),
    }
  })

  app.post(
    '/api/v1/workspaces/:id/invites',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = requireAuthContext(request)
      const { id } = z.object({ id: z.uuid() }).parse(request.params)
      const body = inviteMemberRequestSchema.parse(request.body)

      const access = await requireMembership(stores, id, userId, 'members.invite')
      await requireWorkspaceFeature(stores, access.workspace, 'teams')

      const entitlement = await resolveEntitlement(stores, access.workspace.ownerUserId)
      const members = await stores.workspaces.countMembers(id)
      const pending = (await stores.workspaces.listPendingInvites(id)).length
      const maxMembers = entitlement.limits.maxMembers ?? 0
      // Pending invites count: otherwise the limit is trivially exceeded by
      // inviting everyone at once and letting them accept later.
      if (members + pending >= maxMembers) {
        throw new AppError('member_limit_reached', {
          message: 'This workspace has reached the number of people its plan allows.',
          details: { limit: maxMembers },
        })
      }

      const existing = await stores.users.findByEmail(body.email)
      if (existing && (await stores.workspaces.findMember(id, existing.id))) {
        throw new AppError('validation_failed', {
          message: 'That person is already a member of this workspace.',
        })
      }

      const token = randomBytes(32).toString('base64url')
      const invite = await stores.workspaces.createInvite({
        id: randomUUID(),
        workspaceId: id,
        email: body.email,
        role: body.role,
        tokenHash: hashToken(token),
        invitedBy: userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000).toISOString(),
        acceptedAt: null,
        createdAt: nowIso(),
      })

      // The workspace name is the practice's own name, and the recipient was
      // named by a colleague. No client data goes into this message.
      await options.email?.send({
        to: body.email,
        subject: `You have been invited to ${access.workspace.name} on Clinote`,
        text: [
          `You have been invited to join the workspace "${access.workspace.name}" on Clinote.`,
          '',
          `Open Clinote and enter this invitation code: ${token}`,
          '',
          `The invitation expires in ${INVITE_TTL_HOURS} hours.`,
        ].join('\n'),
      })

      await recordAudit(stores, request, 'MEMBER_INVITED', {
        workspaceId: id,
        userId,
        resourceType: 'invite',
        resourceId: invite.id,
      })

      reply.status(201)
      return {
        invite: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
        },
        // Returned only where there is no mail server to read it from.
        token: options.env.NODE_ENV === 'production' ? undefined : token,
      }
    },
  )

  app.get('/api/v1/workspaces/:id/invites', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    await requireMembership(stores, id, userId, 'members.invite')

    return {
      invites: (await stores.workspaces.listPendingInvites(id)).map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
      })),
    }
  })

  app.delete(
    '/api/v1/workspaces/:id/invites/:inviteId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = requireAuthContext(request)
      const { id, inviteId } = z.object({ id: z.uuid(), inviteId: z.uuid() }).parse(request.params)
      await requireMembership(stores, id, userId, 'members.invite')

      await stores.workspaces.deleteInvite(inviteId)
      reply.status(204)
      return null
    },
  )

  app.post('/api/v1/workspaces/invites/accept', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const body = z.object({ token: z.string().min(20).max(200) }).parse(request.body)

    const invite = await stores.workspaces.findInviteByTokenHash(hashToken(body.token))
    if (!invite || invite.acceptedAt || Date.parse(invite.expiresAt) < Date.now()) {
      throw new AppError('invite_invalid', {
        message: 'This invitation is no longer valid. Ask for a new one.',
      })
    }

    const user = await stores.users.findById(userId)
    // Possession of the code is not enough: a forwarded invitation must not let
    // a different person into a clinic's records.
    if (!user || user.email !== invite.email) {
      throw new AppError('invite_invalid', {
        message: 'This invitation was issued to a different email address.',
      })
    }

    const workspace = await stores.workspaces.findById(invite.workspaceId)
    if (!workspace) {
      throw new AppError('invite_invalid', { message: 'That workspace no longer exists.' })
    }

    const now = nowIso()
    await stores.workspaces.putMember({
      workspaceId: invite.workspaceId,
      userId,
      role: invite.role,
      invitedAt: invite.createdAt,
      joinedAt: now,
    })
    await stores.workspaces.markInviteAccepted(invite.id, now)

    await recordAudit(stores, request, 'MEMBER_JOINED', {
      workspaceId: invite.workspaceId,
      userId,
      resourceType: 'member',
      resourceId: userId,
    })

    return {
      workspace: { id: workspace.id, name: workspace.name, role: invite.role },
      // Joining does not grant access to the data. A member who already holds
      // the workspace key has to seal a copy for this person first.
      awaitingKey: true,
    }
  })

  app.patch(
    '/api/v1/workspaces/:id/members/:memberId',
    { preHandler: requireAuth },
    async (request) => {
      const { userId } = requireAuthContext(request)
      const { id, memberId } = z.object({ id: z.uuid(), memberId: z.uuid() }).parse(request.params)
      const body = changeRoleRequestSchema.parse(request.body)

      const access = await requireMembership(stores, id, userId, 'members.manage')
      const target = await stores.workspaces.findMember(id, memberId)
      if (!target) throw new AppError('not_found', { message: 'That member was not found.' })

      // The owner's role is not an admin's to change — that is how an owner
      // would get locked out of their own practice.
      if (target.role === 'owner') {
        throw new AppError('forbidden', { message: "The owner's role cannot be changed." })
      }

      await stores.workspaces.putMember({ ...target, role: body.role })
      await recordAudit(stores, request, 'ROLE_CHANGED', {
        workspaceId: id,
        userId,
        resourceType: 'member',
        resourceId: memberId,
      })

      return { member: { userId: memberId, role: body.role }, workspace: access.workspace.id }
    },
  )

  app.delete(
    '/api/v1/workspaces/:id/members/:memberId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = requireAuthContext(request)
      const { id, memberId } = z.object({ id: z.uuid(), memberId: z.uuid() }).parse(request.params)

      // Leaving is always allowed; removing somebody else is not.
      if (memberId !== userId) await requireMembership(stores, id, userId, 'members.manage')
      const target = await stores.workspaces.findMember(id, memberId)
      if (!target) throw new AppError('not_found', { message: 'That member was not found.' })

      if (target.role === 'owner') {
        throw new AppError('forbidden', {
          message: 'The owner cannot be removed. Transfer the workspace first.',
        })
      }

      await stores.workspaces.removeMember(id, memberId)
      // Their sealed copy of the key goes with them. It does not un-tell them
      // what they already read — no system can — but it ends future access.
      await stores.workspaceKeys.revoke(id, memberId)

      await recordAudit(stores, request, 'MEMBER_REMOVED', {
        workspaceId: id,
        userId,
        resourceType: 'member',
        resourceId: memberId,
      })

      reply.status(204)
      return null
    },
  )

  /** The caller's own sealed copy of the workspace key. */
  app.get('/api/v1/workspaces/:id/key', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    await requireMembership(stores, id, userId, 'sync.participate')

    const record = await stores.workspaceKeys.find(id, userId)
    if (!record) {
      throw new AppError('workspace_key_unavailable', {
        message: 'Nobody has granted you access to this workspace’s data yet.',
      })
    }
    return { sealedKey: record.sealedKey, grantedBy: record.grantedBy }
  })

  /** Members still waiting for the key, with the public keys to seal it to. */
  app.get('/api/v1/workspaces/:id/keys/pending', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    await requireMembership(stores, id, userId, 'members.manage')

    const members = await stores.workspaces.listMembers(id)
    const holders = new Set(await stores.workspaceKeys.listHolders(id))
    const waiting = members.filter((member) => !holders.has(member.userId))
    const publicKeys = await stores.identityKeys.findPublicKeys(
      waiting.map((member) => member.userId),
    )

    return {
      pending: await Promise.all(
        waiting.map(async (member) => {
          const user = await stores.users.findById(member.userId)
          return {
            userId: member.userId,
            email: user?.email ?? null,
            role: member.role,
            // Null while that person has not set up encryption yet: there is
            // nothing to seal to, and the grant has to wait for them.
            publicKey: publicKeys[member.userId] ?? null,
          }
        }),
      ),
    }
  })

  app.put('/api/v1/workspaces/:id/keys/:memberId', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id, memberId } = z.object({ id: z.uuid(), memberId: z.uuid() }).parse(request.params)
    const body = z.object({ sealedKey: sealedKeySchema }).parse(request.body)

    const granter = await requireMembership(stores, id, userId, 'members.manage')
    // Only somebody who holds the key can pass it on. The server cannot verify
    // that the sealed blob is the *right* key — it cannot read either one — so
    // it verifies the one thing it can: that the sender plausibly had it.
    if (!(await stores.workspaceKeys.find(id, userId))) {
      throw new AppError('workspace_key_unavailable', {
        message: 'You need access to this workspace’s data before you can grant it.',
      })
    }

    const target = await stores.workspaces.findMember(id, memberId)
    if (!target) throw new AppError('not_found', { message: 'That member was not found.' })
    if (!can(granter.role, 'members.manage')) {
      throw new AppError('forbidden', { message: 'Your role cannot grant access.' })
    }

    await stores.workspaceKeys.put({
      workspaceId: id,
      userId: memberId,
      sealedKey: body.sealedKey,
      grantedBy: userId,
      createdAt: nowIso(),
    })

    return { granted: true }
  })

  app.get('/api/v1/workspaces/:id/audit', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    const query = z
      .object({
        before: z.string().max(40).optional(),
        limit: z.coerce.number().int().positive().max(AUDIT_PAGE_LIMIT).default(50),
      })
      .parse(request.query)

    const access = await requireMembership(stores, id, userId, 'audit.read')
    await requireWorkspaceFeature(stores, access.workspace, 'auditLog')

    const events = await stores.audit.listForWorkspace(id, query)
    const actors = new Map<string, string>()
    for (const event of events) {
      if (!event.userId || actors.has(event.userId)) continue
      const user = await stores.users.findById(event.userId)
      if (user) actors.set(event.userId, user.email)
    }

    return {
      events: events.map((event) => ({
        id: event.id,
        action: event.action,
        actorEmail: event.userId ? (actors.get(event.userId) ?? null) : null,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        createdAt: event.createdAt,
      })),
      nextCursor: events.at(-1)?.id ?? null,
    }
  })
}
