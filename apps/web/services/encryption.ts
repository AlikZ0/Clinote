/**
 * The data key that protects everything leaving this device
 * (docs/encryption.md §3).
 *
 *   passphrase --PBKDF2--> KEK --AES-GCM wrap--> DEK_sync
 *
 * The server stores the KDF parameters and the wrapped key; it can never
 * unwrap them. Without the passphrase, this device can push nothing and read
 * nothing — which is the point, and why "locked" is a first-class state rather
 * than an error.
 */
import {
  createKdfParams,
  decryptEnvelope,
  deriveKek,
  deriveRecoveryKek,
  generateRecoveryKey,
  encryptEnvelope,
  fromBase64,
  generateDataKey,
  randomBytes,
  toBase64,
  unwrapDataKey,
  utf8,
  wrapDataKey,
  generateIdentityKeyPair,
  unwrapIdentityPrivateKey,
  wrapIdentityPrivateKey,
  type Bytes,
  type IdentityKeyPair,
  type KdfParams,
  type WrappedKey,
} from '@clinote/crypto'
import { AppError } from '@clinote/shared'

/** Seals and opens payloads. The sync engine depends on this, not on key management. */
export interface EnvelopeCipher {
  seal(plaintext: Bytes): Promise<Bytes>
  open(ciphertext: Bytes): Promise<Bytes>
}

export interface StoredKeyMaterial extends KdfParams {
  wrappedDekSync: WrappedKey
  wrappedDekRecovery: WrappedKey | null
}

export class DataKeyCipher implements EnvelopeCipher {
  constructor(
    private readonly key: CryptoKey,
    private readonly keyId: Bytes,
  ) {}

  seal(plaintext: Bytes): Promise<Bytes> {
    return encryptEnvelope(plaintext, this.key, this.keyId)
  }

  async open(ciphertext: Bytes): Promise<Bytes> {
    try {
      return await decryptEnvelope(ciphertext, this.key)
    } catch (cause) {
      // A payload we cannot open is not a crash: it is a change made with a
      // different key, and the user needs to be told that plainly.
      throw new AppError('decryption_failed', {
        message: 'A change could not be read with this passphrase.',
        cause,
      })
    }
  }
}

/** Derived from the wrapped key so every device agrees on it without sharing it. */
export async function keyIdFor(material: StoredKeyMaterial): Promise<Bytes> {
  const { sha256 } = await import('@clinote/crypto')
  return (await sha256(utf8(material.wrappedDekSync.key))).slice(0, 16) as Bytes
}

/**
 * First-time setup: a fresh data key, wrapped with the passphrase.
 *
 * Returns what to store server-side. The data key itself never leaves memory.
 */
export async function createKeyMaterial(passphrase: string): Promise<{
  material: StoredKeyMaterial
  cipher: EnvelopeCipher
  dek: CryptoKey
  kek: CryptoKey
  /** Shown once and never stored anywhere (docs/encryption.md §6). */
  recoveryKey: string
}> {
  const params = createKdfParams()
  const kek = await deriveKek(passphrase, params)
  const dek = await generateDataKey()

  // Two wrappers for one key: forgetting the passphrase must be survivable,
  // and neither wrapper is readable by the server.
  const recoveryKey = generateRecoveryKey()
  const wrappedDekSync = await wrapDataKey(dek, kek)
  const wrappedDekRecovery = await wrapDataKey(dek, await deriveRecoveryKek(recoveryKey, params))

  const material: StoredKeyMaterial = { ...params, wrappedDekSync, wrappedDekRecovery }
  return {
    material,
    cipher: new DataKeyCipher(dek, await keyIdFor(material)),
    dek,
    kek,
    recoveryKey,
  }
}

/**
 * Unlocks with the recovery key when the passphrase is gone.
 *
 * This does not reveal or reset the passphrase — nothing can, because nothing
 * stores it. It gets the data keys back; choosing a new passphrase is the
 * separate step below.
 */
export async function unlockWithRecoveryKey(
  recoveryKey: string,
  material: StoredKeyMaterial,
): Promise<{ cipher: EnvelopeCipher; dek: CryptoKey; kek: CryptoKey }> {
  if (!material.wrappedDekRecovery) {
    throw new AppError('key_unavailable', {
      message: 'This account was set up without a recovery key.',
    })
  }

  const recoveryKek = await deriveRecoveryKek(recoveryKey, material)
  try {
    const dek = await unwrapDataKey(material.wrappedDekRecovery, recoveryKek)
    // The recovery KEK stands in until a new passphrase is chosen; it can wrap
    // a per-backup key just as well.
    return { cipher: new DataKeyCipher(dek, await keyIdFor(material)), dek, kek: recoveryKek }
  } catch (cause) {
    throw new AppError('key_unavailable', {
      message: 'That recovery key does not unlock this account.',
      cause,
    })
  }
}

