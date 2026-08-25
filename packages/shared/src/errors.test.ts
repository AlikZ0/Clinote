import { describe, expect, it } from 'vitest'
import { AppError, toAppError } from './errors'

describe('toAppError', () => {
  it('passes AppError through unchanged', () => {
    const original = new AppError('forbidden')
    expect(toAppError(original)).toBe(original)
  })

  it('translates a storage quota failure instead of leaking DOMException', () => {
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    const mapped = toAppError(quota)
    expect(mapped.code).toBe('storage_quota_exceeded')
    expect(mapped.retryable).toBe(false)
  })

  it('treats a fetch TypeError as a retryable network failure', () => {
    const mapped = toAppError(new TypeError('Failed to fetch'))
    expect(mapped.code).toBe('network_unavailable')
    expect(mapped.retryable).toBe(true)
  })

  it('never exposes internals in the serialized form', () => {
    const mapped = toAppError(new Error('connection string postgres://user:pass@host'))
    expect(Object.keys(mapped.toJSON())).toEqual(['code', 'message', 'details'])
  })
})
