import { describe, expect, it } from 'vitest'
import { emptyTally, record, resolveMerge } from './merge'

const OLDER = '000000001756108800000:00000:device-a'
const NEWER = '000000001756195200000:00000:device-b'

describe('resolveMerge', () => {
  it('inserts a record the device has never seen', () => {
    expect(resolveMerge(null, { hlc: OLDER, deletedAt: null })).toBe('insert')
    expect(resolveMerge(undefined, { hlc: OLDER, deletedAt: null })).toBe('insert')
  })

  it('takes the newer version', () => {
    expect(resolveMerge({ hlc: OLDER, deletedAt: null }, { hlc: NEWER, deletedAt: null })).toBe(
      'update',
    )
  })

  it('keeps local work that is newer than the archive', () => {
    expect(resolveMerge({ hlc: NEWER, deletedAt: null }, { hlc: OLDER, deletedAt: null })).toBe(
      'skip',
    )
  })

  it('is idempotent: importing the same archive twice changes nothing', () => {
    const same = { hlc: NEWER, deletedAt: null }
    expect(resolveMerge(same, same)).toBe('skip')
  })

  it('does not resurrect a deleted record by re-importing an older archive', () => {
    expect(
      resolveMerge(
        { hlc: NEWER, deletedAt: '2026-08-26T09:00:00.000Z' },
        { hlc: OLDER, deletedAt: null },
      ),
    ).toBe('skip')
  })

  it('applies an incoming tombstone that shares the local timestamp', () => {
    expect(
      resolveMerge(
        { hlc: NEWER, deletedAt: null },
        { hlc: NEWER, deletedAt: '2026-08-26T09:00:00.000Z' },
      ),
    ).toBe('update')
  })
})

describe('tally', () => {
  it('counts what the import did', () => {
    const tally = emptyTally()
    record(tally, 'insert')
    record(tally, 'insert')
    record(tally, 'update')
    record(tally, 'skip')
    expect(tally).toEqual({ inserted: 2, updated: 1, skipped: 1 })
  })
})
