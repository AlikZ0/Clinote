/**
 * Key hierarchy (docs/encryption.md §3).
 *
 *   passphrase --PBKDF2--> KEK  --AES-GCM wrap--> DEK (per backup / per account)
 *
 * The server only ever stores the KDF parameters and the *wrapped* DEKs.
 */
import { fromBase64, randomBytes, toBase64, utf8, webcrypto } from './primitives'

export const KDF_PBKDF2_SHA256 = 'pbkdf2-sha256' as const
export type KdfId = typeof KDF_PBKDF2_SHA256

/** OWASP guidance for PBKDF2-HMAC-SHA-256 at the time of writing. */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000
export const SALT_BYTES = 16
export const KEY_BYTES = 32

export interface KdfParams {
  kdf: KdfId
  /** base64 */
  salt: string
  iterations: number
}

export function createKdfParams(iterations = DEFAULT_PBKDF2_ITERATIONS): KdfParams {
  return { kdf: KDF_PBKDF2_SHA256, salt: toBase64(randomBytes(SALT_BYTES)), iterations }
}

/**
 * Derives the key-encryption key. The result is non-extractable: it can wrap
 * and unwrap, but application code can never read its bytes.
 */
export async function deriveKek(passphrase: string, params: KdfParams): Promise<CryptoKey> {
  if (params.kdf !== KDF_PBKDF2_SHA256) {
    throw new Error(`Unsupported KDF: ${params.kdf}`)
  }
  if (params.iterations < 100_000) {
    throw new Error('Refusing to derive a key with too few PBKDF2 iterations')
  }
  const subtle = webcrypto().subtle
  const material = await subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(params.salt),
      iterations: params.iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

/**
 * A fresh data-encryption key. Extractable only so that it can be wrapped.
 *
 * It can also wrap: per-backup keys are wrapped with the account data key
 * rather than with the passphrase-derived KEK, so that changing the passphrase
 * does not strand existing backups (docs/encryption.md §7).
 */
export async function generateDataKey(): Promise<CryptoKey> {
  return webcrypto().subtle.generateKey({ name: 'AES-GCM', length: KEY_BYTES * 8 }, true, [
    'encrypt',
    'decrypt',
    'wrapKey',
    'unwrapKey',
  ])
}

export interface WrappedKey {
  /** base64 */
  iv: string
  /** base64 */
  key: string
}

export async function wrapDataKey(dek: CryptoKey, kek: CryptoKey): Promise<WrappedKey> {
  const iv = randomBytes(12)
  const wrapped = await webcrypto().subtle.wrapKey('raw', dek, kek, {
    name: 'AES-GCM',
    iv: iv,
  })
  return { iv: toBase64(iv), key: toBase64(new Uint8Array(wrapped)) }
}

export async function unwrapDataKey(wrapped: WrappedKey, kek: CryptoKey): Promise<CryptoKey> {
  return webcrypto().subtle.unwrapKey(
    'raw',
    fromBase64(wrapped.key),
    kek,
    { name: 'AES-GCM', iv: fromBase64(wrapped.iv) },
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    // Never extractable: once unwrapped, the bytes stay inside the browser.
    false,
    // The same usages `generateDataKey` grants. An account key that came back
    // through an unwrap must be able to do everything the original could —
    // including unwrapping per-backup keys, which is how an old backup stays
    // readable on a new device or after a passphrase change.
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  )
}

/**
 * Recovery key: 32 random bytes shown to the user once (docs/encryption.md §6).
 * Base32 without padding, grouped, so it can be written down and read back.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const RECOVERY_KEY_BYTES = 32

export function generateRecoveryKey(): string {
  const bytes = randomBytes(RECOVERY_KEY_BYTES)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return (out.match(/.{1,4}/g) ?? []).join('-')
}

export function normalizeRecoveryKey(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase()
}

/**
 * The second wrapper for the same data keys (docs/encryption.md §3).
 *
 * HKDF rather than PBKDF2: a recovery key is 256 bits of machine-generated
 * entropy, so there is nothing to slow an attacker down against — stretching it
 * would only cost the user time when they are already having a bad day.
 */
export async function deriveRecoveryKek(
  recoveryKey: string,
  params: KdfParams,
): Promise<CryptoKey> {
  const normalized = normalizeRecoveryKey(recoveryKey)
  if (normalized.length < 16) {
    throw new Error('Recovery key is too short to be valid')
  }

  const subtle = webcrypto().subtle
  const material = await subtle.importKey('raw', utf8(normalized), 'HKDF', false, ['deriveKey'])

  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: fromBase64(params.salt),
      info: utf8('clinote-recovery-kek-v1'),
    },
    material,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}
