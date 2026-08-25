import { describe, expect, it } from 'vitest'
import { daysSince, formatBytes } from './format'

describe('formatBytes', () => {
  it('scales to a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })
})

describe('daysSince', () => {
  const now = new Date('2026-08-25T12:00:00.000Z')

  it('counts whole elapsed days', () => {
    expect(daysSince('2026-08-25T09:00:00.000Z', now)).toBe(0)
    expect(daysSince('2026-08-24T09:00:00.000Z', now)).toBe(1)
    expect(daysSince('2026-08-11T12:00:00.000Z', now)).toBe(14)
  })

  it('never reports a negative age for a clock that ran ahead', () => {
    expect(daysSince('2026-09-01T00:00:00.000Z', now)).toBe(0)
  })
})
