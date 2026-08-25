/**
 * Test factories. Each test gets its own database name so suites never observe
 * each other's rows.
 */
import { createId } from '@clinote/shared'
import type { Appointment, Client, Work } from '@clinote/types'
import { createLocalCore, type LocalCore } from '../database'
import type { Draft } from '../database/repositories/base'

export async function createTestCore(): Promise<LocalCore> {
  return createLocalCore({ name: `clinote_test_${createId()}` })
}

export function draftClient(overrides: Partial<Draft<Client>> = {}): Draft<Client> {
  return { firstName: 'Ivan', lastName: 'Petrov', arrivalDate: '2026-08-25', ...overrides }
}

export function draftWork(clientId: string, overrides: Partial<Draft<Work>> = {}): Draft<Work> {
  return {
    clientId,
    date: '2026-08-25',
    title: 'Consultation',
    description: '',
    notes: '',
    ...overrides,
  }
}

export function draftAppointment(
  clientId: string,
  overrides: Partial<Draft<Appointment>> = {},
): Draft<Appointment> {
  return {
    clientId,
    startAt: '2026-08-26T14:30:00.000Z',
    endAt: '2026-08-26T15:00:00.000Z',
    timezone: 'Asia/Yerevan',
    title: '',
    notes: '',
    status: 'scheduled',
    reminderOffsetsMinutes: [],
    ...overrides,
  }
}

/** A tiny but real Blob, so blob storage is exercised end to end. */
export function fakeImage(content = 'x-ray-bytes', type = 'image/jpeg'): Blob {
  return new Blob([content], { type })
}