/**
 * Changes the passphrase (docs/encryption.md §7).
 *
 * The data key is untouched: only its wrapping changes, so every backup and
 * every envelope written under the old passphrase stays readable. A new
 * recovery key is issued at the same time, because the old one was printed
 * against the old salt.
 */
export async function rotatePassphrase(
  dek: CryptoKey,
  newPassphrase: string,
): Promise<{ material: StoredKeyMaterial; kek: CryptoKey; recoveryKey: string }> {
  const params = createKdfParams()
  const kek = await deriveKek(newPassphrase, params)
  const recoveryKey = generateRecoveryKey()

  return {
    material: {
      ...params,
      wrappedDekSync: await wrapDataKey(dek, kek),
      wrappedDekRecovery: await wrapDataKey(dek, await deriveRecoveryKek(recoveryKey, params)),
    },
    kek,
    recoveryKey,
  }
}

/** Unlock on this or any other device (docs/encryption.md §5). */
export async function unlockKeyMaterial(
  passphrase: string,
  material: StoredKeyMaterial,
): Promise<{ cipher: EnvelopeCipher; dek: CryptoKey; kek: CryptoKey }> {
  const kek = await deriveKek(passphrase, material)
  try {
    const dek = await unwrapDataKey(material.wrappedDekSync, kek)
    return { cipher: new DataKeyCipher(dek, await keyIdFor(material)), dek, kek }
  } catch (cause) {
    throw new AppError('key_unavailable', {
      message: 'That passphrase does not unlock this account.',
      cause,
    })
  }
}

/**
 * A fresh key for one backup, wrapped with the **account data key**
 * (docs/encryption.md §3, §7).
 *
 * Per backup rather than one key for all of them: a key that only ever
 * protected a single archive is a much smaller thing to lose.
 *
 * Wrapped with the data key and not with the passphrase-derived KEK, on
 * purpose. The KEK changes whenever the passphrase does; the data key never
 * does. Wrapping with the KEK would quietly strand every existing backup the
 * first time someone changed their passphrase — which is precisely when they
 * are most likely to need one.
 */
export async function createBackupCipher(
  accountKey: CryptoKey,
): Promise<{ cipher: EnvelopeCipher; wrapped: WrappedKey }> {
  const dek = await generateDataKey()
  const wrapped = await wrapDataKey(dek, accountKey)
  return { cipher: new DataKeyCipher(dek, randomBytes(16)), wrapped }
}

export async function openBackupCipher(
  accountKey: CryptoKey,
  wrapped: WrappedKey,
): Promise<EnvelopeCipher> {
  try {
    const dek = await unwrapDataKey(wrapped, accountKey)
    return new DataKeyCipher(dek, randomBytes(16))
  } catch (cause) {
    throw new AppError('key_unavailable', {
      message: 'This backup cannot be opened with this account key.',
      cause,
    })
  }
}

export function encodePayload(bytes: Bytes): string {
  return toBase64(bytes)
}

export function decodePayload(payload: string): Bytes {
  return fromBase64(payload)
}

export { randomBytes, utf8 }

/**
 * The identity keypair that lets colleagues hand this device a workspace key
 * (docs/encryption.md §9).
 *
 * It is derived from nothing: it is generated once and then wrapped with the
 * account data key, so the same person recovers it on a second device by
 * unlocking their account, and nobody else recovers it at all.
 */
export interface StoredIdentity {
  publicKey: string
  wrappedPrivateKey: WrappedKey
}

export async function createIdentity(accountKey: CryptoKey): Promise<{
  identity: IdentityKeyPair
  stored: StoredIdentity
}> {
  const identity = await generateIdentityKeyPair()
  return {
    identity,
    stored: {
      publicKey: identity.publicKey,
      wrappedPrivateKey: await wrapIdentityPrivateKey(identity.privateKey, accountKey),
    },
  }
}

export async function openIdentity(
  stored: StoredIdentity,
  accountKey: CryptoKey,
): Promise<IdentityKeyPair> {
  return {
    publicKey: stored.publicKey,
    privateKey: await unwrapIdentityPrivateKey(stored.wrappedPrivateKey, accountKey),
  }
}

/**
 * The key id for a workspace's envelopes.
 *
 * Derived from the workspace id, so every member computes the same value
 * without anyone having to publish it.
 */
export async function workspaceKeyId(workspaceId: string): Promise<Bytes> {
  const { sha256 } = await import('@clinote/crypto')
  return (await sha256(utf8(`clinote-workspace:${workspaceId}`))).slice(0, 16) as Bytes
}

export async function createWorkspaceCipher(
  workspaceId: string,
  key: CryptoKey,
): Promise<EnvelopeCipher> {
  return new DataKeyCipher(key, await workspaceKeyId(workspaceId))
}
