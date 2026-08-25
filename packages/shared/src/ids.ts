/** Client-generated identity. See docs/local-first.md §6. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Creates a RFC 4122 v4 UUID using the platform CSPRNG.
 * Ids are generated on the device so that entities have a stable identity
 * before (and without) any server round trip.
 */
export function createId(): string {
  return globalThis.crypto.randomUUID()
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
