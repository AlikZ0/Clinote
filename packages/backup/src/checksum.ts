/**
 * Archive integrity (docs/backup.md §2).
 *
 * The checksum covers the serialized database *and* the digest of every file,
 * so a truncated archive or a swapped x-ray is detected before a single record
 * is written back into the user's database.
 */
import { sha256Hex, utf8 } from '@clinote/crypto'

export interface FileDigest {
  fileId: string
  /** SHA-256 hex of the original bytes. */
  hash: string
}

export async function computeChecksum(
  databaseJson: string,
  files: readonly FileDigest[],
): Promise<string> {
  const manifestOfFiles = [...files]
    .map((file) => `${file.fileId}:${file.hash}`)
    .sort()
    .join('\n')
  const databaseDigest = await sha256Hex(utf8(databaseJson))
  return `sha256:${await sha256Hex(utf8(`${databaseDigest}\n${manifestOfFiles}`))}`
}
