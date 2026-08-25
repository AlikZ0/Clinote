/**
 * Thin, dependency-free wrappers over Web Crypto.
 *
 * Rule (product spec §85, docs/architecture.md I8): we never implement a
 * cryptographic algorithm ourselves. Everything here delegates to
 * `crypto.subtle`, which exists in browsers and in Node's `globalThis.crypto`.
 */

/**
 * Byte buffers backed by a plain (non-shared) ArrayBuffer.
 *
 * `Uint8Array` alone widens to `ArrayBufferLike`, which TypeScript refuses to
 * pass as a `BufferSource` because a SharedArrayBuffer cannot be used with
 * Web Crypto. Naming the concrete buffer type keeps every call site cast-free.
 */
export type Bytes = Uint8Array<ArrayBuffer>

export function webcrypto(): Crypto {
  const impl = globalThis.crypto
  if (!impl?.subtle) {
    throw new Error('Web Crypto is unavailable: Clinote requires a secure context (HTTPS).')
  }
  return impl
}

export function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length)
  webcrypto().getRandomValues(bytes)
  return bytes
}

export async function sha256(data: BufferSource): Promise<Bytes> {
  const digest = await webcrypto().subtle.digest('SHA-256', data)
  return new Uint8Array(digest)
}

export async function sha256Hex(data: BufferSource): Promise<string> {
  return toHex(await sha256(data))
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(value: string): Bytes {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function utf8(value: string): Bytes {
  return new TextEncoder().encode(value)
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** Constant-time comparison for digests and tokens. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}
