/**
 * Appointments — "visits" in the product spec (§13 `visitRepository`).
 *
 * The repository exists for every plan because the local core must not have a
 * paid-only shape; access is gated above it (docs/subscriptions.md §5).
 */
import type { Table } from 'dexie'
import { appointmentSchema, type Appointment, type EntityType } from '@clinote/types'
import { toAppointmentRow, uniqueKey, type AppointmentRow } from '../schema'
import { RecordRepository, type Page, type PageOptions } from './base'

const MAX_STRING_KEY = '￿'

export class AppointmentRepository extends RecordRepository<Appointment, AppointmentRow> {
  protected readonly entityType: EntityType = 'appointment'

  protected get table(): Table<AppointmentRow, string> {
    return this.db.appointments
  }

  protected parse(input: unknown): Appointment {
    return appointmentSchema.parse(input)
  }

  protected toRow(domain: Appointment): AppointmentRow {
    return toAppointmentRow(domain)
  }

  /**
   * Half-open range [fromIso, toIso) — the query behind day, week and month
   * views. Bounded by the calendar range, so it never loads the whole table.
   */
  async listBetween(fromIso: string, toIso: string): Promise<Appointment[]> {
    const rows = await this.run(() =>
      this.db.appointments
        .where('[isDeleted+startKey]')
        .between([0, fromIso], [0, toIso], true, false)
        .toArray(),
    )
    return rows.map((row) => this.fromRow(row))
  }

  async listByClient(
    clientId: string,
    options: PageOptions<AppointmentRow> = {},
  ): Promise<Page<Appointment>> {
    return this.page('[clientId+startKey]', clientId, (row) => row.startKey, {
      reverse: true,
      filter: (row) => row.isDeleted === 0,
      ...options,
    })
  }

  /** Next scheduled appointment for a client (product spec §60). */
  async nextForClient(clientId: string, fromIso: string): Promise<Appointment | null> {
    const rows = await this.run(() =>
      this.db.appointments
        .where('[clientId+startKey]')
        .between([clientId, fromIso], [clientId, MAX_STRING_KEY], true, true)
        .filter((row) => row.isDeleted === 0 && row.status === 'scheduled')
        .limit(1)
        .toArray(),
    )
    const row = rows[0]
    return row ? this.fromRow(row) : null
  }

  /**
   * Past appointments still marked `scheduled` — surfaced on the dashboard so
   * the calendar does not silently accumulate stale entries
   * (docs/appointments.md §6).
   */
  async listNeedingOutcome(nowIso: string, limit = 20): Promise<Appointment[]> {
    const rows = await this.run(() =>
      this.db.appointments
        .where('[status+startKey]')
        .between(['scheduled', ''], ['scheduled', uniqueKey(nowIso, '')], true, false)
        .filter((row) => row.isDeleted === 0)
        .limit(limit)
        .toArray(),
    )
    return rows.map((row) => this.fromRow(row))
  }

  private fromRow(row: AppointmentRow): Appointment {
    const { isDeleted: _isDeleted, startKey: _startKey, ...appointment } = row
    return appointment
  }
}
