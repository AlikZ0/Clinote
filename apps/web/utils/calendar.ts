/**
 * Calendar arithmetic (docs/appointments.md §1, §2).
 *
 * All pure, all tested: a calendar that puts an appointment on the wrong day
 * sends a person to the clinic on the wrong day.
 *
 * Appointments are stored as a UTC instant plus the IANA zone they were booked
 * in, and they are placed and rendered in *that* zone. A practitioner who
 * travels still sees their Tuesday 14:30 appointment on Tuesday at 14:30.
 */
import type { Appointment } from '@clinote/types'

export const CALENDAR_VIEWS = ['day', 'week', 'month', 'agenda'] as const
export type CalendarView = (typeof CALENDAR_VIEWS)[number]

/** Half-open [start, end): the end instant belongs to the next range. */
export interface DateRange {
  start: Date
  end: Date
}

const DAY_MS = 86_400_000

export function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function startOfDay(date: Date): Date {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return copy
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date)
  copy.setDate(copy.getDate() + days)
  return copy
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

export function addMonths(date: Date, months: number): Date {
  const copy = new Date(date)
  const targetMonth = copy.getMonth() + months
  copy.setDate(1)
  copy.setMonth(targetMonth)
  // Clamp: 31 January + 1 month is the last day of February, not 3 March.
  const lastDay = new Date(copy.getFullYear(), copy.getMonth() + 1, 0).getDate()
  copy.setDate(Math.min(date.getDate(), lastDay))
  return copy
}

export function dayRange(date: Date): DateRange {
  const start = startOfDay(date)
  return { start, end: addDays(start, 1) }
}

/** Weeks start on Monday: this is a working calendar, not a wall calendar. */
export function weekRange(date: Date, weekStartsOn = 1): DateRange {
  const start = startOfDay(date)
  const offset = (start.getDay() - weekStartsOn + 7) % 7
  start.setDate(start.getDate() - offset)
  return { start, end: addDays(start, 7) }
}

export function monthRange(date: Date): DateRange {
  const start = new Date(date.getFullYear(), date.getMonth(), 1)
  return { start, end: new Date(date.getFullYear(), date.getMonth() + 1, 1) }
}

/** Whole weeks covering the month, so the grid is always rectangular. */
export function monthGrid(date: Date, weekStartsOn = 1): Date[] {
  const month = monthRange(date)
  const first = weekRange(month.start, weekStartsOn).start
  const cells: Date[] = []
  let cursor = first
  // Six weeks covers every possible month layout.
  while (cells.length < 42) {
    cells.push(cursor)
    cursor = addDays(cursor, 1)
    if (cells.length >= 28 && cursor >= month.end && cells.length % 7 === 0) break
  }
  return cells
}

export function rangeFor(view: CalendarView, anchor: Date, agendaDays = 30): DateRange {
  switch (view) {
    case 'day':
      return dayRange(anchor)
    case 'week':
      return weekRange(anchor)
    case 'month': {
      const grid = monthGrid(anchor)
      const first = grid[0] ?? monthRange(anchor).start
      const last = grid.at(-1) ?? monthRange(anchor).end
      return { start: first, end: addDays(last, 1) }
    }
    case 'agenda': {
      const start = startOfDay(anchor)
      return { start, end: addDays(start, agendaDays) }
    }
  }
}

export function stepRange(view: CalendarView, anchor: Date, direction: -1 | 1): Date {
  switch (view) {
    case 'day':
      return addDays(anchor, direction)
    case 'week':
      return addDays(anchor, 7 * direction)
    case 'month':
      return addMonths(anchor, direction)
    case 'agenda':
      return addDays(anchor, 30 * direction)
  }
}

/**
 * A query range must be widened before it hits the database: an appointment
 * booked in another zone can fall on a visible day while its UTC instant sits
 * outside the range.
 */
export function queryWindow(range: DateRange): { fromIso: string; toIso: string } {
  return {
    fromIso: new Date(range.start.getTime() - DAY_MS).toISOString(),
    toIso: new Date(range.end.getTime() + DAY_MS).toISOString(),
  }
}

/** `YYYY-MM-DD` in a given zone. */
export function dayKeyInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/** `YYYY-MM-DD` for a local Date, without the UTC shift `toISOString` applies. */
export function dayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function timeInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

/** The day an appointment belongs to, decided in the zone it was booked in. */
export function appointmentDayKey(appointment: Pick<Appointment, 'startAt' | 'timezone'>): string {
  return dayKeyInZone(appointment.startAt, appointment.timezone)
}

export interface DayGroup<T> {
  dayKey: string
  items: T[]
}

/** Groups by day and sorts, which is what every view renders from. */
export function groupByDay<T extends Pick<Appointment, 'startAt' | 'timezone'>>(
  appointments: readonly T[],
): DayGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const appointment of appointments) {
    const key = appointmentDayKey(appointment)
    const bucket = groups.get(key)
    if (bucket) bucket.push(appointment)
    else groups.set(key, [appointment])
  }

  return [...groups.entries()]
    .map(([key, items]) => ({
      dayKey: key,
      items: [...items].sort((a, b) => a.startAt.localeCompare(b.startAt)),
    }))
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
}

/** Keeps only what falls inside the visible days, after the widened query. */
export function withinDays<T extends Pick<Appointment, 'startAt' | 'timezone'>>(
  appointments: readonly T[],
  range: DateRange,
): T[] {
  const first = dayKey(range.start)
  const last = dayKey(addDays(range.end, -1))
  return appointments.filter((appointment) => {
    const key = appointmentDayKey(appointment)
    return key >= first && key <= last
  })
}

export function overlaps(
  a: { startAt: string; endAt: string },
  b: { startAt: string; endAt: string },
): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt
}

export function durationMinutes(startAt: string, endAt: string): number {
  return Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000)
}
