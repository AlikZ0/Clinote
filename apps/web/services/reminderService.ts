/**
 * Turns an appointment's reminder choices into server-side schedule rows
 * (docs/notifications.md §1, docs/appointments.md §5).
 *
 * The server learns an instant, an opaque reference and a channel. It never
 * learns who, or what about — and this file is where that boundary is kept.
 */
import { createId } from '@clinote/shared'
import type { Appointment, NotificationPreferences, ReminderSchedule } from '@clinote/types'
import type { ApiClient } from '~/api/client'
import type { LocalCore } from '~/database'

/** An offset at least this far ahead is the "tomorrow" reminder. */
export const TOMORROW_THRESHOLD_MINUTES = 12 * 60

export function reminderRefFor(appointment: Appointment): string {
  // Deliberately not the appointment id: the two must not be correlatable.
  return appointment.reminderRef ?? `rmd_${createId().replace(/-/g, '')}`
}

/**
 * The rows one appointment implies. Pure, because getting this wrong sends a
 * notification at the wrong moment or not at all.
 */
export function computeSchedules(
  appointment: Appointment,
  preferences: NotificationPreferences,
  now: Date = new Date(),
): ReminderSchedule[] {
  if (appointment.deletedAt || appointment.status !== 'scheduled') return []

  const ref = appointment.reminderRef
  if (!ref) return []

  const start = Date.parse(appointment.startAt)
  const schedules: ReminderSchedule[] = []

  for (const offset of appointment.reminderOffsetsMinutes) {
    const fireAt = start - offset * 60_000
    // A reminder for a moment that has passed is noise, not a reminder.
    if (fireAt <= now.getTime()) continue

    const kind = offset >= TOMORROW_THRESHOLD_MINUTES ? 'tomorrow' : 'before'
    const toggles =
      kind === 'tomorrow'
        ? preferences.appointments.tomorrow
        : offset >= 60
          ? preferences.appointments.twoHours
          : preferences.appointments.thirtyMinutes

    for (const channel of ['push', 'email'] as const) {
      if (!toggles[channel]) continue
      schedules.push({ ref, fireAt: new Date(fireAt).toISOString(), kind, channel })
    }
  }

  return schedules
}

export class ReminderService {
  constructor(
    private readonly core: LocalCore,
    private readonly api: ApiClient,
  ) {}

  preferences(): Promise<NotificationPreferences> {
    return this.api.request<NotificationPreferences>('/notifications/preferences')
  }

  savePreferences(preferences: NotificationPreferences): Promise<NotificationPreferences> {
    return this.api.request<NotificationPreferences>('/notifications/preferences', {
      method: 'PUT',
      body: preferences,
    })
  }

  /**
   * Gives an appointment a reference the first time it needs one.
   *
   * Stored on the record so the id survives sync; without it two devices would
   * schedule two sets of reminders for the same appointment.
   */
  async ensureRef(appointment: Appointment): Promise<Appointment> {
    if (appointment.reminderRef || appointment.reminderOffsetsMinutes.length === 0) {
      return appointment
    }
    return this.core.appointments.update(appointment.id, {
      reminderRef: reminderRefFor(appointment),
    })
  }

  /** Publishes (or withdraws) the schedules for one appointment. */
  async publish(appointment: Appointment, preferences: NotificationPreferences): Promise<number> {
    const withRef = await this.ensureRef(appointment)
    const ref = withRef.reminderRef
    if (!ref) return 0

    const schedules = computeSchedules(withRef, preferences)
    await this.api.request('/appointments/schedules', {
      method: 'PUT',
      body: { refs: [ref], schedules },
    })
    return schedules.length
  }

  async withdraw(refs: string[]): Promise<void> {
    if (refs.length === 0) return
    await this.api.request('/appointments/schedules', { method: 'DELETE', body: { refs } })
  }

  /**
   * Re-publishes every upcoming appointment.
   *
   * Cheap and idempotent: schedules are replaced per reference, so running it
   * after a sync or a preference change simply makes the server agree with the
   * device.
   */
  async publishUpcoming(preferences: NotificationPreferences, days = 30): Promise<number> {
    const now = new Date()
    const upcoming = await this.core.appointments.listBetween(
      now.toISOString(),
      new Date(now.getTime() + days * 86_400_000).toISOString(),
    )

    let published = 0
    for (const appointment of upcoming) {
      if (appointment.reminderOffsetsMinutes.length === 0) continue
      published += await this.publish(appointment, preferences)
    }
    return published
  }
}
