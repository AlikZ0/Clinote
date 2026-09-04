/**
 * PostgreSQL adapter for the storage ports.
 *
 * Mapping only: not one authentication or entitlement rule lives here, which
 * is what lets the same suites run against this adapter and the in-memory one.
 */
import { randomUUID } from 'node:crypto'
import type {
  NotificationChannel,
  NotificationPreferences,
  Plan,
  Platform,
  ReminderKind,
  AuditAction,
  WorkspaceRole,
} from '@clinote/types'
import { createPool, checkConnection, type Sql } from '../../db/pool'
import { migrate } from '../../db/migrate'
import type {
  BackupRecord,
  BackupStatus,
  BackupStore,
  BillingEventRecord,
  BillingStore,
  DeviceRecord,
  DeviceStore,
  PasswordResetRecord,
  PasswordResetStore,
  PlanStore,
  SessionRecord,
  SessionStore,
  Storage,
  Stores,
  NotificationPreferenceStore,
  PushSubscriptionRecord,
  PushSubscriptionStore,
  ReminderScheduleRecord,
  ReminderScheduleStore,
  ReminderState,
  StorageUsageStore,
  SubscriptionRecord,
  SubscriptionStore,
  SyncEnvelopeRecord,
  SyncStore,
  AuditEventRecord,
  AuditStore,
  IdentityKeyStore,
  WorkspaceInviteRecord,
  WorkspaceKeyStore,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceStore,
  UserKeysRecord,
  UserKeysStore,
  UserRecord,
  UserStore,
  OrganizationRecord,
  OrganizationMemberRecord,
  OrganizationInviteRecord,
  OrganizationStore,
} from '../ports'

interface UserRow {
  id: string
  email: string
  password_hash: string
  name: string | null
  locale: string | null
  timezone: string | null
  email_verified_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    locale: row.locale,
    timezone: row.timezone,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Only these columns may be written by a profile update. */
const USER_UPDATABLE: Record<string, string> = {
  passwordHash: 'password_hash',
  name: 'name',
  locale: 'locale',
  timezone: 'timezone',
  emailVerifiedAt: 'email_verified_at',
  deletedAt: 'deleted_at',
}

export function createPostgresStores(sql: Sql): Stores {
  const users: UserStore = {
    async findById(id) {
      const { rows } = await sql.query<UserRow>(
        'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
        [id],
      )
      return rows[0] ? toUser(rows[0]) : null
    },

    async findByEmail(email) {
      const { rows } = await sql.query<UserRow>(
        'SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL',
        [email],
      )
      return rows[0] ? toUser(rows[0]) : null
    },

    async create(user) {
      const { rows } = await sql.query<UserRow>(
        `INSERT INTO users (id, email, password_hash, name, locale, timezone,
                            email_verified_at, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          user.id,
          user.email,
          user.passwordHash,
          user.name,
          user.locale,
          user.timezone,
          user.emailVerifiedAt,
          user.createdAt,
          user.updatedAt,
          user.deletedAt,
        ],
      )
      return toUser(rows[0] as UserRow)
    },

    async update(id, patch) {
      const assignments: string[] = []
      const values: unknown[] = [id]

      for (const [key, column] of Object.entries(USER_UPDATABLE)) {
        if (!(key in patch)) continue
        values.push((patch as Record<string, unknown>)[key])
        assignments.push(`${column} = $${values.length}`)
      }

      // A patch of nothing is a read, not an error.
      if (assignments.length === 0) {
        const { rows } = await sql.query<UserRow>('SELECT * FROM users WHERE id = $1', [id])
        if (!rows[0]) throw new Error(`Unknown user ${id}`)
        return toUser(rows[0])
      }

      assignments.push('updated_at = now()')
      const { rows } = await sql.query<UserRow>(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      )
      if (!rows[0]) throw new Error(`Unknown user ${id}`)
      return toUser(rows[0])
    },

    async listAll() {
      const { rows } = await sql.query<UserRow>(
        'SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC',
      )
      return rows.map(toUser)
    },
  }

  const sessions: SessionStore = {
    async create(session) {
      await sql.query(
        `INSERT INTO sessions (id, user_id, refresh_token_hash, family_id, device_id,
                               ip, user_agent, created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          session.id,
          session.userId,
          session.refreshTokenHash,
          session.familyId,
          session.deviceId,
          session.ip,
          session.userAgent,
          session.createdAt,
          session.expiresAt,
          session.revokedAt,
        ],
      )
      return session
    },

    async findByTokenHash(hash) {
      const { rows } = await sql.query<{
        id: string
        user_id: string
        refresh_token_hash: string
        family_id: string
        device_id: string | null
        ip: string | null
        user_agent: string | null
        created_at: string
        expires_at: string
        revoked_at: string | null
      }>('SELECT * FROM sessions WHERE refresh_token_hash = $1', [hash])

      const row = rows[0]
      if (!row) return null
      return {
        id: row.id,
        userId: row.user_id,
        refreshTokenHash: row.refresh_token_hash,
        familyId: row.family_id,
        deviceId: row.device_id,
        ip: row.ip,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      } satisfies SessionRecord
    },

    async revoke(id) {
      await sql.query(
        'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [id],
      )
    },

    async revokeFamily(familyId) {
      await sql.query(
        'UPDATE sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
        [familyId],
      )
    },

    async revokeAllForUser(userId) {
      await sql.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      )
    },
  }

  interface DeviceRow {
    id: string
    user_id: string
    name: string
    platform: string
    last_seen: string | null
    created_at: string
    revoked_at: string | null
  }

