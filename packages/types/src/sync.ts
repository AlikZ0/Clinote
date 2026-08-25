/**
 * Sync wire format (docs/sync.md §2). The server orders and fans out these
 * envelopes; `payload` is opaque ciphertext it can never read.
 */
import { z } from 'zod'
import { entityTypeSchema } from './entities'

export const outboxStates = ['pending', 'uploading', 'synced', 'failed', 'conflict'] as const
export const outboxStateSchema = z.enum(outboxStates)

export const syncOperationSchema = z.enum(['put', 'delete'])

export const syncEnvelopeSchema = z.object({
  /** Idempotency key: replays of the same operation are accepted once. */
  operationId: z.uuid(),
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  operation: syncOperationSchema,
  hlc: z.string().min(3),
  /**
   * The clock value the sender's record had before this change, or null for a
   * creation. A receiver whose own value differs knows the sender never saw
   * its version — which is how divergence is detected (docs/sync.md §5).
   */
  baseHlc: z.string().min(3).nullable().default(null),
  deviceId: z.uuid(),
  /** base64 of the encrypted envelope described in docs/encryption.md §4. */
  payload: z.base64(),
})

export const syncPushRequestSchema = z.object({
  envelopes: z.array(syncEnvelopeSchema).min(1).max(500),
})

export const syncPushResponseSchema = z.object({
  accepted: z.array(z.uuid()),
  seq: z.record(z.uuid(), z.number().int().positive()),
})

export const syncChangeSchema = syncEnvelopeSchema.extend({
  seq: z.number().int().positive(),
  createdAt: z.iso.datetime(),
})

export const syncChangesResponseSchema = z.object({
  items: z.array(syncChangeSchema),
  nextCursor: z.number().int().nonnegative().nullable(),
  hasMore: z.boolean(),
})

export type OutboxState = z.infer<typeof outboxStateSchema>
export type SyncOperation = z.infer<typeof syncOperationSchema>
export type SyncEnvelope = z.infer<typeof syncEnvelopeSchema>
export type SyncChange = z.infer<typeof syncChangeSchema>
