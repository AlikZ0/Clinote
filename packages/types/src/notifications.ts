/**
 * Notification contract (docs/notifications.md).
 *
 * What the server is allowed to know about a reminder: when to fire, an opaque
 * reference, and through which channel. Nothing else — and there is no field
 * here that could carry a name.
 */
import { z } from 'zod'

export const reminderKinds = ['tomorrow', 'before'] as const
export const reminderKindSchema = z.enum(reminderKinds)

export const notificationChannels = ['push', 'email'] as const
export const notificationChannelSchema = z.enum(notificationChannels)

export const reminderScheduleSchema = z.object({
  /** Opaque per-appointment id chosen by the device; never the appointment id. */
  ref: z.string().min(8).max(64),
  fireAt: z.iso.datetime(),
  kind: reminderKindSchema,
  channel: notificationChannelSchema,
})

export const putSchedulesRequestSchema = z.object({
  /** Replaces every schedule for these refs; an empty list withdraws them. */
  refs: z.array(z.string().min(8).max(64)).max(200),
  schedules: z.array(reminderScheduleSchema).max(500),
})

export const deleteSchedulesRequestSchema = z.object({
  refs: z.array(z.string().min(8).max(64)).min(1).max(200),
})

const channelToggles = z.object({ push: z.boolean(), email: z.boolean() })

export const notificationPreferencesSchema = z.object({
  appointments: z.object({
    tomorrow: channelToggles,
    twoHours: channelToggles,
    thirtyMinutes: channelToggles,
  }),
  backup: z.object({
    completed: channelToggles,
    failed: channelToggles,
  }),
  security: z.object({
    /** Transactional: always sent, and shown as such. */
    alerts: z.literal(true).default(true),
  }),
})

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  appointments: {
    tomorrow: { push: true, email: true },
    twoHours: { push: true, email: false },
    thirtyMinutes: { push: true, email: false },
  },
  backup: {
    completed: { push: false, email: false },
    failed: { push: true, email: true },
  },
  security: { alerts: true },
}

export const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(255), auth: z.string().min(1).max(255) }),
  deviceId: z.uuid().optional(),
})

export type ReminderKind = z.infer<typeof reminderKindSchema>
export type NotificationChannel = z.infer<typeof notificationChannelSchema>
export type ReminderSchedule = z.infer<typeof reminderScheduleSchema>
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>
