/**
 * The scheduler (docs/notifications.md §5, product spec §76).
 *
 * Frontend timers are not a scheduling mechanism: a browser that is closed
 * delivers nothing. This runs on the server, reads what is due, and delivers it.
 *
 * A plain function over stores and senders, so it can be tested by calling it
 * with a fixed `now` instead of by waiting.
 */
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '@clinote/types'
import type { Stores } from '../storage'
import { reminderEmail, type EmailSender, type PushSender } from './senders'

export interface SchedulerDeps {
  stores: Stores
  email: EmailSender
  push: PushSender
}

export interface SchedulerResult {
  delivered: number
  skipped: number
  failed: number
  pruned: number
}

export const DUE_BATCH = 200

export async function deliverDueReminders(
  deps: SchedulerDeps,
  now: Date = new Date(),
): Promise<SchedulerResult> {
  const due = await deps.stores.reminders.listDue(now.toISOString(), DUE_BATCH)
  const result: SchedulerResult = { delivered: 0, skipped: 0, failed: 0, pruned: 0 }

  for (const reminder of due) {
    const user = await deps.stores.users.findById(reminder.userId)
    if (!user) {
      // The account is gone; the row is noise.
      await deps.stores.reminders.deleteForRefs(reminder.userId, [reminder.appointmentRef])
      result.skipped += 1
      continue
    }

    const preferences =
      (await deps.stores.notificationPreferences.find(reminder.userId)) ??
      DEFAULT_NOTIFICATION_PREFERENCES

    if (!wants(preferences, reminder.kind, reminder.channel)) {
      // Preferences changed after the row was written. Honour the newer answer.
      await deps.stores.reminders.markSent(reminder.id, now.toISOString())
      result.skipped += 1
      continue
    }

    try {
      if (reminder.channel === 'email') {
        // The server does not know how many appointments there are — it knows
        // how many reminders it is delivering for that moment.
        const count = due.filter(
          (other) =>
            other.userId === reminder.userId &&
            other.kind === reminder.kind &&
            other.channel === 'email',
        ).length
        await deps.email.send(reminderEmail(user.email, reminder.kind, count))
      } else {
        const subscriptions = await deps.stores.pushSubscriptions.listForUser(reminder.userId)
        if (subscriptions.length === 0) {
          await deps.stores.reminders.markSent(reminder.id, now.toISOString())
          result.skipped += 1
          continue
        }

        for (const subscription of subscriptions) {
          const outcome = await deps.push.send({
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            // Content-free: the device renders the sentence from its own data.
            payload: { kind: `reminder.${reminder.kind}`, ref: reminder.appointmentRef },
          })

          if (outcome === 'gone') {
            await deps.stores.pushSubscriptions.remove(subscription.endpoint)
            result.pruned += 1
          }
        }
      }

      await deps.stores.reminders.markSent(reminder.id, now.toISOString())
      result.delivered += 1
    } catch (error) {
      // A failed delivery is retried by a later run; it never becomes a crash.
      await deps.stores.reminders.markFailed(
        reminder.id,
        error instanceof Error ? error.message : 'delivery failed',
      )
      result.failed += 1
    }
  }

  return result
}

function wants(
  preferences: NotificationPreferences,
  kind: string,
  channel: 'push' | 'email',
): boolean {
  if (kind === 'tomorrow') return preferences.appointments.tomorrow[channel]
  // Both "before" offsets share a toggle pair; the finer split is a UI concern.
  return (
    preferences.appointments.twoHours[channel] || preferences.appointments.thirtyMinutes[channel]
  )
}

/**
 * Deletes backups past their retention window (docs/backup.md §6).
 *
 * Lives with the scheduler because it is the same kind of thing: work the
 * server must do whether or not anyone has the app open.
 */
export async function deleteExpiredBackups(
  deps: { stores: Stores; objects: { delete(key: string): Promise<void> } },
  now: Date = new Date(),
  limit = 100,
): Promise<{ deleted: number }> {
  const expired = await deps.stores.backups.listExpired(now.toISOString(), limit)
  let deleted = 0

  for (const backup of expired) {
    await deps.objects.delete(backup.objectKey).catch(() => undefined)
    await deps.stores.backups.delete(backup.id)
    await deps.stores.storageUsage.recalculate(backup.userId)
    deleted += 1
  }

  return { deleted }
}
