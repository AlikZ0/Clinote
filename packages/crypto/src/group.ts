/**
 * Sharing one encrypted dataset with several people (docs/encryption.md §9).
 *
 * A workspace has a single data key. Every member needs it, and the server must
 * never have it — so the key travels from an existing member's device to a new
 * member's device, sealed with ECDH so that only the recipient can open it.
 *
 * All of this is standard WebCrypto: ECDH P-256 to agree on a secret, HKDF to
 * turn that secret into a wrapping key, AES-GCM to do the wrapping. No new
 * cryptography is invented here, and none should be.
 */
import { fromBase64, randomBytes, toBase64, utf8, webcrypto } from './primitives'
import { KEY_BYTES, type WrappedKey } from './keys'

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const

export interface IdentityKeyPair {
  /** base64 SPKI. Published to the other members through the server. */
  publicKey: string
  privateKey: CryptoKey
}

/**
 * The long-lived keypair that identifies a person to their colleagues.
 *
 * The private key is extractable only so that it can be wrapped with the
 * account data key — that is what lets the same person open the workspace on
 * their second device without another member having to grant it again.
 */
export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const pair = await webcrypto().subtle.generateKey(CURVE, true, ['deriveKey', 'deriveBits'])
  const spki = await webcrypto().subtle.exportKey('spki', pair.publicKey)
  return { publicKey: toBase64(new Uint8Array(spki)), privateKey: pair.privateKey }
}

export async function wrapIdentityPrivateKey(
  privateKey: CryptoKey,
  accountKey: CryptoKey,
): Promise<WrappedKey> {
  const iv = randomBytes(12)
  const wrapped = await webcrypto().subtle.wrapKey('pkcs8', privateKey, accountKey, {
    name: 'AES-GCM',
    iv,
  })
  return { iv: toBase64(iv), key: toBase64(new Uint8Array(wrapped)) }
}

export async function unwrapIdentityPrivateKey(
  wrapped: WrappedKey,
  accountKey: CryptoKey,
): Promise<CryptoKey> {
  return webcrypto().subtle.unwrapKey(
    'pkcs8',
    fromBase64(wrapped.key),
    accountKey,
    { name: 'AES-GCM', iv: fromBase64(wrapped.iv) },
    CURVE,
    // Extractable: a second device of the same person re-wraps it locally.
    true,
    ['deriveKey', 'deriveBits'],
  )
}

export async function importIdentityPublicKey(publicKey: string): Promise<CryptoKey> {
  return webcrypto().subtle.importKey('spki', fromBase64(publicKey), CURVE, true, [])
}

/**
 * A workspace key on its way from one member to another.
 *
 * Everything except the wrapped key is public: the recipient needs the sender's
 * public key and the salt to derive the same wrapping key, and an observer
 * learns nothing from them.
 */
export interface SealedKey {
  /** base64 SPKI of the granting member's public key. */
  senderPublicKey: string
  /** base64 */
  salt: string
  /** base64 */
  iv: string
  /** base64 */
  key: string
}

/**
 * Derives the wrapping key for one specific (sender, recipient, workspace).
 *
 * Both public keys and the workspace id go into the HKDF info, so a grant
 * cannot be replayed towards a different person or a different workspace: the
 * derivation simply produces a different key and the unwrap fails.
 */
async function deriveWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  context: { workspaceId: string; senderPublicKey: string; recipientPublicKey: string },
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const subtle = webcrypto().subtle
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const material = await subtle.importKey('raw', new Uint8Array(shared), 'HKDF', false, [
    'deriveKey',
  ])

  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: utf8(
        `clinote-workspace-key-v1:${context.workspaceId}:${context.senderPublicKey}:${context.recipientPublicKey}`,
      ),
    },
    material,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

/** Called on the granting member's device. */
export async function sealKeyForMember(input: {
  workspaceId: string
  workspaceKey: CryptoKey
  sender: IdentityKeyPair
  recipientPublicKey: string
}): Promise<SealedKey> {
  const salt = randomBytes(16)
  const wrappingKey = await deriveWrappingKey(
    input.sender.privateKey,
    await importIdentityPublicKey(input.recipientPublicKey),
    {
      workspaceId: input.workspaceId,
      senderPublicKey: input.sender.publicKey,
      recipientPublicKey: input.recipientPublicKey,
    },
    salt,
  )

  const iv = randomBytes(12)
  const wrapped = await webcrypto().subtle.wrapKey('raw', input.workspaceKey, wrappingKey, {
    name: 'AES-GCM',
    iv,
  })

  return {
    senderPublicKey: input.sender.publicKey,
    salt: toBase64(salt),
    iv: toBase64(iv),
    key: toBase64(new Uint8Array(wrapped)),
  }
}

/** Called on the receiving member's device. */
export async function openSealedKey(input: {
  workspaceId: string
  sealed: SealedKey
  recipient: IdentityKeyPair
}): Promise<CryptoKey> {
  const wrappingKey = await deriveWrappingKey(
    input.recipient.privateKey,
    await importIdentityPublicKey(input.sealed.senderPublicKey),
    {
      workspaceId: input.workspaceId,
      senderPublicKey: input.sealed.senderPublicKey,
      recipientPublicKey: input.recipient.publicKey,
    },
    fromBase64(input.sealed.salt),
  )

  return webcrypto().subtle.unwrapKey(
    'raw',
    fromBase64(input.sealed.key),
    wrappingKey,
    { name: 'AES-GCM', iv: fromBase64(input.sealed.iv) },
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    // The workspace key must stay wrappable: this member may later grant it on.
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  )
}
