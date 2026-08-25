/**
 * Explicit result type for operations whose failure is an expected outcome
 * (backup upload, restore validation, sync drain) rather than a bug.
 */
import type { AppError } from './errors'
import { toAppError } from './errors'

export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export async function attempt<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (error) {
    return err(toAppError(error))
  }
}

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value
  throw result.error
}
