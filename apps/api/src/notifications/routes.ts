/**
 * Reminder schedules, push subscriptions and preferences
 * (docs/api.md §7, §8).
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError } from '@clinote/shared'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  deleteSchedulesRequestSchema,
  notificationPreferencesSchema,
  pushSubscriptionSchema,
  putSchedulesRequestSchema,
} from '@clinote/types'
import { z } from 'zod'
import type { Env } from '../env'
import { resolveEntitlement } from '../entitlements'
import { createRequireAuth, requireAuthContext } from '../plugins/authenticate'
import type { Stores } from '../storage'

export async function registerNotificationRoutes(
  app: FastifyInstance,
  options: { env: Env; stores: Stores },
): Promise<void> {
  const requireAuth = createRequireAuth(options.env.JWT_SECRET)
  const { stores, env } = options

  async function requireNotifications(userId: string): Promise<void> {
    const entitlement = await resolveEntitlement(stores, userId)
    if (entitlement.features.notifications !== true) {
      throw new AppError('feature_not_available', {
        message: 'Reminders are available with Clinote Pro.',
      })
    }
  }

  app.put('/api/v1/appointments/schedules', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    await requireNotifications(userId)

    const body = putSchedulesRequestSchema.parse(request.body)
    await stores.reminders.replaceForRefs(
      userId,
      body.refs,
      body.schedules.map((schedule) => ({
        appointmentRef: schedule.ref,
        fireAt: schedule.fireAt,
        kind: schedule.kind,
        channel: schedule.channel,
      })),
    )

    reply.status(204)
    return null
  })

  app.delete(
    '/api/v1/appointments/schedules',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = requireAuthContext(request)
      await requireNotifications(userId)

      const body = deleteSchedulesRequestSchema.parse(request.body)
      await stores.reminders.deleteForRefs(userId, body.refs)

      reply.status(204)
      return null
    },
  )

  app.get('/api/v1/appointments/schedules', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    await requireNotifications(userId)

    return (await stores.reminders.listForUser(userId)).map((row) => ({
      ref: row.appointmentRef,
      fireAt: row.fireAt,
      kind: row.kind,
      channel: row.channel,
      state: row.state,
    }))
  })

  app.get('/api/v1/notifications/preferences', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    return (await stores.notificationPreferences.find(userId)) ?? DEFAULT_NOTIFICATION_PREFERENCES
  })

  app.put('/api/v1/notifications/preferences', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const preferences = notificationPreferencesSchema.parse(request.body)
    await stores.notificationPreferences.put(userId, preferences)
    return preferences
  })

  /** The device needs this to subscribe; it is public by design. */
  app.get('/api/v1/notifications/push/key', async (_request, reply) => {
    if (!env.VAPID_PUBLIC_KEY) {
      throw new AppError('feature_not_available', {
        message: 'Push notifications are not configured on this server.',
      })
    }
    reply.header('cache-control', 'public, max-age=3600')
    return { publicKey: env.VAPID_PUBLIC_KEY }
  })

  app.post(
    '/api/v1/notifications/push/subscribe',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = requireAuthContext(request)
      await requireNotifications(userId)

      const body = pushSubscriptionSchema.parse(request.body)
      await stores.pushSubscriptions.upsert({
        id: randomUUID(),
        userId,
        deviceId: body.deviceId ?? null,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        createdAt: new Date().toISOString(),
        failedAt: null,
      })

      reply.status(204)
      return null
    },
  )

  app.delete(
    '/api/v1/notifications/push/subscribe',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = requireAuthContext(request)
      const body = z.object({ endpoint: z.url() }).parse(request.body)

      const owned = await stores.pushSubscriptions.listForUser(userId)
      if (owned.some((subscription) => subscription.endpoint === body.endpoint)) {
        await stores.pushSubscriptions.remove(body.endpoint)
      }

      reply.status(204)
      return null
    },
  )
}
