import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFICATION_PREFERENCES, type Appointment } from '@clinote/types'
import { computeSchedules, reminderRefFor, TOMORROW_THRESHOLD_MINUTES } from './reminderService'

const NOW = new Date('2026-08-25T09:00:00.000Z')

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222',
    startAt: '2026-08-26T14:30:00.000Z',
    endAt: '2026-08-26T15:00:00.000Z',
    timezone: 'Asia/Yerevan',
    title: 'Follow-up',
    notes: 'clinical note',
    status: 'scheduled',
    reminderOffsetsMinutes: [],
    reminderRef: 'rmd_0123456789abcdef',
    createdAt: '2026-08-25T08:00:00.000Z',
    updatedAt: '2026-08-25T08:00:00.000Z',
    deletedAt: null,
    hlc: '000000001756108800000:00000:device-a',
    ...overrides,
  }
}

describe('references', () => {
  it('is not the appointment id', () => {
    const ref = reminderRefFor(appointment({ reminderRef: undefined }))
    expect(ref).not.toContain('11111111')
    expect(ref).toMatch(/^rmd_[0-9a-f]{32}$/)
  })

  it('keeps the one a record already has, so devices agree', () => {
    expect(reminderRefFor(appointment())).toBe('rmd_0123456789abcdef')
  })
})

describe('computing schedules', () => {
  it('fires each chosen offset before the appointment', () => {
    const schedules = computeSchedules(
      appointment({ reminderOffsetsMinutes: [1440, 120, 30] }),
      DEFAULT_NOTIFICATION_PREFERENCES,
      NOW,
    )

    const byKind = schedules.map((item) => `${item.kind}:${item.channel}:${item.fireAt}`)
    // 1 day before → the "tomorrow" reminder, on both channels by default.
    expect(byKind).toContain('tomorrow:push:2026-08-25T14:30:00.000Z')
    expect(byKind).toContain('tomorrow:email:2026-08-25T14:30:00.000Z')
    // 2 hours and 30 minutes before → push only, by default.
    expect(byKind).toContain('before:push:2026-08-26T12:30:00.000Z')
    expect(byKind).toContain('before:push:2026-08-26T14:00:00.000Z')
    expect(byKind.filter((item) => item.startsWith('before:email'))).toEqual([])
  })

  it('carries nothing that describes the appointment', () => {
    const schedules = computeSchedules(
      appointment({ reminderOffsetsMinutes: [120] }),
      DEFAULT_NOTIFICATION_PREFERENCES,
      NOW,
    )

    const serialized = JSON.stringify(schedules)
    expect(serialized).not.toContain('Follow-up')
    expect(serialized).not.toContain('clinical note')
    expect(serialized).not.toContain('11111111')
    expect(Object.keys(schedules[0] ?? {}).sort()).toEqual(['channel', 'fireAt', 'kind', 'ref'])
  })

  it('skips a reminder whose moment has already passed', () => {
    const schedules = computeSchedules(
      appointment({ reminderOffsetsMinutes: [1440] }),
      DEFAULT_NOTIFICATION_PREFERENCES,
      // Later than one day before the appointment.
      new Date('2026-08-26T09:00:00.000Z'),
    )
    expect(schedules).toEqual([])
  })

  it('withdraws everything for a cancelled or deleted appointment', () => {
    for (const overrides of [
      { status: 'cancelled' as const },
      { deletedAt: '2026-08-25T10:00:00.000Z' },
    ]) {
      expect(
        computeSchedules(
          appointment({ reminderOffsetsMinutes: [1440, 30], ...overrides }),
          DEFAULT_NOTIFICATION_PREFERENCES,
          NOW,
        ),
      ).toEqual([])
    }
  })

  it('produces nothing when every channel is switched off', () => {
    const silent = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      appointments: {
        tomorrow: { push: false, email: false },
        twoHours: { push: false, email: false },
        thirtyMinutes: { push: false, email: false },
      },
    }

    expect(
      computeSchedules(appointment({ reminderOffsetsMinutes: [1440, 30] }), silent, NOW),
    ).toEqual([])
  })

  it('produces nothing for an appointment that has no reference yet', () => {
    expect(
      computeSchedules(
        appointment({ reminderOffsetsMinutes: [1440], reminderRef: undefined }),
        DEFAULT_NOTIFICATION_PREFERENCES,
        NOW,
      ),
    ).toEqual([])
  })

  it('treats a half-day offset as "before", not as "tomorrow"', () => {
    const schedules = computeSchedules(
      appointment({ reminderOffsetsMinutes: [TOMORROW_THRESHOLD_MINUTES - 1] }),
      DEFAULT_NOTIFICATION_PREFERENCES,
      NOW,
    )
    expect(schedules.every((item) => item.kind === 'before')).toBe(true)
  })
})
