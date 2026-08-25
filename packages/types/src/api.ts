/** Shared HTTP envelope shapes (docs/api.md §1). */
import { z } from 'zod'
import { ERROR_CODES } from '@clinote/shared'

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).default({}),
  }),
})

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
}

export const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  platform: z.enum(['ios', 'android', 'web', 'desktop', 'unknown']),
  lastSeen: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})

export const backupStatuses = ['pending', 'uploading', 'verifying', 'completed', 'failed'] as const
export const backupStatusSchema = z.enum(backupStatuses)

export const backupRecordSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  size: z.number().int().nonnegative(),
  checksum: z.string(),
  status: backupStatusSchema,
  deviceId: z.uuid(),
  appVersion: z.string(),
  databaseVersion: z.number().int().positive(),
  /** Separate from backupStatus on purpose: a bounced email is not a failed backup (§77). */
  emailStatus: z.enum(['pending', 'sent', 'failed', 'skipped']).default('pending'),
})

export const backupHealthSchema = z.object({
  lastSuccessfulBackup: z.iso.datetime().nullable(),
  lastFailedBackup: z.iso.datetime().nullable(),
  successCount30d: z.number().int().nonnegative(),
  failureCount30d: z.number().int().nonnegative(),
  storageUsedBytes: z.number().int().nonnegative(),
})

export type ApiError = z.infer<typeof apiErrorSchema>
export type Device = z.infer<typeof deviceSchema>
export type BackupStatus = z.infer<typeof backupStatusSchema>
export type BackupRecord = z.infer<typeof backupRecordSchema>
export type BackupHealth = z.infer<typeof backupHealthSchema>
