/** The real relay behind `SyncTransport` (docs/api.md §5). */
import type { SyncChange, SyncEnvelope } from '@clinote/types'
import type { ApiClient } from '~/api/client'
import type { SyncTransport } from './syncEngine'

export function createHttpSyncTransport(api: ApiClient): SyncTransport {
  return {
    async push(envelopes: SyncEnvelope[]) {
      return api.request<{ seq: Record<string, number> }>('/sync/push', {
        method: 'POST',
        body: { envelopes },
      })
    },

    async changes(since: number, limit: number) {
      return api.request<{ items: SyncChange[]; nextCursor: number | null; hasMore: boolean }>(
        `/sync/changes?since=${since}&limit=${limit}`,
      )
    },

    async setCursor(deviceId: string, seq: number) {
      await api.request('/sync/cursor', { method: 'POST', body: { deviceId, seq } })
    },
  }
}
