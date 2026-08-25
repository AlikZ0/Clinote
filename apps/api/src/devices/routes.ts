/**
 * Device registration (docs/api.md §4, product spec §37).
 *
 * The device id comes from the device, because the same id stamps every sync
 * envelope and hybrid clock value. The limit is enforced here, server-side:
 * the client's copy of it is only there to explain the refusal.
 */
import type { FastifyInstance } from 'fastify'
import { AppError } from '@clinote/shared'
import { registerDeviceRequestSchema } from '@clinote/types'
import type { Env } from '../env'
import { resolveDeviceLimit } from '../entitlements'
import { createRequireAuth, requireAuthContext } from '../plugins/authenticate'
import type { DeviceRecord, Stores } from '../storage'

export async function registerDeviceRoutes(
  app: FastifyInstance,
  options: { env: Env; stores: Stores },
): Promise<void> {
  const requireAuth = createRequireAuth(options.env.JWT_SECRET)
  const { stores } = options

  app.get('/api/v1/devices', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    return (await stores.devices.listForUser(userId)).map(toPublicDevice)
  })

  app.post('/api/v1/devices', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    const body = registerDeviceRequestSchema.parse(request.body)

    const existing = await stores.devices.findById(body.id)
    if (existing && existing.userId !== userId) {
      throw new AppError('forbidden', { message: 'This device belongs to another account.' })
    }

    if (!existing || existing.revokedAt) {
      const limit = await resolveDeviceLimit(stores, userId)
      const active = await stores.devices.listForUser(userId)

      if (active.length >= limit) {
        throw new AppError('device_limit_reached', {
          message:
            limit === 0
              ? 'Multiple devices are available with Clinote Pro.'
              : `You can use Clinote on ${limit} devices. Remove one to add this device.`,
          details: { limit, active: active.length },
        })
      }
    }

    const now = new Date().toISOString()
    const device = await stores.devices.upsert({
      id: body.id,
      userId,
      name: body.name,
      platform: body.platform,
      lastSeen: now,
      createdAt: existing?.createdAt ?? now,
      revokedAt: null,
    })

    reply.status(existing ? 200 : 201)
    return toPublicDevice(device)
  })

  app.delete('/api/v1/devices/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    const { id } = request.params as { id: string }

    const device = await stores.devices.findById(id)
    if (!device || device.userId !== userId) {
      throw new AppError('not_found', { message: 'That device is not on your account.' })
    }

    await stores.devices.revoke(id)
    reply.status(204)
    return null
  })
}

function toPublicDevice(device: DeviceRecord) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    lastSeen: device.lastSeen,
    createdAt: device.createdAt,
  }
}
