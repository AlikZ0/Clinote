/**
 * Appointment use cases (docs/appointments.md).
 *
 * Pro and Business only as a product matter; the local core is plan-agnostic
 * and access is gated above this layer (docs/subscriptions.md §5). Nothing here
 * grants capability — it would be the wrong place, because the server is the
 * authority once accounts exist.
 */
import { AppError } from '@clinote/shared'
import type { Appointment, AppointmentStatus } from '@clinote/types'
import type { LocalCore } from '~/database'
import type { Page, PageOptions } from '~/database/repositories/base'
import {
  addMinutes,
  deviceTimezone,
  durationMinutes,
  overlaps,
  queryWindow,
  withinDays,
  type DateRange,
} from '~/utils/calendar'

export const DURATION_PRESETS = [15, 30, 45, 60, 90] as const

/** Reminder offsets the product promises (§20, §21). */
export const REMINDER_OFFSETS = [
  { minutes: 24 * 60, label: '1 day before' },
  { minutes: 2 * 60, label: '2 hours before' },
  { minutes: 30, label: '30 minutes before' },
] as const

export interface CreateAppointmentInput {
  clientId: string
  /** Instant the appointment starts. */
  startAt: string
  durationMinutes: number
  timezone?: string
  title?: string
  notes?: string
  reminderOffsetsMinutes?: number[]
}

export interface RescheduleInput {
  startAt: string
  durationMinutes: number
  timezone?: string
}

/**
 * A finished appointment is a record of what happened; only its notes stay
 * editable (docs/appointments.md §6).
 */
export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  if (from === to) return true
  return from === 'scheduled'
}

export class AppointmentService {
  constructor(private readonly core: LocalCore) {}

  /** Everything visible in a calendar range, placed by its own timezone. */
  async listRange(range: DateRange): Promise<Appointment[]> {
    const window = queryWindow(range)
    const rows = await this.core.appointments.listBetween(window.fromIso, window.toIso)
    return withinDays(rows, range)
  }

  listByClient(clientId: string, options: PageOptions = {}): Promise<Page<Appointment>> {
    return this.core.appointments.listByClient(clientId, options)
  }

  get(id: string): Promise<Appointment | null> {
    return this.core.appointments.getById(id)
  }

  nextForClient(clientId: string, from: Date = new Date()): Promise<Appointment | null> {
    return this.core.appointments.nextForClient(clientId, from.toISOString())
  }

  /** Past appointments still marked scheduled — the dashboard nags about these. */
  needingOutcome(now: Date = new Date()): Promise<Appointment[]> {
    return this.core.appointments.listNeedingOutcome(now.toISOString())
  }

  async upcoming(from: Date = new Date(), days = 14, limit = 10): Promise<Appointment[]> {
    const to = new Date(from.getTime() + days * 86_400_000)
    const rows = await this.core.appointments.listBetween(from.toISOString(), to.toISOString())
    return rows.filter((row) => row.status === 'scheduled').slice(0, limit)
  }

  async create(input: CreateAppointmentInput): Promise<Appointment> {
    const startAt = new Date(input.startAt)
    if (Number.isNaN(startAt.getTime())) {
      throw new AppError('validation_failed', { message: 'Choose a valid date and time.' })
    }
    if (input.durationMinutes <= 0) {
      throw new AppError('validation_failed', { message: 'Choose how long the appointment lasts.' })
    }

    return this.core.appointments.create({
      clientId: input.clientId,
      startAt: startAt.toISOString(),
      endAt: addMinutes(startAt, input.durationMinutes).toISOString(),
      timezone: input.timezone ?? deviceTimezone(),
      title: input.title ?? '',
      notes: input.notes ?? '',
      status: 'scheduled',
      reminderOffsetsMinutes: input.reminderOffsetsMinutes ?? [],
    })
  }

  async reschedule(id: string, input: RescheduleInput): Promise<Appointment> {
    const startAt = new Date(input.startAt)
    const patch: Record<string, unknown> = {
      startAt: startAt.toISOString(),
      endAt: addMinutes(startAt, input.durationMinutes).toISOString(),
    }
    if (input.timezone) patch.timezone = input.timezone
    return this.core.appointments.update(id, patch)
  }

  async setStatus(id: string, status: AppointmentStatus): Promise<Appointment> {
    const current = await this.core.appointments.getById(id)
    if (!current) {
      throw new AppError('not_found', { message: 'This appointment is no longer on this device.' })
    }
    if (!canTransition(current.status, status)) {
      throw new AppError('validation_failed', {
        message: 'This appointment is already finished and cannot be changed.',
        details: { from: current.status, to: status },
      })
    }
    return this.core.appointments.update(id, { status })
  }

  update(id: string, patch: { title?: string; notes?: string; reminderOffsetsMinutes?: number[] }) {
    return this.core.appointments.update(id, patch)
  }

  remove(id: string): Promise<Appointment> {
    return this.core.appointments.softDelete(id)
  }

  /**
   * Clashes are a warning, never a block: double-booking is sometimes
   * deliberate in a real practice (docs/appointments.md §3).
   */
  async findClashes(
    candidate: { startAt: string; endAt: string },
    ignoreId?: string,
  ): Promise<Appointment[]> {
    const from = new Date(Date.parse(candidate.startAt) - 86_400_000).toISOString()
    const to = new Date(Date.parse(candidate.endAt) + 86_400_000).toISOString()
    const rows = await this.core.appointments.listBetween(from, to)
    return rows.filter(
      (row) => row.id !== ignoreId && row.status === 'scheduled' && overlaps(candidate, row),
    )
  }

  static durationOf(appointment: Appointment): number {
    return durationMinutes(appointment.startAt, appointment.endAt)
  }
}
