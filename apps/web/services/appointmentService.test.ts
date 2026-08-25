import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '@clinote/shared'
import type { LocalCore } from '~/database'
import { createTestCore, draftClient } from '../test/factories'
import { dayRange } from '~/utils/calendar'
import { AppointmentService, canTransition } from './appointmentService'
import { ClientService } from './clientService'

let core: LocalCore
let appointments: AppointmentService
let clientId: string

beforeEach(async () => {
  core = await createTestCore()
  appointments = new AppointmentService(core)
  clientId = (await new ClientService(core).create(draftClient())).id
})

afterEach(() => {
  core.close()
})

describe('creating', () => {
  it('derives the end from the duration and records the booking timezone', async () => {
    const appointment = await appointments.create({
      clientId,
      startAt: '2026-08-26T10:30:00.000Z',
      durationMinutes: 45,
      timezone: 'Asia/Yerevan',
    })

    expect(appointment.endAt).toBe('2026-08-26T11:15:00.000Z')
    expect(appointment.timezone).toBe('Asia/Yerevan')
    expect(appointment.status).toBe('scheduled')
    expect(AppointmentService.durationOf(appointment)).toBe(45)
  })

  it('refuses a nonsensical duration or date with a readable message', async () => {
    await expect(
      appointments.create({ clientId, startAt: '2026-08-26T10:30:00.000Z', durationMinutes: 0 }),
    ).rejects.toMatchObject({ code: 'validation_failed' })

    await expect(
      appointments.create({ clientId, startAt: 'not-a-date', durationMinutes: 30 }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('keeps the reminder offsets the user chose', async () => {
    const appointment = await appointments.create({
      clientId,
      startAt: '2026-08-26T10:30:00.000Z',
      durationMinutes: 30,
      reminderOffsetsMinutes: [1440, 30],
    })
    expect(appointment.reminderOffsetsMinutes).toEqual([1440, 30])
  })
})

describe('clashes', () => {
  it('reports an overlapping appointment without refusing the booking', async () => {
    await appointments.create({
      clientId,
      startAt: '2026-08-26T10:00:00.000Z',
      durationMinutes: 60,
      title: 'Existing',
    })

    const candidate = { startAt: '2026-08-26T10:30:00.000Z', endAt: '2026-08-26T11:00:00.000Z' }
    const clashes = await appointments.findClashes(candidate)
    expect(clashes.map((item) => item.title)).toEqual(['Existing'])

    // A warning, not a block: the double booking still saves.
    const created = await appointments.create({
      clientId,
      startAt: candidate.startAt,
      durationMinutes: 30,
    })
    expect(created.id).toBeDefined()
  })

  it('ignores cancelled appointments and the one being edited', async () => {
    const existing = await appointments.create({
      clientId,
      startAt: '2026-08-26T10:00:00.000Z',
      durationMinutes: 60,
    })
    const candidate = { startAt: '2026-08-26T10:30:00.000Z', endAt: '2026-08-26T11:00:00.000Z' }

    expect(await appointments.findClashes(candidate, existing.id)).toEqual([])

    await appointments.setStatus(existing.id, 'cancelled')
    expect(await appointments.findClashes(candidate)).toEqual([])
  })

  it('does not report back-to-back appointments as a clash', async () => {
    await appointments.create({
      clientId,
      startAt: '2026-08-26T10:00:00.000Z',
      durationMinutes: 30,
    })
    const clashes = await appointments.findClashes({
      startAt: '2026-08-26T10:30:00.000Z',
      endAt: '2026-08-26T11:00:00.000Z',
    })
    expect(clashes).toEqual([])
  })
})

describe('status transitions', () => {
  it('allows an outcome to be recorded once', () => {
    expect(canTransition('scheduled', 'completed')).toBe(true)
    expect(canTransition('scheduled', 'no_show')).toBe(true)
    expect(canTransition('scheduled', 'cancelled')).toBe(true)
    expect(canTransition('completed', 'scheduled')).toBe(false)
    expect(canTransition('cancelled', 'completed')).toBe(false)
    expect(canTransition('completed', 'completed')).toBe(true)
  })

  it('refuses to rewrite what already happened', async () => {
    const appointment = await appointments.create({
      clientId,
      startAt: '2026-08-26T10:00:00.000Z',
      durationMinutes: 30,
    })
    await appointments.setStatus(appointment.id, 'completed')

    await expect(appointments.setStatus(appointment.id, 'scheduled')).rejects.toMatchObject({
      code: 'validation_failed',
    })
    expect((await appointments.get(appointment.id))?.status).toBe('completed')
  })

  it('still allows notes on a finished appointment', async () => {
    const appointment = await appointments.create({
      clientId,
      startAt: '2026-08-26T10:00:00.000Z',
      durationMinutes: 30,
    })
    await appointments.setStatus(appointment.id, 'completed')

    const updated = await appointments.update(appointment.id, { notes: 'Patient arrived late' })
    expect(updated.notes).toBe('Patient arrived late')
    expect(updated.status).toBe('completed')
  })
})

describe('calendar queries', () => {
  it('includes an appointment whose UTC instant falls outside the visible day', async () => {
    // 22:00 UTC on the 25th is 02:00 on the 26th in Yerevan.
    await appointments.create({
      clientId,
      startAt: '2026-08-25T22:00:00.000Z',
      durationMinutes: 30,
      timezone: 'Asia/Yerevan',
      title: 'Early morning',
    })

    const day = await appointments.listRange(dayRange(new Date(2026, 7, 26)))
    expect(day.map((item) => item.title)).toEqual(['Early morning'])
  })

  it('excludes an appointment that belongs to a neighbouring day', async () => {
    await appointments.create({
      clientId,
      startAt: '2026-08-27T09:00:00.000Z',
      durationMinutes: 30,
      timezone: 'Asia/Yerevan',
    })
    expect(await appointments.listRange(dayRange(new Date(2026, 7, 26)))).toEqual([])
  })

  it('lists upcoming scheduled appointments only', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    const later = new Date(Date.now() + 7_200_000).toISOString()
    await appointments.create({ clientId, startAt: soon, durationMinutes: 30, title: 'Soon' })
    const cancelled = await appointments.create({
      clientId,
      startAt: later,
      durationMinutes: 30,
      title: 'Cancelled',
    })
    await appointments.setStatus(cancelled.id, 'cancelled')

    const upcoming = await appointments.upcoming()
    expect(upcoming.map((item) => item.title)).toEqual(['Soon'])
  })

  it('surfaces past appointments that never got an outcome', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    await appointments.create({ clientId, startAt: past, durationMinutes: 30, title: 'Yesterday' })

    const stale = await appointments.needingOutcome()
    expect(stale.map((item) => item.title)).toEqual(['Yesterday'])
  })

  it('finds the next appointment for a client', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    await appointments.create({ clientId, startAt: soon, durationMinutes: 30, title: 'Next' })
    expect((await appointments.nextForClient(clientId))?.title).toBe('Next')
  })
})

describe('rescheduling', () => {
  it('moves both ends together', async () => {
    const appointment = await appointments.create({
      clientId,
      startAt: '2026-08-26T10:00:00.000Z',
      durationMinutes: 30,
    })

    const moved = await appointments.reschedule(appointment.id, {
      startAt: '2026-08-27T14:00:00.000Z',
      durationMinutes: 60,
    })

    expect(moved.startAt).toBe('2026-08-27T14:00:00.000Z')
    expect(moved.endAt).toBe('2026-08-27T15:00:00.000Z')
    expect(moved.hlc > appointment.hlc).toBe(true)
  })
})