  function toDevice(row: DeviceRow): DeviceRecord {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      platform: row.platform as Platform,
      lastSeen: row.last_seen,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }
  }

  const devices: DeviceStore = {
    async listForUser(userId) {
      const { rows } = await sql.query<DeviceRow>(
        'SELECT * FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at',
        [userId],
      )
      return rows.map(toDevice)
    },

    async findById(id) {
      const { rows } = await sql.query<DeviceRow>('SELECT * FROM devices WHERE id = $1', [id])
      return rows[0] ? toDevice(rows[0]) : null
    },

    async upsert(device) {
      const { rows } = await sql.query<DeviceRow>(
        `INSERT INTO devices (id, user_id, name, platform, last_seen, created_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               platform = EXCLUDED.platform,
               last_seen = EXCLUDED.last_seen,
               revoked_at = NULL
         RETURNING *`,
        [device.id, device.userId, device.name, device.platform, device.lastSeen, device.createdAt],
      )
      return toDevice(rows[0] as DeviceRow)
    },

    async touch(id, lastSeen) {
      await sql.query('UPDATE devices SET last_seen = $2 WHERE id = $1', [id, lastSeen])
    },

    async revoke(id) {
      await sql.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [id])
    },
  }

  const passwordResets: PasswordResetStore = {
    async create(record) {
      await sql.query(
        `INSERT INTO password_resets (token_hash, user_id, expires_at, used_at, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (token_hash) DO UPDATE
           SET expires_at = EXCLUDED.expires_at, used_at = EXCLUDED.used_at`,
        [record.tokenHash, record.userId, record.expiresAt, record.usedAt, record.createdAt],
      )
    },

    async findByTokenHash(hash) {
      const { rows } = await sql.query<{
        token_hash: string
        user_id: string
        expires_at: string
        used_at: string | null
        created_at: string
      }>('SELECT * FROM password_resets WHERE token_hash = $1', [hash])

      const row = rows[0]
      if (!row) return null
      return {
        tokenHash: row.token_hash,
        userId: row.user_id,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        createdAt: row.created_at,
      } satisfies PasswordResetRecord
    },

    async markUsed(hash, usedAt) {
      await sql.query('UPDATE password_resets SET used_at = $2 WHERE token_hash = $1', [
        hash,
        usedAt,
      ])
    },

    async invalidateForUser(userId) {
      await sql.query('DELETE FROM password_resets WHERE user_id = $1', [userId])
    },
  }

  const subscriptions: SubscriptionStore = {
    async findByUserId(userId) {
      const { rows } = await sql.query<{
        id: string
        user_id: string | null
        organization_id: string | null
        plan_id: string
        status: string
        current_period_end: string | null
      }>(
        `SELECT id, user_id, organization_id, plan_id, status, current_period_end
           FROM subscriptions WHERE user_id = $1
          ORDER BY updated_at DESC, id DESC LIMIT 1`,
        [userId],
      )

      const row = rows[0]
      if (!row) return null
      return {
        id: row.id,
        userId: row.user_id,
        organizationId: row.organization_id,
        planId: row.plan_id,
        status: row.status as SubscriptionRecord['status'],
        currentPeriodEnd: row.current_period_end,
      }
    },

    async findByOrganizationId(organizationId) {
      const { rows } = await sql.query<{
        id: string
        user_id: string | null
        organization_id: string | null
        plan_id: string
        status: string
        current_period_end: string | null
      }>(
        `SELECT id, user_id, organization_id, plan_id, status, current_period_end
           FROM subscriptions WHERE organization_id = $1
          ORDER BY updated_at DESC, id DESC LIMIT 1`,
        [organizationId],
      )

      const row = rows[0]
      if (!row) return null
      return {
        id: row.id,
        userId: row.user_id,
        organizationId: row.organization_id,
        planId: row.plan_id,
        status: row.status as SubscriptionRecord['status'],
        currentPeriodEnd: row.current_period_end,
      }
    },

    async upsert(subscription) {
      // Find the row this write is meant to land on. Keying the conflict on a
      // freshly generated id meant every billing event inserted a rival row
      // instead of updating the account's subscription.
      const existing = subscription.id
        ? null
        : ((subscription.organizationId
            ? await subscriptions.findByOrganizationId(subscription.organizationId)
            : null) ??
          (subscription.userId ? await subscriptions.findByUserId(subscription.userId) : null))

      const subId = subscription.id ?? existing?.id ?? randomUUID()
      const organizationId = subscription.organizationId ?? existing?.organizationId ?? null
      await sql.query(
        `INSERT INTO subscriptions (id, user_id, organization_id, plan_id, status, current_period_end)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               organization_id = EXCLUDED.organization_id,
               plan_id = EXCLUDED.plan_id,
               status = EXCLUDED.status,
               current_period_end = EXCLUDED.current_period_end,
               updated_at = now()`,
        [
          subId,
          subscription.userId ?? null,
          organizationId,
          subscription.planId,
          subscription.status,
          subscription.currentPeriodEnd,
        ],
      )
      return { ...subscription, id: subId, organizationId }
    },
  }

  interface PlanRow {
    id: string
    name: string
    price_amount: number
    price_currency: string
    price_interval: string
    features: Record<string, boolean>
    limits: Record<string, number>
    is_public: boolean
    sort_order: number
  }

  function toPlan(row: PlanRow): Plan {
    return {
      id: row.id,
      name: row.name,
      price: {
        amount: row.price_amount,
        currency: row.price_currency,
        interval: row.price_interval as Plan['price']['interval'],
      },
      features: row.features,
      limits: row.limits,
      isPublic: row.is_public,
      sortOrder: row.sort_order,
    }
  }

  const plans: PlanStore = {
    async listPublic() {
      const { rows } = await sql.query<PlanRow>(
        'SELECT * FROM plans WHERE is_public ORDER BY sort_order, id',
      )
      return rows.map(toPlan)
    },

    async findById(id) {
      const { rows } = await sql.query<PlanRow>('SELECT * FROM plans WHERE id = $1', [id])
      return rows[0] ? toPlan(rows[0]) : null
    },
  }

  const keys: UserKeysStore = {
    async find(userId) {
      const { rows } = await sql.query<{
        user_id: string
        kdf: string
        salt: string
        iterations: number
        wrapped_dek_sync: unknown
        wrapped_dek_recovery: unknown | null
        created_at: string
        updated_at: string
      }>('SELECT * FROM user_keys WHERE user_id = $1', [userId])

      const row = rows[0]
      if (!row) return null
      return {
        userId: row.user_id,
        kdf: row.kdf,
        salt: row.salt,
        iterations: row.iterations,
        wrappedDekSync: row.wrapped_dek_sync,
        wrappedDekRecovery: row.wrapped_dek_recovery,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies UserKeysRecord
    },

    async put(record) {
      await sql.query(
        `INSERT INTO user_keys (user_id, kdf, salt, iterations, wrapped_dek_sync, wrapped_dek_recovery)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO UPDATE
           SET kdf = EXCLUDED.kdf,
               salt = EXCLUDED.salt,
               iterations = EXCLUDED.iterations,
               wrapped_dek_sync = EXCLUDED.wrapped_dek_sync,
               wrapped_dek_recovery = EXCLUDED.wrapped_dek_recovery,
               updated_at = now()`,
        [
          record.userId,
          record.kdf,
          record.salt,
          record.iterations,
          JSON.stringify(record.wrappedDekSync),
          record.wrappedDekRecovery === null ? null : JSON.stringify(record.wrappedDekRecovery),
        ],
      )
      return record
    },
  }

  const NO_WORKSPACE = '00000000-0000-0000-0000-000000000000'

  interface EnvelopeRow {
    seq: number
    user_id: string
    workspace_id: string | null
    operation_id: string
    entity_type: string
    entity_id: string
    operation: string
    hlc: string
    base_hlc: string | null
    device_id: string
    payload: Buffer
    created_at: string
  }

  function toEnvelope(row: EnvelopeRow): SyncEnvelopeRecord {
    return {
      seq: Number(row.seq),
      userId: row.user_id,
      workspaceId: row.workspace_id,
      operationId: row.operation_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation as 'put' | 'delete',
      hlc: row.hlc,
      baseHlc: row.base_hlc,
      deviceId: row.device_id,
      payload: row.payload.toString('base64'),
      createdAt: row.created_at,
    }
  }

  const sync: SyncStore = {
    async append(scope, incoming) {
      const assigned: Record<string, number> = {}

      for (const envelope of incoming) {
        // ON CONFLICT DO UPDATE (not DO NOTHING) so RETURNING always yields the
        // row, which is what makes a retry idempotent rather than silent.
        const { rows } = await sql.query<{ seq: string }>(
          `INSERT INTO sync_envelopes (user_id, workspace_id, operation_id, entity_type, entity_id,
                                       operation, hlc, base_hlc, device_id, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, decode($10, 'base64'))
           ON CONFLICT (operation_id) DO UPDATE SET operation_id = EXCLUDED.operation_id
           RETURNING seq`,
          [
            scope.userId,
            scope.workspaceId,
            envelope.operationId,
            envelope.entityType,
            envelope.entityId,
            envelope.operation,
            envelope.hlc,
            envelope.baseHlc,
            envelope.deviceId,
            envelope.payload,
          ],
        )
        assigned[envelope.operationId] = Number(rows[0]?.seq)
      }

      return assigned
    },

    async listSince(scope, since, limit) {
      // A personal stream is one account's own envelopes; a workspace stream is
      // every member's, which is exactly what makes it shared.
      const { rows } = await sql.query<EnvelopeRow>(
        `SELECT * FROM sync_envelopes
         WHERE seq > $3
           AND CASE WHEN $2::uuid IS NULL
                    THEN workspace_id IS NULL AND user_id = $1
                    ELSE workspace_id = $2 END
         ORDER BY seq
         LIMIT $4`,
        [scope.userId, scope.workspaceId, since, limit],
      )
      return rows.map(toEnvelope)
    },

    async latestSeq(scope) {
      const { rows } = await sql.query<{ max: number | null }>(
        `SELECT max(seq) AS max FROM sync_envelopes
         WHERE CASE WHEN $2::uuid IS NULL
                    THEN workspace_id IS NULL AND user_id = $1
                    ELSE workspace_id = $2 END`,
        [scope.userId, scope.workspaceId],
      )
      return Number(rows[0]?.max ?? 0)
    },

    async getCursor(deviceId, workspaceId) {
      const { rows } = await sql.query<{ last_seq: number }>(
        `SELECT last_seq FROM sync_cursors
         WHERE device_id = $1 AND coalesce(workspace_id, $3::uuid) = coalesce($2::uuid, $3::uuid)`,
        [deviceId, workspaceId, NO_WORKSPACE],
      )
      return Number(rows[0]?.last_seq ?? 0)
    },

    async setCursor(scope, deviceId, seq) {
      await sql.query(
        `INSERT INTO sync_cursors (id, device_id, user_id, workspace_id, last_seq)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)
         ON CONFLICT (device_id, coalesce(workspace_id, '${NO_WORKSPACE}'::uuid)) DO UPDATE
           -- Never moves backwards: a late response must not replay envelopes.
           SET last_seq = GREATEST(sync_cursors.last_seq, EXCLUDED.last_seq),
               updated_at = now()`,
        [deviceId, scope.userId, scope.workspaceId, seq],
      )
    },
  }

  interface BackupRow {
    id: string
    user_id: string
    device_id: string
    object_key: string
    size_bytes: number
    checksum: string
    wrapped_dek: unknown
    app_version: string
    database_version: number
    backup_status: string
    email_status: string
    error_code: string | null
    created_at: string
    completed_at: string | null
    expires_at: string | null
  }

  function toBackup(row: BackupRow): BackupRecord {
    return {
      id: row.id,
      userId: row.user_id,
      deviceId: row.device_id,
      objectKey: row.object_key,
      sizeBytes: Number(row.size_bytes),
      checksum: row.checksum,
      wrappedDek: row.wrapped_dek,
      appVersion: row.app_version,
      databaseVersion: row.database_version,
      backupStatus: row.backup_status as BackupStatus,
      emailStatus: row.email_status as BackupRecord['emailStatus'],
      errorCode: row.error_code,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      expiresAt: row.expires_at,
    }
  }

  const BACKUP_UPDATABLE: Record<string, string> = {
    backupStatus: 'backup_status',
    emailStatus: 'email_status',
    errorCode: 'error_code',
    completedAt: 'completed_at',
    expiresAt: 'expires_at',
    sizeBytes: 'size_bytes',
    checksum: 'checksum',
  }

  const backups: BackupStore = {
    async create(backup) {
      const { rows } = await sql.query<BackupRow>(
        `INSERT INTO backups (id, user_id, device_id, object_key, size_bytes, checksum,
                              wrapped_dek, app_version, database_version, backup_status,
                              email_status, error_code, created_at, completed_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
          backup.id,
          backup.userId,
          backup.deviceId,
          backup.objectKey,
          backup.sizeBytes,
          backup.checksum,
          JSON.stringify(backup.wrappedDek),
          backup.appVersion,
          backup.databaseVersion,
          backup.backupStatus,
          backup.emailStatus,
          backup.errorCode,
          backup.createdAt,
          backup.completedAt,
          backup.expiresAt,
        ],
      )
      return toBackup(rows[0] as BackupRow)
    },

    async findById(id) {
      const { rows } = await sql.query<BackupRow>('SELECT * FROM backups WHERE id = $1', [id])
      return rows[0] ? toBackup(rows[0]) : null
    },

    async listForUser(userId, limit) {
      const { rows } = await sql.query<BackupRow>(
        'SELECT * FROM backups WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, limit],
      )
      return rows.map(toBackup)
    },

    async update(id, patch) {
      const assignments: string[] = []
      const values: unknown[] = [id]

      for (const [key, column] of Object.entries(BACKUP_UPDATABLE)) {
        if (!(key in patch)) continue
        values.push((patch as Record<string, unknown>)[key])
        assignments.push(`${column} = $${values.length}`)
      }

      if (assignments.length === 0) {
        const existing = await this.findById(id)
        if (!existing) throw new Error(`Unknown backup ${id}`)
        return existing
      }

      const { rows } = await sql.query<BackupRow>(
        `UPDATE backups SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      )
      if (!rows[0]) throw new Error(`Unknown backup ${id}`)
      return toBackup(rows[0])
    },

    async delete(id) {
      await sql.query('DELETE FROM backups WHERE id = $1', [id])
    },

    async listExpired(now, limit) {
      const { rows } = await sql.query<BackupRow>(
        `SELECT * FROM backups
         WHERE backup_status = 'completed' AND expires_at IS NOT NULL AND expires_at <= $1
         ORDER BY expires_at
         LIMIT $2`,
        [now, limit],
      )
      return rows.map(toBackup)
    },
  }

  const storageUsage: StorageUsageStore = {
    async find(userId) {
      const { rows } = await sql.query<{ bytes_used: number; objects: number }>(
        'SELECT bytes_used, objects FROM storage_usage WHERE user_id = $1',
        [userId],
      )
      const row = rows[0]
      return row
        ? { userId, bytesUsed: Number(row.bytes_used), objects: Number(row.objects) }
        : { userId, bytesUsed: 0, objects: 0 }
    },

    async recalculate(userId) {
      // Derived from the backups themselves: a counter that drifts is worse
      // than one that costs a query.
      const { rows } = await sql.query<{ bytes: number; objects: number }>(
        `SELECT coalesce(sum(size_bytes), 0)::bigint AS bytes, count(*)::int AS objects
         FROM backups WHERE user_id = $1 AND backup_status = 'completed'`,
        [userId],
      )
      const bytesUsed = Number(rows[0]?.bytes ?? 0)
      const objects = Number(rows[0]?.objects ?? 0)

      await sql.query(
        `INSERT INTO storage_usage (user_id, bytes_used, objects)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET bytes_used = EXCLUDED.bytes_used,
               objects = EXCLUDED.objects,
               updated_at = now()`,
        [userId, bytesUsed, objects],
      )

      return { userId, bytesUsed, objects }
    },
  }

  interface ReminderRow {
    id: string
    user_id: string
    appointment_ref: string
    fire_at: string
    kind: string
    channel: string
    state: string
    attempts: number
    last_error: string | null
    created_at: string
    sent_at: string | null
  }

  function toReminder(row: ReminderRow): ReminderScheduleRecord {
    return {
      id: row.id,
      userId: row.user_id,
      appointmentRef: row.appointment_ref,
      fireAt: row.fire_at,
      kind: row.kind as ReminderKind,
      channel: row.channel as NotificationChannel,
      state: row.state as ReminderState,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    }
  }

  const reminders: ReminderScheduleStore = {
    async replaceForRefs(userId, refs, schedules) {
      const client = await sql.connect()
      try {
        await client.query('BEGIN')
        if (refs.length > 0) {
          await client.query(
            'DELETE FROM reminder_schedules WHERE user_id = $1 AND appointment_ref = ANY($2)',
            [userId, refs],
          )
        }
        for (const schedule of schedules) {
          await client.query(
            `INSERT INTO reminder_schedules (id, user_id, appointment_ref, fire_at, kind, channel)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, appointment_ref, kind, channel) DO UPDATE
               SET fire_at = EXCLUDED.fire_at, state = 'scheduled', attempts = 0, sent_at = NULL`,
            [
              randomUUID(),
              userId,
              schedule.appointmentRef,
              schedule.fireAt,
              schedule.kind,
              schedule.channel,
            ],
          )
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    async listForUser(userId) {
      const { rows } = await sql.query<ReminderRow>(
        'SELECT * FROM reminder_schedules WHERE user_id = $1 ORDER BY fire_at',
        [userId],
      )
      return rows.map(toReminder)
    },

    async listDue(now, limit) {
      const { rows } = await sql.query<ReminderRow>(
        `SELECT * FROM reminder_schedules
         WHERE state = 'scheduled' AND fire_at <= $1
         ORDER BY fire_at
         LIMIT $2`,
        [now, limit],
      )
      return rows.map(toReminder)
    },

    async markSent(id, sentAt) {
      await sql.query(`UPDATE reminder_schedules SET state = 'sent', sent_at = $2 WHERE id = $1`, [
        id,
        sentAt,
      ])
    },

    async markFailed(id, error) {
      await sql.query(
        `UPDATE reminder_schedules
         SET state = 'failed', attempts = attempts + 1, last_error = $2
         WHERE id = $1`,
        [id, error],
      )
    },

    async deleteForRefs(userId, refs) {
      if (refs.length === 0) return
      await sql.query(
        'DELETE FROM reminder_schedules WHERE user_id = $1 AND appointment_ref = ANY($2)',
        [userId, refs],
      )
    },
  }

  const notificationPreferences: NotificationPreferenceStore = {
    async find(userId) {
      const { rows } = await sql.query<{ preferences: NotificationPreferences }>(
        'SELECT preferences FROM notification_preferences WHERE user_id = $1',
        [userId],
      )
      return rows[0]?.preferences ?? null
    },

    async put(userId, preferences) {
      await sql.query(
        `INSERT INTO notification_preferences (user_id, preferences)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET preferences = EXCLUDED.preferences, updated_at = now()`,
        [userId, JSON.stringify(preferences)],
      )
    },
  }

  interface PushRow {
    id: string
    user_id: string
    device_id: string | null
    endpoint: string
    p256dh: string
    auth: string
    created_at: string
    failed_at: string | null
  }

  const pushSubscriptions: PushSubscriptionStore = {
    async listForUser(userId) {
      const { rows } = await sql.query<PushRow>(
        'SELECT * FROM push_subscriptions WHERE user_id = $1 AND failed_at IS NULL',
        [userId],
      )
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        deviceId: row.device_id,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        createdAt: row.created_at,
        failedAt: row.failed_at,
      })) satisfies PushSubscriptionRecord[]
    },

    async upsert(subscription) {
      await sql.query(
        `INSERT INTO push_subscriptions (id, user_id, device_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (endpoint) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               device_id = EXCLUDED.device_id,
               p256dh = EXCLUDED.p256dh,
               auth = EXCLUDED.auth,
               failed_at = NULL`,
        [
          subscription.id,
          subscription.userId,
          subscription.deviceId,
          subscription.endpoint,
          subscription.p256dh,
          subscription.auth,
        ],
      )
      return subscription
    },

    async remove(endpoint) {
      await sql.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint])
    },
  }

  const billing: BillingStore = {
    async recordEvent(event) {
      // ON CONFLICT DO NOTHING: a redelivered webhook inserts nothing and
      // reports that it was already handled.
      const { rowCount } = await sql.query(
        `INSERT INTO billing_events (id, provider, external_id, type, user_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider, external_id) DO NOTHING`,
        [
          event.id,
          event.provider,
          event.externalId,
          event.type,
          event.userId,
          JSON.stringify(event.payload),
        ],
      )
      return (rowCount ?? 0) > 0
    },

    async recordCheckout(checkout) {
      await sql.query(
        `INSERT INTO billing_checkouts (id, user_id, plan_id, provider, external_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [checkout.id, checkout.userId, checkout.planId, checkout.provider, checkout.externalId],
      )
    },

    async listEvents(userId, limit) {
      const { rows } = await sql.query<{
        id: string
        provider: string
        external_id: string
        type: string
        user_id: string | null
        payload: unknown
      }>('SELECT * FROM billing_events WHERE user_id = $1 ORDER BY processed_at DESC LIMIT $2', [
        userId,
        limit,
      ])
      return rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        externalId: row.external_id,
        type: row.type,
        userId: row.user_id,
        payload: row.payload,
      })) satisfies BillingEventRecord[]
    },
  }

  interface WorkspaceRow {
    id: string
    owner_user_id: string
    name: string
    organization_id: string | null // Phase 18+: Link to billing boundary
    created_at: string
    updated_at: string
    deleted_at: string | null
  }

  const toWorkspace = (row: WorkspaceRow): WorkspaceRecord => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    organizationId: row.organization_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  })

  interface MemberRow {
    workspace_id: string
    user_id: string
    role: string
    invited_at: string
    joined_at: string | null
  }

  const toMember = (row: MemberRow): WorkspaceMemberRecord => ({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as WorkspaceRole,
    invitedAt: row.invited_at,
    joinedAt: row.joined_at,
  })

  interface InviteRow {
    id: string
    workspace_id: string
    email: string
    role: string
    token_hash: string
    invited_by: string | null
    expires_at: string
    accepted_at: string | null
    created_at: string
  }

  const toInvite = (row: InviteRow): WorkspaceInviteRecord => ({
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role as WorkspaceRole,
    tokenHash: row.token_hash,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
  })

  const workspaces: WorkspaceStore = {
    async create(workspace) {
      const { rows } = await sql.query<WorkspaceRow>(
        `INSERT INTO workspaces (id, owner_user_id, name, organization_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          workspace.id,
          workspace.ownerUserId,
          workspace.name,
          workspace.organizationId ?? null,
          workspace.createdAt,
          workspace.updatedAt,
        ],
      )
      return toWorkspace(rows[0]!)
    },

    async findById(id) {
      const { rows } = await sql.query<WorkspaceRow>(
        'SELECT * FROM workspaces WHERE id = $1 AND deleted_at IS NULL',
        [id],
      )
      return rows[0] ? toWorkspace(rows[0]) : null
    },

    async listForUser(userId) {
      const { rows } = await sql.query<WorkspaceRow & { role: string }>(
        `SELECT w.*, m.role FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_id = $1 AND w.deleted_at IS NULL
         ORDER BY w.created_at`,
        [userId],
      )
      return rows.map((row) => ({ ...toWorkspace(row), role: row.role as WorkspaceRole }))
    },

    async update(id, patch) {
      const assignments: string[] = ['updated_at = now()']
      const values: unknown[] = [id]

      if ('name' in patch) {
        values.push(patch.name)
        assignments.push(`name = $${values.length}`)
      }
      if ('organizationId' in patch) {
        values.push(patch.organizationId ?? null)
        assignments.push(`organization_id = $${values.length}`)
      }

      const { rows } = await sql.query<WorkspaceRow>(
        `UPDATE workspaces SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      )
      if (!rows[0]) throw new Error(`Unknown workspace: ${id}`)
      return toWorkspace(rows[0])
    },

    async softDelete(id, deletedAt) {
      await sql.query('UPDATE workspaces SET deleted_at = $2 WHERE id = $1', [id, deletedAt])
    },

    async listAll() {
      const { rows } = await sql.query<WorkspaceRow>(
        'SELECT * FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at ASC',
      )
      return rows.map(toWorkspace)
    },

    async listMembers(workspaceId) {
      const { rows } = await sql.query<MemberRow>(
        'SELECT * FROM workspace_members WHERE workspace_id = $1 ORDER BY invited_at',
        [workspaceId],
      )
      return rows.map(toMember)
    },

    async findMember(workspaceId, userId) {
      const { rows } = await sql.query<MemberRow>(
        'SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId],
      )
      return rows[0] ? toMember(rows[0]) : null
    },

    async countMembers(workspaceId) {
      const { rows } = await sql.query<{ count: string }>(
        'SELECT count(*) AS count FROM workspace_members WHERE workspace_id = $1',
        [workspaceId],
      )
      return Number(rows[0]?.count ?? 0)
    },

    async putMember(member) {
      const { rows } = await sql.query<MemberRow>(
        `INSERT INTO workspace_members (workspace_id, user_id, role, invited_at, joined_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, joined_at = EXCLUDED.joined_at
         RETURNING *`,
        [member.workspaceId, member.userId, member.role, member.invitedAt, member.joinedAt],
      )
      return toMember(rows[0]!)
    },

    async removeMember(workspaceId, userId) {
      await sql.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
        workspaceId,
        userId,
      ])
    },

    async createInvite(invite) {
      const { rows } = await sql.query<InviteRow>(
        `INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by,
                                        expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          invite.id,
          invite.workspaceId,
          invite.email,
          invite.role,
          invite.tokenHash,
          invite.invitedBy,
          invite.expiresAt,
          invite.createdAt,
        ],
      )
      return toInvite(rows[0]!)
    },

    async findInviteByTokenHash(hash) {
      const { rows } = await sql.query<InviteRow>(
        'SELECT * FROM workspace_invites WHERE token_hash = $1',
        [hash],
      )
      return rows[0] ? toInvite(rows[0]) : null
    },

    async listPendingInvites(workspaceId) {
      const { rows } = await sql.query<InviteRow>(
        `SELECT * FROM workspace_invites
         WHERE workspace_id = $1 AND accepted_at IS NULL
         ORDER BY created_at`,
        [workspaceId],
      )
      return rows.map(toInvite)
    },

    async markInviteAccepted(id, acceptedAt) {
      await sql.query('UPDATE workspace_invites SET accepted_at = $2 WHERE id = $1', [
        id,
        acceptedAt,
      ])
    },

    async deleteInvite(id) {
      await sql.query('DELETE FROM workspace_invites WHERE id = $1', [id])
    },
  }

  interface IdentityRow {
    user_id: string
    public_key: string
    wrapped_private_key: unknown
    created_at: string
    updated_at: string
  }

  const identityKeys: IdentityKeyStore = {
    async find(userId) {
      const { rows } = await sql.query<IdentityRow>(
        'SELECT * FROM user_identity_keys WHERE user_id = $1',
        [userId],
      )
      const row = rows[0]
      if (!row) return null
      return {
        userId: row.user_id,
        publicKey: row.public_key,
        wrappedPrivateKey: row.wrapped_private_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    },

    async findPublicKeys(userIds) {
      if (userIds.length === 0) return {}
      const { rows } = await sql.query<{ user_id: string; public_key: string }>(
        'SELECT user_id, public_key FROM user_identity_keys WHERE user_id = ANY($1::uuid[])',
        [userIds],
      )
      return Object.fromEntries(rows.map((row) => [row.user_id, row.public_key]))
    },

    async put(record) {
      await sql.query(
        `INSERT INTO user_identity_keys (user_id, public_key, wrapped_private_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET public_key = EXCLUDED.public_key,
               wrapped_private_key = EXCLUDED.wrapped_private_key,
               updated_at = now()`,
        [record.userId, record.publicKey, JSON.stringify(record.wrappedPrivateKey)],
      )
      return record
    },
  }

  const workspaceKeys: WorkspaceKeyStore = {
    async find(workspaceId, userId) {
      const { rows } = await sql.query<{
        workspace_id: string
        user_id: string
        sealed_key: unknown
        granted_by: string | null
        created_at: string
      }>('SELECT * FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2', [
        workspaceId,
        userId,
      ])
      const row = rows[0]
      if (!row) return null
      return {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        sealedKey: row.sealed_key,
        grantedBy: row.granted_by,
        createdAt: row.created_at,
      }
    },

    async listHolders(workspaceId) {
      const { rows } = await sql.query<{ user_id: string }>(
        'SELECT user_id FROM workspace_keys WHERE workspace_id = $1',
        [workspaceId],
      )
      return rows.map((row) => row.user_id)
    },

    async put(record) {
      await sql.query(
        `INSERT INTO workspace_keys (workspace_id, user_id, sealed_key, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, user_id) DO UPDATE
           SET sealed_key = EXCLUDED.sealed_key, granted_by = EXCLUDED.granted_by`,
        [record.workspaceId, record.userId, JSON.stringify(record.sealedKey), record.grantedBy],
      )
      return record
    },

    async revoke(workspaceId, userId) {
      await sql.query('DELETE FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2', [
        workspaceId,
        userId,
      ])
    },
  }

  interface AuditRow {
    id: string
    workspace_id: string | null
    user_id: string | null
    action: string
    resource_type: string | null
    resource_id: string | null
    ip: string | null
    user_agent: string | null
    created_at: string
  }

  const toAudit = (row: AuditRow): AuditEventRecord => ({
    id: String(row.id),
    workspaceId: row.workspace_id,
    userId: row.user_id,
    action: row.action as AuditAction,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  })

  const audit: AuditStore = {
    async append(events) {
      for (const event of events) {
        await sql.query(
          `INSERT INTO audit_events (workspace_id, user_id, action, resource_type, resource_id,
                                     ip, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            event.workspaceId,
            event.userId,
            event.action,
            event.resourceType,
            event.resourceId,
            event.ip,
            event.userAgent,
          ],
        )
      }
    },

    async listForWorkspace(workspaceId, { before, limit }) {
      const { rows } = await sql.query<AuditRow>(
        `SELECT * FROM audit_events
         WHERE workspace_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
         ORDER BY id DESC
         LIMIT $3`,
        [workspaceId, before ?? null, limit],
      )
      return rows.map(toAudit)
    },

    async listForUser(userId, { limit }) {
      const { rows } = await sql.query<AuditRow>(
        'SELECT * FROM audit_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
        [userId, limit],
      )
      return rows.map(toAudit)
    },
  }

  // Phase 18 P0: Organizations
  interface OrganizationRow {
    id: string
    name: string
    slug: string
    owner_user_id: string
    logo_url: string | null
    primary_color: string | null
    secondary_color: string | null
    custom_domain: string | null
    settings: unknown
    created_at: string
    updated_at: string
    deleted_at: string | null
  }

  function toOrganization(row: OrganizationRow): OrganizationRecord {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      ownerUserId: row.owner_user_id,
      logoUrl: row.logo_url,
      primaryColor: row.primary_color,
      secondaryColor: row.secondary_color,
      customDomain: row.custom_domain,
      settings: row.settings,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    }
  }

  interface OrgMemberRow {
    organization_id: string
    user_id: string
    role: string
    invited_at: string
    joined_at: string | null
  }

  function toOrgMember(row: OrgMemberRow): OrganizationMemberRecord {
    return {
      organizationId: row.organization_id,
      userId: row.user_id,
      role: row.role as OrganizationMemberRecord['role'],
      invitedAt: row.invited_at,
      joinedAt: row.joined_at,
    }
  }

  interface OrgInviteRow {
    id: string
    organization_id: string
    email: string
    role: string
    token_hash: string
    invited_by: string | null
    expires_at: string
    accepted_at: string | null
    created_at: string
  }

  function toOrgInvite(row: OrgInviteRow): OrganizationInviteRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      email: row.email,
      role: row.role as OrganizationInviteRecord['role'],
      tokenHash: row.token_hash,
      invitedBy: row.invited_by,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
    }
  }

  const organizations: OrganizationStore = {
    async create(org) {
      // Branding and settings are columns on the table and fields on the
      // record; leaving them out of the insert dropped them silently, so the
      // `personal: true` marker the user migration writes never survived.
      const { rows } = await sql.query<OrganizationRow>(
        `INSERT INTO organizations (id, name, slug, owner_user_id, logo_url, primary_color,
                                    secondary_color, custom_domain, settings, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          org.id,
          org.name,
          org.slug,
          org.ownerUserId,
          org.logoUrl ?? null,
          org.primaryColor ?? null,
          org.secondaryColor ?? null,
          org.customDomain ?? null,
          JSON.stringify(org.settings ?? {}),
          org.createdAt,
          org.updatedAt,
        ],
      )
      return toOrganization(rows[0]!)
    },

    async findById(id) {
      const { rows } = await sql.query<OrganizationRow>(
        'SELECT * FROM organizations WHERE id = $1 AND deleted_at IS NULL',
        [id],
      )
      return rows[0] ? toOrganization(rows[0]) : null
    },

    async findBySlug(slug) {
      const { rows } = await sql.query<OrganizationRow>(
        'SELECT * FROM organizations WHERE slug = $1 AND deleted_at IS NULL',
        [slug],
      )
      return rows[0] ? toOrganization(rows[0]) : null
    },

    async findByCustomDomain(domain) {
      const { rows } = await sql.query<OrganizationRow>(
        'SELECT * FROM organizations WHERE custom_domain = $1 AND deleted_at IS NULL',
        [domain],
      )
      return rows[0] ? toOrganization(rows[0]) : null
    },

    async listForUser(userId) {
      const { rows } = await sql.query<OrganizationRow>(
        `SELECT o.* FROM organizations o
         JOIN organization_members m ON m.organization_id = o.id
         WHERE m.user_id = $1 AND o.deleted_at IS NULL
         ORDER BY o.created_at`,
        [userId],
      )
      return rows.map(toOrganization)
    },

    async update(id, patch) {
      const { rows } = await sql.query<OrganizationRow>(
        `UPDATE organizations
            SET name = coalesce($2, name),
                logo_url = coalesce($3::text, logo_url),
                primary_color = coalesce($4::text, primary_color),
                secondary_color = coalesce($5::text, secondary_color),
                custom_domain = coalesce($6::text, custom_domain),
                settings = coalesce($7::jsonb, settings),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [
          id,
          patch.name ?? null,
          patch.logoUrl ?? null,
          patch.primaryColor ?? null,
          patch.secondaryColor ?? null,
          patch.customDomain ?? null,
          patch.settings ? JSON.stringify(patch.settings) : null,
        ],
      )
      if (!rows[0]) throw new Error(`Unknown organization: ${id}`)
      return toOrganization(rows[0])
    },

    async softDelete(id, deletedAt) {
      await sql.query('UPDATE organizations SET deleted_at = $2 WHERE id = $1', [id, deletedAt])
    },

    async listMembers(organizationId) {
      const { rows } = await sql.query<OrgMemberRow>(
        'SELECT * FROM organization_members WHERE organization_id = $1 ORDER BY invited_at',
        [organizationId],
      )
      return rows.map(toOrgMember)
    },

    async findMember(organizationId, userId) {
      const { rows } = await sql.query<OrgMemberRow>(
        'SELECT * FROM organization_members WHERE organization_id = $1 AND user_id = $2',
        [organizationId, userId],
      )
      return rows[0] ? toOrgMember(rows[0]) : null
    },

    async countMembers(organizationId) {
      const { rows } = await sql.query<{ count: string }>(
        'SELECT count(*) AS count FROM organization_members WHERE organization_id = $1',
        [organizationId],
      )
      return Number(rows[0]?.count ?? 0)
    },

    async putMember(member) {
      const { rows } = await sql.query<OrgMemberRow>(
        `INSERT INTO organization_members (organization_id, user_id, role, invited_at, joined_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, joined_at = EXCLUDED.joined_at
         RETURNING *`,
        [member.organizationId, member.userId, member.role, member.invitedAt, member.joinedAt],
      )
      return toOrgMember(rows[0]!)
    },

    async removeMember(organizationId, userId) {
      await sql.query(
        'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
        [organizationId, userId],
      )
    },

    async createInvite(invite) {
      const { rows } = await sql.query<OrgInviteRow>(
        `INSERT INTO organization_invites (id, organization_id, email, role, token_hash, invited_by,
                                           expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          invite.id,
          invite.organizationId,
          invite.email,
          invite.role,
          invite.tokenHash,
          invite.invitedBy,
          invite.expiresAt,
          invite.createdAt,
        ],
      )
      return toOrgInvite(rows[0]!)
    },

    async findInviteByTokenHash(hash) {
      const { rows } = await sql.query<OrgInviteRow>(
        'SELECT * FROM organization_invites WHERE token_hash = $1',
        [hash],
      )
      return rows[0] ? toOrgInvite(rows[0]) : null
    },

    async listPendingInvites(organizationId) {
      const { rows } = await sql.query<OrgInviteRow>(
        `SELECT * FROM organization_invites
         WHERE organization_id = $1 AND accepted_at IS NULL
         ORDER BY created_at`,
        [organizationId],
      )
      return rows.map(toOrgInvite)
    },

    async markInviteAccepted(id, acceptedAt) {
      await sql.query('UPDATE organization_invites SET accepted_at = $2 WHERE id = $1', [
        id,
        acceptedAt,
      ])
    },

    async deleteInvite(id) {
      await sql.query('DELETE FROM organization_invites WHERE id = $1', [id])
    },
  }

  return {
    users,
    sessions,
    devices,
    passwordResets,
    subscriptions,
    plans,
    keys,
    sync,
    backups,
    storageUsage,
    reminders,
    notificationPreferences,
    pushSubscriptions,
    billing,
    workspaces,
    organizations,
    identityKeys,
    workspaceKeys,
    audit,
  }
}

export async function createPostgresStorage(options: {
  connectionString: string
  maxConnections?: number
  migrateOnBoot?: boolean
}): Promise<Storage> {
  const sql = createPool(options)
  if (options.migrateOnBoot) await migrate(sql)

  return {
    stores: createPostgresStores(sql),
    healthy: () => checkConnection(sql),
    close: () => sql.end(),
  }
}
