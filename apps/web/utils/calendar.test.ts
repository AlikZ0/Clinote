import { describe, expect, it } from 'vitest'
import {
  addMonths,
  appointmentDayKey,
  dayKey,
  dayRange,
  durationMinutes,
  groupByDay,
  monthGrid,
  monthRange,
  overlaps,
  queryWindow,
  rangeFor,
  stepRange,
  timeInZone,
  weekRange,
  withinDays,
} from './calendar'

function at(iso: string, timezone = 'Asia/Yerevan') {
  return { startAt: iso, endAt: iso, timezone }
}

describe('ranges', () => {
  it('covers a whole day, half-open', () => {
    const range = dayRange(new Date(2026, 7, 26, 15, 30))
    expect(dayKey(range.start)).toBe('2026-08-26')
    expect(range.start.getHours()).toBe(0)
    expect(dayKey(range.end)).toBe('2026-08-27')
  })

  it('starts the week on Monday', () => {
    // 2026-08-26 is a Wednesday.
    const range = weekRange(new Date(2026, 7, 26))
    expect(dayKey(range.start)).toBe('2026-08-24')
    expect(dayKey(range.end)).toBe('2026-08-31')
  })

  it('treats Sunday as the end of the week, not the start', () => {
    const range = weekRange(new Date(2026, 7, 30)) // Sunday
    expect(dayKey(range.start)).toBe('2026-08-24')
  })

  it('bounds a month exactly', () => {
    const range = monthRange(new Date(2026, 1, 14))
    expect(dayKey(range.start)).toBe('2026-02-01')
    expect(dayKey(range.end)).toBe('2026-03-01')
  })
})

describe('month grid', () => {
  it('is rectangular and starts on a Monday', () => {
    const grid = monthGrid(new Date(2026, 7, 15))
    expect(grid.length % 7).toBe(0)
    expect(grid[0]?.getDay()).toBe(1)
    expect(grid.map(dayKey)).toContain('2026-08-01')
    expect(grid.map(dayKey)).toContain('2026-08-31')
  })

  it('covers February in a non-leap year without a stray week', () => {
    const grid = monthGrid(new Date(2026, 1, 1))
    expect(grid.map(dayKey)).toContain('2026-02-28')
    expect(grid.length).toBeLessThanOrEqual(42)
  })
})

describe('month stepping', () => {
  it('does not skip a month when the day does not exist in the next one', () => {
    expect(dayKey(addMonths(new Date(2026, 0, 31), 1))).toBe('2026-02-28')
    expect(dayKey(addMonths(new Date(2026, 2, 31), -1))).toBe('2026-02-28')
  })

  it('moves by the unit the view shows', () => {
    const anchor = new Date(2026, 7, 26)
    expect(dayKey(stepRange('day', anchor, 1))).toBe('2026-08-27')
    expect(dayKey(stepRange('week', anchor, 1))).toBe('2026-09-02')
    expect(dayKey(stepRange('month', anchor, -1))).toBe('2026-07-26')
  })
})

describe('timezone placement', () => {
  it('places an appointment on the day it has in its own zone', () => {
    // 22:00 UTC is already the next day in Yerevan (UTC+4).
    expect(appointmentDayKey(at('2026-08-25T22:00:00.000Z'))).toBe('2026-08-26')
    expect(appointmentDayKey(at('2026-08-25T22:00:00.000Z', 'UTC'))).toBe('2026-08-25')
  })

  it('renders the time the appointment was booked at, wherever the device is', () => {
    expect(timeInZone('2026-08-26T10:30:00.000Z', 'Asia/Yerevan')).toBe('14:30')
    expect(timeInZone('2026-08-26T10:30:00.000Z', 'UTC')).toBe('10:30')
    expect(timeInZone('2026-08-26T10:30:00.000Z', 'America/New_York')).toBe('06:30')
  })

  it('widens the database query so a foreign-zone appointment is not missed', () => {
    const range = dayRange(new Date(2026, 7, 26))
    const window = queryWindow(range)
    expect(Date.parse(window.fromIso)).toBeLessThan(range.start.getTime())
    expect(Date.parse(window.toIso)).toBeGreaterThan(range.end.getTime())
  })

  it('filters the widened result back to the visible days', () => {
    const range = dayRange(new Date(2026, 7, 26))
    const inside = at('2026-08-26T06:00:00.000Z')
    const before = at('2026-08-24T06:00:00.000Z')
    const after = at('2026-08-28T06:00:00.000Z')

    expect(withinDays([inside, before, after], range)).toEqual([inside])
  })
})

describe('grouping', () => {
  it('groups by day and orders within the day', () => {
    const groups = groupByDay([
      at('2026-08-26T10:30:00.000Z'),
      at('2026-08-26T05:30:00.000Z'),
      at('2026-08-27T05:30:00.000Z'),
    ])

    expect(groups.map((group) => group.dayKey)).toEqual(['2026-08-26', '2026-08-27'])
    expect(groups[0]?.items.map((item) => item.startAt)).toEqual([
      '2026-08-26T05:30:00.000Z',
      '2026-08-26T10:30:00.000Z',
    ])
  })
})

describe('overlap', () => {
  const slot = { startAt: '2026-08-26T10:00:00.000Z', endAt: '2026-08-26T10:30:00.000Z' }

  it('detects a real clash', () => {
    expect(
      overlaps(slot, { startAt: '2026-08-26T10:15:00.000Z', endAt: '2026-08-26T10:45:00.000Z' }),
    ).toBe(true)
    expect(
      overlaps(slot, { startAt: '2026-08-26T09:45:00.000Z', endAt: '2026-08-26T11:00:00.000Z' }),
    ).toBe(true)
  })

  it('does not treat touching slots as a clash', () => {
    expect(
      overlaps(slot, { startAt: '2026-08-26T10:30:00.000Z', endAt: '2026-08-26T11:00:00.000Z' }),
    ).toBe(false)
    expect(
      overlaps(slot, { startAt: '2026-08-26T09:30:00.000Z', endAt: '2026-08-26T10:00:00.000Z' }),
    ).toBe(false)
  })
})

describe('duration', () => {
  it('is derived from the two instants', () => {
    expect(durationMinutes('2026-08-26T10:00:00.000Z', '2026-08-26T10:45:00.000Z')).toBe(45)
  })
})

describe('rangeFor', () => {
  it('gives each view the window it renders', () => {
    const anchor = new Date(2026, 7, 26)
    expect(dayKey(rangeFor('day', anchor).start)).toBe('2026-08-26')
    expect(dayKey(rangeFor('week', anchor).start)).toBe('2026-08-24')
    expect(dayKey(rangeFor('agenda', anchor).start)).toBe('2026-08-26')
    expect(rangeFor('month', anchor).start.getDay()).toBe(1)
  })
})
