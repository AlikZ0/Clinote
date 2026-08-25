import { describe, expect, it } from 'vitest'
import { HybridClock, compareHlc, formatHlc, parseHlc } from './hlc'

const DEVICE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const DEVICE_B = 'bbbbbbbb-0000-4000-8000-000000000002'

describe('HybridClock', () => {
  it('is monotonic within the same millisecond', () => {
    const clock = new HybridClock(DEVICE_A, () => 1_000)
    const first = clock.tick()
    const second = clock.tick()
    expect(compareHlc(first, second)).toBeLessThan(0)
    expect(parseHlc(second).counter).toBe(1)
  })

  it('stays monotonic when the wall clock steps backwards', () => {
    let now = 5_000
    const clock = new HybridClock(DEVICE_A, () => now)
    const before = clock.tick()
    now = 4_000
    const after = clock.tick()
    expect(compareHlc(before, after)).toBeLessThan(0)
  })

  it('orders lexicographically the same way it orders chronologically', () => {
    const early = formatHlc({ wallMillis: 999, counter: 0, deviceId: DEVICE_A })
    const late = formatHlc({ wallMillis: 1_000, counter: 0, deviceId: DEVICE_A })
    expect(early < late).toBe(true)
    expect([late, early].sort()).toEqual([early, late])
  })

  it('advances past a received remote timestamp', () => {
    const local = new HybridClock(DEVICE_A, () => 1_000)
    const remote = new HybridClock(DEVICE_B, () => 2_000).tick()
    const merged = local.receive(remote)
    expect(compareHlc(remote, merged)).toBeLessThan(0)
    expect(compareHlc(merged, local.tick())).toBeLessThan(0)
  })

  it('rejects a remote timestamp beyond the accepted drift', () => {
    const local = new HybridClock(DEVICE_A, () => 1_000)
    const farFuture = formatHlc({
      wallMillis: 1_000 + 10 * 60 * 60 * 1000,
      counter: 0,
      deviceId: DEVICE_B,
    })
    expect(() => local.receive(farFuture)).toThrow(/drift/i)
  })

  it('round-trips a device id that contains separators', () => {
    const value = formatHlc({ wallMillis: 42, counter: 7, deviceId: 'device:with:colons' })
    expect(parseHlc(value)).toEqual({ wallMillis: 42, counter: 7, deviceId: 'device:with:colons' })
  })
})
