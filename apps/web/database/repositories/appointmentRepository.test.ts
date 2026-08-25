import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalCore } from '../index'
import { createTestCore, draftAppointment, draftClient } from '../../test/factories'

let core: LocalCore
let clientId: string

beforeEach(async () => {
  core = await createTestCore()
  clientId = (await core.clients.create(draftClient())).id
})

afterEach(() => {
  core.close()
})

describe('AppointmentRepository', () => {
  it('rejects an appointment that ends before it starts', async () => {
    await expect(
      core.appointments.create(
        draftAppointment(clientId, {
          startAt: '2026-08-26T15:00:00.000Z',
          endAt: '2026-08-26T14:30:00.000Z',
        }),
      ),
    ).rejects.toThrow()
  })

  it('returns only the appointments inside a half-open range', async () => {
    await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-25T09:30:00.000Z',
        endAt: '2026-08-25T10:00:00.000Z',
        title: 'Yesterday',
      }),
    )
    await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-26T09:30:00.000Z',
        endAt: '2026-08-26T10:00:00.000Z',
        title: 'Morning',
      }),
    )
    await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-26T14:30:00.000Z',
        endAt: '2026-08-26T15:00:00.000Z',
        title: 'Afternoon',
      }),
    )
    await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-27T09:00:00.000Z',
        endAt: '2026-08-27T09:30:00.000Z',
        title: 'Tomorrow',
      }),
    )

    const day = await core.appointments.listBetween(
      '2026-08-26T00:00:00.000Z',
      '2026-08-27T00:00:00.000Z',
    )
    expect(day.map((appointment) => appointment.title)).toEqual(['Morning', 'Afternoon'])
  })

  it('excludes tombstoned appointments from the calendar', async () => {
    const cancelled = await core.appointments.create(draftAppointment(clientId))
    await core.appointments.softDelete(cancelled.id)

    const day = await core.appointments.listBetween(
      '2026-08-26T00:00:00.000Z',
      '2026-08-27T00:00:00.000Z',
    )
    expect(day).toEqual([])
  })

  it('finds the next scheduled appointment for a client', async () => {
    await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-20T10:00:00.000Z',
        endAt: '2026-08-20T10:30:00.000Z',
        title: 'Past',
      }),
    )
    await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-09-01T10:00:00.000Z',
        endAt: '2026-09-01T10:30:00.000Z',
        title: 'Later',
      }),
    )
    const next = await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-26T14:30:00.000Z',
        endAt: '2026-08-26T15:00:00.000Z',
        title: 'Next',
      }),
    )

    expect(
      await core.appointments.nextForClient(clientId, '2026-08-25T00:00:00.000Z'),
    ).toMatchObject({
      id: next.id,
    })
  })

  it('ignores cancelled appointments when looking for the next one', async () => {
    const cancelled = await core.appointments.create(draftAppointment(clientId))
    await core.appointments.update(cancelled.id, { status: 'cancelled' })

    expect(await core.appointments.nextForClient(clientId, '2026-08-25T00:00:00.000Z')).toBeNull()
  })

  it('surfaces past appointments that still need an outcome', async () => {
    const past = await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-01T10:00:00.000Z',
        endAt: '2026-08-01T10:30:00.000Z',
      }),
    )
    const done = await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-02T10:00:00.000Z',
        endAt: '2026-08-02T10:30:00.000Z',
      }),
    )
    await core.appointments.update(done.id, { status: 'completed' })

    const stale = await core.appointments.listNeedingOutcome('2026-08-25T00:00:00.000Z')
    expect(stale.map((appointment) => appointment.id)).toEqual([past.id])
  })

  it('lists a client history newest first', async () => {
    await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-01T10:00:00.000Z',
        endAt: '2026-08-01T10:30:00.000Z',
        title: 'First',
      }),
    )
    await core.appointments.create(
      draftAppointment(clientId, {
        startAt: '2026-08-09T10:00:00.000Z',
        endAt: '2026-08-09T10:30:00.000Z',
        title: 'Second',
      }),
    )

    const page = await core.appointments.listByClient(clientId)
    expect(page.items.map((appointment) => appointment.title)).toEqual(['Second', 'First'])
  })
})
