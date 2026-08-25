/**
 * An in-memory stand-in for the sync relay.
 *
 * It does exactly what the real one does — assign sequences, hand back
 * envelopes after a cursor, never look inside a payload — so two simulated
 * devices can be run against each other without HTTP.
 */
import type { SyncChange, SyncEnvelope } from '@clinote/types'
import type { SyncTransport } from '~/services/syncEngine'

export class FakeSyncServer {
  private readonly envelopes: SyncChange[] = []
  private readonly cursors = new Map<string, number>()
  /** Set to make the next push fail, the way a flaky network does. */
  failNextPush: Error | null = null

  transport(): SyncTransport {
    return {
      push: async (envelopes: SyncEnvelope[]) => {
        if (this.failNextPush) {
          const error = this.failNextPush
          this.failNextPush = null
          throw error
        }

        const seq: Record<string, number> = {}
        for (const envelope of envelopes) {
          const existing = this.envelopes.find((item) => item.operationId === envelope.operationId)
          if (existing) {
            seq[envelope.operationId] = existing.seq
            continue
          }
          const record: SyncChange = {
            ...envelope,
            seq: this.envelopes.length + 1,
            createdAt: new Date().toISOString(),
          }
          this.envelopes.push(record)
          seq[envelope.operationId] = record.seq
        }
        return { seq }
      },

      changes: async (since: number, limit: number) => {
        const items = this.envelopes.filter((item) => item.seq > since).slice(0, limit)
        const hasMore = this.envelopes.some((item) => item.seq > (items.at(-1)?.seq ?? since))
        return { items, nextCursor: items.at(-1)?.seq ?? null, hasMore }
      },

      setCursor: async (deviceId: string, seq: number) => {
        this.cursors.set(deviceId, Math.max(seq, this.cursors.get(deviceId) ?? 0))
      },
    }
  }

  get size(): number {
    return this.envelopes.length
  }

  payloads(): string[] {
    return this.envelopes.map((item) => item.payload)
  }
}
