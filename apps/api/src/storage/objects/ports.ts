/**
 * Object storage (docs/backup.md §4, docs/security.md §5).
 *
 * A backup never travels through the JSON API: the device uploads it straight
 * to storage with a short-lived, single-object URL. Nothing here can list a
 * bucket or read an object's contents — the API only needs to hand out URLs,
 * check size and digest, and delete.
 */
export interface SignedUpload {
  url: string
  /** Headers the device must send with the PUT for the signature to hold. */
  headers: Record<string, string>
  expiresAt: string
}

export interface ObjectMetadata {
  sizeBytes: number
  /** Hex SHA-256 when the backend records one; null when it does not. */
  checksum: string | null
}

export interface ObjectStore {
  /** Short-lived permission to PUT exactly one object. */
  createUploadUrl(key: string, options: { sizeBytes: number }): Promise<SignedUpload>
  createDownloadUrl(key: string): Promise<{ url: string; expiresAt: string }>
  head(key: string): Promise<ObjectMetadata | null>
  delete(key: string): Promise<void>
  /** Verification reads the object server-side; it is ciphertext either way. */
  checksum(key: string): Promise<string | null>
}
