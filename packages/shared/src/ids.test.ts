import { describe, expect, it } from 'vitest'
import { createId, isId } from './ids'

describe('ids', () => {
  it('creates unique v4 uuids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createId()))
    expect(ids.size).toBe(500)
    for (const id of ids) expect(isId(id)).toBe(true)
  })

  it('rejects non-uuid values', () => {
    expect(isId('client-1')).toBe(false)
    expect(isId(42)).toBe(false)
  })
})
