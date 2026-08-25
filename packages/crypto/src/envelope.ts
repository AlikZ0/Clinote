/**
 * Self-describing encrypted envelope (docs/encryption.md §4).
 *
 *   magic "CLNT" | version(1) | alg(1) | keyId(16) | iv(12) | ciphertext+tag
 *
 * Decryption fails closed: unknown version or algorithm is a hard error, and a
 * tag mismatch surfaces as `decryption_failed` rather than partial plaintext.
 */
import { type Bytes, fromBase64, randomBytes, toBase64, webcrypto } from './primitives'

export const ENVELOPE_MAGIC: Bytes = new Uint8Array([0x43, 0x4c, 0x4e, 0x54]) // "CLNT"
export const ENVELOPE_VERSION = 1
export const ALG_AES_256_GCM = 1
const KEY_ID_BYTES = 16
const IV_BYTES = 12
export const HEADER_BYTES = 4 + 1 + 1 + KEY_ID_BYTES + IV_BYTES

export interface EnvelopeHeader {
  version: number
  alg: number
  /** base64 of the 16-byte key id */
  keyId: string
  /** base64 of the 12-byte IV */
  iv: string
}

export function encodeHeader(header: { keyId: Bytes; iv: Bytes }): Bytes {
  if (header.keyId.length !== KEY_ID_BYTES) throw new Error('keyId must be 16 bytes')
  if (header.iv.length !== IV_BYTES) throw new Error('iv must be 12 bytes')
  const out = new Uint8Array(HEADER_BYTES)
  out.set(ENVELOPE_MAGIC, 0)
  out[4] = ENVELOPE_VERSION
  out[5] = ALG_AES_256_GCM
  out.set(header.keyId, 6)
  out.set(header.iv, 6 + KEY_ID_BYTES)
  return out
}

export function decodeHeader(envelope: Uint8Array): EnvelopeHeader {
  if (envelope.length < HEADER_BYTES) throw new Error('Envelope is truncated')
  for (let i = 0; i < ENVELOPE_MAGIC.length; i += 1) {
    if (envelope[i] !== ENVELOPE_MAGIC[i]) throw new Error('Not a Clinote envelope')
  }
  const version = envelope[4] as number
  const alg = envelope[5] as number
  if (version !== ENVELOPE_VERSION) throw new Error(`Unsupported envelope version ${version}`)
  if (alg !== ALG_AES_256_GCM) throw new Error(`Unsupported envelope algorithm ${alg}`)
  return {
    version,
    alg,
    keyId: toBase64(envelope.subarray(6, 6 + KEY_ID_BYTES)),
    iv: toBase64(envelope.subarray(6 + KEY_ID_BYTES, HEADER_BYTES)),
  }
}

export async function encryptEnvelope(
  plaintext: Bytes,
  key: CryptoKey,
  keyId: Bytes,
): Promise<Bytes> {
  const iv = randomBytes(IV_BYTES)
  const header = encodeHeader({ keyId, iv })
  const ciphertext = new Uint8Array(
    await webcrypto().subtle.encrypt(
      // The header is authenticated but not encrypted, so a tampered key id or
      // version is detected by the GCM tag rather than silently accepted.
      { name: 'AES-GCM', iv, additionalData: header },
      key,
      plaintext,
    ),
  )
  const out = new Uint8Array(header.length + ciphertext.length)
  out.set(header, 0)
  out.set(ciphertext, header.length)
  return out
}

export async function decryptEnvelope(envelope: Bytes, key: CryptoKey): Promise<Bytes> {
  const header = decodeHeader(envelope)
  const headerBytes = envelope.subarray(0, HEADER_BYTES)
  const plaintext = await webcrypto().subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64(header.iv),
      additionalData: headerBytes,
    },
    key,
    envelope.subarray(HEADER_BYTES),
  )
  return new Uint8Array(plaintext)
}
