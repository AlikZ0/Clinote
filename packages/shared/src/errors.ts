/**
 * Error taxonomy shared by web and api.
 *
 * Users never see a raw `DOMException` / `QuotaExceededError` / `NetworkError`
 * (product spec §68). Every failure is mapped to one of these codes, and the UI
 * maps codes to human sentences.
 */

export const ERROR_CODES = [
  // transport / auth
  'unauthenticated',
  'forbidden',
  'not_found',
  'validation_failed',
  'rate_limited',
  'network_unavailable',
  'internal',
  // entitlements
  'feature_not_available',
  'device_limit_reached',
  'storage_limit_reached',
  'member_limit_reached',
  'workspace_limit_reached',
  // local core
  'storage_quota_exceeded',
  'storage_unavailable',
  'database_corrupted',
  // backup / restore
  'backup_invalid_format',
  'backup_checksum_mismatch',
  'backup_version_unsupported',
  'restore_failed',
  // crypto
  'decryption_failed',
  'key_unavailable',
  // sync
  'sync_conflict',
  // workspaces
  'invite_invalid',
  'workspace_key_unavailable',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface AppErrorOptions {
  message?: string
  details?: Record<string, unknown>
  cause?: unknown
  /** Whether retrying the same operation unchanged could succeed. */
  retryable?: boolean
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>
  readonly retryable: boolean

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(
      options.message ?? code,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'AppError'
    this.code = code
    this.details = options.details ?? {}
    this.retryable = options.retryable ?? RETRYABLE.has(code)
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details }
  }
}

const RETRYABLE = new Set<ErrorCode>([
  'network_unavailable',
  'rate_limited',
  'internal',
  'restore_failed',
])

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/**
 * Normalizes anything thrown into an AppError. Browser storage exceptions are
 * translated here so that no call site has to know about DOMException names.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value

  if (value instanceof DOMException || (value instanceof Error && value.name)) {
    switch (value.name) {
      case 'QuotaExceededError':
        return new AppError('storage_quota_exceeded', { cause: value })
      case 'InvalidStateError':
      case 'UnknownError':
        return new AppError('storage_unavailable', { cause: value })
      case 'VersionError':
        return new AppError('database_corrupted', { cause: value })
      case 'OperationError':
        return new AppError('decryption_failed', { cause: value })
      case 'TypeError':
        // fetch() rejects with a TypeError when the network is unreachable
        return new AppError('network_unavailable', { cause: value })
    }
  }

  return new AppError('internal', {
    message: value instanceof Error ? value.message : 'Unexpected error',
    cause: value,
  })
}
