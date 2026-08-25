/**
 * Sync relay (docs/sync.md §1, docs/api.md §5).
 *
 * The server orders and fans out opaque envelopes. It cannot read them, and no
 * code here tries: there is no branch on entity type, no field access, and no
 * inspection of the payload beyond its size.
 */
import type { FastifyInstance } from 'fastify'
import { AppError } from '@clinote/shared'
import { syncPushRequestSchema } from '@clinote/types'
import { z } from 'zod'
import type { Env } from '../env'
import { resolveEntitlement } from '../entitlements'
import { createRequireAuth, requireAuthContext } from '../plugins/authenticate'
import type { Stores } from '../storage'
import { resolveSyncScope, requireWriteScope } from '../workspaces/access'
import { recordSyncAudit } from '../workspaces/audit'

/** Comfortably larger than a record, far smaller than a file. */
export const MAX_PAYLOAD_BYTES = 512 * 1024
export const MAX_PULL_LIMIT = 500

const changesQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(MAX_PULL_LIMIT).default(200),
  /** Absent means the personal stream. */
  workspaceId: z.uuid().nullish(),
})

/**
 * A workspace stream is addressed by a header rather than a path, because
 * "which dataset am I talking about" is ambient for every sync call, exactly
 * like "which device".
 */
function workspaceOf(request: { headers: Record<string, unknown> }): string | null {
  const header = request.headers['x-clinote-workspace']
  return typeof header === 'string' && header.length > 0 ? header : null
}

export async function registerSyncRoutes(
  app: FastifyInstance,
  options: { env: Env; stores: Stores },
): Promise<void> {
  const requireAuth = createRequireAuth(options.env.JWT_SECRET)
  const { stores } = options

  /**
   * Cloud Sync is a paid capability, and the server is where that is decided.
   *
   * Only for a *personal* stream. A workspace stream is paid for by whoever
   * owns the workspace, which `resolveSyncScope` checks instead — an assistant
   * on the free plan still works in their clinic's records.
   */
  async function requirePersonalSync(userId: string, workspaceId: string | null): Promise<void> {
    if (workspaceId) return
    const entitlement = await resolveEntitlement(stores, userId)
    if (entitlement.features.cloudSync !== true) {
      throw new AppError('feature_not_available', {
        message: 'Cloud Sync is available with Clinote Pro.',
      })
    }
  }

  /**
   * A device may only speak for itself. Without this, one stolen token could
   * forge envelopes attributed to another device and corrupt ordering.
   */
  async function requireOwnedDevice(userId: string, deviceId: string): Promise<void> {
    const device = await stores.devices.findById(deviceId)
    if (!device || device.userId !== userId || device.revokedAt) {
      throw new AppError('forbidden', {
        message: 'This device is not registered on your account.',
      })
    }
  }

  app.post(
    '/api/v1/sync/push',
    {
      preHandler: requireAuth,
      config: {
        rateLimit: { max: options.env.NODE_ENV === 'test' ? 10_000 : 120, timeWindow: '1 minute' },
      },
    },
    async (request) => {
      const { userId } = requireAuthContext(request)
      const workspaceId = workspaceOf(request)
      await requirePersonalSync(userId, workspaceId)

      const body = syncPushRequestSchema.parse(request.body)

      const devices = new Set(body.envelopes.map((envelope) => envelope.deviceId))
      if (devices.size !== 1) {
        throw new AppError('validation_failed', {
          message: 'A push must come from a single device.',
        })
      }
      await requireOwnedDevice(userId, [...devices][0] as string)

      for (const envelope of body.envelopes) {
        // Measured, not parsed: the payload stays opaque.
        if (Buffer.byteLength(envelope.payload, 'base64') > MAX_PAYLOAD_BYTES) {
          throw new AppError('validation_failed', {
            message: 'One of the changes is too large to sync.',
            details: { entityId: envelope.entityId },
          })
        }
      }

      // Pushing into a workspace needs the right to write there; pulling only
      // needs membership. That asymmetry is what makes a Viewer a viewer.
      const scope = await requireWriteScope(stores, userId, workspaceId)

      const seq = await stores.sync.append(scope, body.envelopes)
      await recordSyncAudit(stores, request, scope, body.envelopes)

      return { accepted: Object.keys(seq), seq }
    },
  )

  app.get('/api/v1/sync/changes', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { since, limit } = changesQuerySchema.parse(request.query)
    await requirePersonalSync(userId, workspaceOf(request))
    const scope = await resolveSyncScope(stores, userId, workspaceOf(request))
    const items = await stores.sync.listSince(scope, since, limit + 1)
    const hasMore = items.length > limit
    const page = hasMore ? items.slice(0, limit) : items

    return {
      items: page.map((item) => ({
        operationId: item.operationId,
        entityType: item.entityType,
        entityId: item.entityId,
        operation: item.operation,
        hlc: item.hlc,
        baseHlc: item.baseHlc,
        deviceId: item.deviceId,
        payload: item.payload,
        seq: item.seq,
        createdAt: item.createdAt,
      })),
      nextCursor: page.at(-1)?.seq ?? null,
      hasMore,
    }
  })

  app.get('/api/v1/sync/status', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    await requirePersonalSync(userId, workspaceOf(request))

    const header = request.headers['x-clinote-device']
    const deviceId = typeof header === 'string' ? header : null
    const scope = await resolveSyncScope(stores, userId, workspaceOf(request))

    return {
      serverSeq: await stores.sync.latestSeq(scope),
      deviceCursor: deviceId ? await stores.sync.getCursor(deviceId, scope.workspaceId) : 0,
    }
  })

  app.post('/api/v1/sync/cursor', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    await requirePersonalSync(userId, workspaceOf(request))

    const body = z
      .object({ deviceId: z.uuid(), seq: z.number().int().nonnegative() })
      .parse(request.body)
    await requireOwnedDevice(userId, body.deviceId)
    const scope = await resolveSyncScope(stores, userId, workspaceOf(request))
    await stores.sync.setCursor(scope, body.deviceId, body.seq)

    reply.status(204)
    return null
  })
}
