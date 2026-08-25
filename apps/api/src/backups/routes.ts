/**
 * Cloud backup (docs/backup.md §4, §5; docs/api.md §6).
 *
 * The archive never passes through this API. The device asks for permission to
 * upload one object, uploads it directly, and then asks the server to verify
 * what actually landed. The server checks size and digest — it cannot check the
 * contents, because it cannot read them.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError } from '@clinote/shared'
import { z } from 'zod'
import type { Env } from '../env'
import { resolveEntitlement } from '../entitlements'
import { createRequireAuth, requireAuthContext } from '../plugins/authenticate'
import type { BackupRecord, Stores } from '../storage'
import type { ObjectStore } from '../storage/objects'

/** Larger than any plausible practice archive; a sanity bound, not a quota. */
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024 * 1024

const wrappedKeySchema = z.object({ iv: z.base64(), key: z.base64() })

const initSchema = z.object({
  deviceId: z.uuid(),
  sizeBytes: z.number().int().positive().max(MAX_BACKUP_BYTES),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  wrappedDek: wrappedKeySchema,
  appVersion: z.string().min(1).max(32),
  databaseVersion: z.number().int().positive(),
})

const completeSchema = z.object({ checksum: z.string().regex(/^[0-9a-f]{64}$/) })

export async function registerBackupRoutes(
  app: FastifyInstance,
  options: { env: Env; stores: Stores; objects: ObjectStore },
): Promise<void> {
  const requireAuth = createRequireAuth(options.env.JWT_SECRET)
  const { stores, objects } = options

  async function requireBackup(userId: string) {
    const entitlement = await resolveEntitlement(stores, userId)
    if (entitlement.features.cloudBackup !== true) {
      throw new AppError('feature_not_available', {
        message: 'Cloud Backup is available with Clinote Pro.',
      })
    }
    return entitlement
  }

  async function requireOwnBackup(userId: string, id: string): Promise<BackupRecord> {
    const backup = await stores.backups.findById(id)
    if (!backup || backup.userId !== userId) {
      throw new AppError('not_found', { message: 'That backup is not on your account.' })
    }
    return backup
  }

  /** Health must be declared before `/:id` routes so it is not read as an id. */
  app.get('/api/v1/backups/health', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const entitlement = await requireBackup(userId)

    const backups = await stores.backups.listForUser(userId, 100)
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const recent = backups.filter((backup) => backup.createdAt >= since)
    const usage = await stores.storageUsage.find(userId)

    const lastSuccessful = backups.find((backup) => backup.backupStatus === 'completed') ?? null
    const lastFailed = backups.find((backup) => backup.backupStatus === 'failed') ?? null
    const mostRecent = backups.find((backup) => backup.backupStatus !== 'pending') ?? null

    return {
      lastSuccessfulBackup: lastSuccessful?.completedAt ?? null,
      lastFailedBackup: lastFailed?.createdAt ?? null,
      successCount30d: recent.filter((backup) => backup.backupStatus === 'completed').length,
      failureCount30d: recent.filter((backup) => backup.backupStatus === 'failed').length,
      storageUsedBytes: usage.bytesUsed,
      storageLimitBytes: entitlement.limits.storageBytes ?? 0,
      // A red state the dashboard can act on, decided here rather than in the UI.
      needsAttention: mostRecent === null || mostRecent.backupStatus !== 'completed',
    }
  })

  app.post(
    '/api/v1/backups/init',
    {
      preHandler: requireAuth,
      config: {
        rateLimit: { max: options.env.NODE_ENV === 'test' ? 10_000 : 20, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const { userId } = requireAuthContext(request)
      const entitlement = await requireBackup(userId)
      const body = initSchema.parse(request.body)

      const device = await stores.devices.findById(body.deviceId)
      if (!device || device.userId !== userId || device.revokedAt) {
        throw new AppError('forbidden', {
          message: 'This device is not registered on your account.',
        })
      }

      const usage = await stores.storageUsage.recalculate(userId)
      const limit = entitlement.limits.storageBytes ?? 0
      if (usage.bytesUsed + body.sizeBytes > limit) {
        throw new AppError('storage_limit_reached', {
          message: 'This backup would exceed your storage. Remove an older backup and try again.',
          details: { limit, used: usage.bytesUsed, required: body.sizeBytes },
        })
      }

      const id = randomUUID()
      // The key carries no client data — an account id and a random backup id.
      const objectKey = `backups/${userId}/${id}.clinote`
      const retentionDays = entitlement.limits.backupRetentionDays ?? 0

      await stores.backups.create({
        id,
        userId,
        deviceId: body.deviceId,
        objectKey,
        sizeBytes: body.sizeBytes,
        checksum: body.checksum,
        wrappedDek: body.wrappedDek,
        appVersion: body.appVersion,
        databaseVersion: body.databaseVersion,
        backupStatus: 'pending',
        emailStatus: 'pending',
        errorCode: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
        expiresAt:
          retentionDays > 0
            ? new Date(Date.now() + retentionDays * 86_400_000).toISOString()
            : null,
      })

      const upload = await objects.createUploadUrl(objectKey, { sizeBytes: body.sizeBytes })
      reply.status(201)
      return { backupId: id, upload }
    },
  )

  app.post('/api/v1/backups/:id/complete', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    await requireBackup(userId)

    const { id } = request.params as { id: string }
    const backup = await requireOwnBackup(userId, id)
    const body = completeSchema.parse(request.body)

    const metadata = await objects.head(backup.objectKey)
    if (!metadata) {
      await fail(backup, 'backup_invalid_format')
      throw new AppError('backup_invalid_format', {
        message: 'The backup did not finish uploading. Please try again.',
      })
    }

    if (metadata.sizeBytes !== backup.sizeBytes) {
      await fail(backup, 'backup_checksum_mismatch')
      throw new AppError('backup_checksum_mismatch', {
        message: 'The upload is incomplete and was not kept.',
        details: { expected: backup.sizeBytes, actual: metadata.sizeBytes },
      })
    }

    // The digest is computed from what actually landed, not from what the
    // device promised: that is the whole point of verifying.
    const actual = await objects.checksum(backup.objectKey)
    if (actual !== null && (actual !== body.checksum || actual !== backup.checksum)) {
      await fail(backup, 'backup_checksum_mismatch')
      throw new AppError('backup_checksum_mismatch', {
        message: 'The backup arrived damaged and was not kept.',
      })
    }

    const completed = await stores.backups.update(backup.id, {
      backupStatus: 'completed',
      completedAt: new Date().toISOString(),
      errorCode: null,
    })
    await stores.storageUsage.recalculate(userId)

    return toPublic(completed)
  })

  app.get('/api/v1/backups', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    await requireBackup(userId)
    return (await stores.backups.listForUser(userId, 100)).map(toPublic)
  })

  app.get('/api/v1/backups/:id/download', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    await requireBackup(userId)

    const { id } = request.params as { id: string }
    const backup = await requireOwnBackup(userId, id)
    if (backup.backupStatus !== 'completed') {
      throw new AppError('not_found', { message: 'That backup did not complete.' })
    }

    const download = await objects.createDownloadUrl(backup.objectKey)
    // The wrapped key travels with the link: without the passphrase it is
    // useless, and without it the archive cannot be opened at all.
    return { ...download, wrappedDek: backup.wrappedDek, checksum: backup.checksum }
  })

  app.delete('/api/v1/backups/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    await requireBackup(userId)

    const { id } = request.params as { id: string }
    const backup = await requireOwnBackup(userId, id)

    await objects.delete(backup.objectKey)
    await stores.backups.delete(backup.id)
    await stores.storageUsage.recalculate(userId)

    reply.status(204)
    return null
  })

  async function fail(backup: BackupRecord, errorCode: string): Promise<void> {
    await stores.backups.update(backup.id, { backupStatus: 'failed', errorCode })
    await objects.delete(backup.objectKey).catch(() => undefined)
  }

  function toPublic(backup: BackupRecord) {
    return {
      id: backup.id,
      createdAt: backup.createdAt,
      completedAt: backup.completedAt,
      sizeBytes: backup.sizeBytes,
      checksum: backup.checksum,
      status: backup.backupStatus,
      emailStatus: backup.emailStatus,
      errorCode: backup.errorCode,
      deviceId: backup.deviceId,
      appVersion: backup.appVersion,
      databaseVersion: backup.databaseVersion,
      expiresAt: backup.expiresAt,
    }
  }
}
