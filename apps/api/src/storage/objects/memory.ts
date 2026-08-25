/**
 * In-process object store for tests.
 *
 * The signed URL is a placeholder: unit tests never perform the PUT, they call
 * `put()` directly to stand in for the device's upload.
 */
import { createHash } from 'node:crypto'
import type { ObjectStore } from './ports'

export interface MemoryObjectStore extends ObjectStore {
  put(key: string, body: Uint8Array): void
  has(key: string): boolean
  size(): number
}

export function createMemoryObjectStore(): MemoryObjectStore {
  const objects = new Map<string, Uint8Array>()

  return {
    async createUploadUrl(key) {
      return {
        url: `memory://upload/${encodeURIComponent(key)}`,
        headers: { 'content-type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }
    },

    async createDownloadUrl(key) {
      return {
        url: `memory://download/${encodeURIComponent(key)}`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }
    },

    async head(key) {
      const object = objects.get(key)
      return object ? { sizeBytes: object.length, checksum: null } : null
    },

    async delete(key) {
      objects.delete(key)
    },

    async checksum(key) {
      const object = objects.get(key)
      return object ? createHash('sha256').update(object).digest('hex') : null
    },

    put(key, body) {
      objects.set(key, body)
    },

    has(key) {
      return objects.has(key)
    },

    size() {
      return objects.size
    },
  }
}
