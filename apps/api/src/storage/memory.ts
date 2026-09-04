/**
 * In-memory adapter.
 *
 * For development and tests only. The API refuses to start with this driver in
 * production (see `createStores`), because losing every account on restart is
 * not a failure mode worth risking on a typo.
 */
import { DEFAULT_PLANS, findPlan } from '@clinote/config'
import type { NotificationPreferences } from '@clinote/types'
import { randomUUID } from 'node:crypto'
import type {
  BackupRecord,
  BackupStore,
  BillingEventRecord,
  BillingStore,
  NotificationPreferenceStore,
  PushSubscriptionRecord,
  PushSubscriptionStore,
  ReminderScheduleRecord,
  ReminderScheduleStore,
  DeviceRecord,
  DeviceStore,
  PasswordResetRecord,
  PasswordResetStore,
  SessionRecord,
  SessionStore,
  Stores,
  SubscriptionRecord,
  PlanStore,
  Storage,
  StorageUsage,
  StorageUsageStore,
  AuditEventRecord,
  AuditStore,
  IdentityKeyRecord,
  IdentityKeyStore,
  SyncEnvelopeRecord,
  SyncStore,
  WorkspaceInviteRecord,
  WorkspaceKeyRecord,
  WorkspaceKeyStore,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceStore,
  SubscriptionStore,
  UserKeysRecord,
  UserKeysStore,
  UserRecord,
  UserStore,
  OrganizationRecord,
  OrganizationMemberRecord,
  OrganizationInviteRecord,
  OrganizationStore,
} from './ports'

export function createMemoryStores(): Stores {
  const users = new Map<string, UserRecord>()
  const sessions = new Map<string, SessionRecord>()
  const devices = new Map<string, DeviceRecord>()
  const resets = new Map<string, PasswordResetRecord>()
  const subscriptions = new Map<string, SubscriptionRecord>()

  const userStore: UserStore = {
    async findById(id) {
      const user = users.get(id)
      return user && !user.deletedAt ? { ...user } : null
    },
    async findByEmail(email) {
      for (const user of users.values()) {
        if (user.email === email.toLowerCase() && !user.deletedAt) return { ...user }
      }
      return null
    },
    async create(user) {
      users.set(user.id, { ...user })
      return { ...user }
    },
    async update(id, patch) {
      const current = users.get(id)
      if (!current) throw new Error(`Unknown user ${id}`)
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
      users.set(id, next)
      return { ...next }
    },
    async listAll() {
      return [...users.values()].filter((u) => !u.deletedAt).map((u) => ({ ...u }))
    },
  }

  const sessionStore: SessionStore = {
    async create(session) {
      sessions.set(session.id, { ...session })
      return { ...session }
    },
    async findByTokenHash(hash) {
      for (const session of sessions.values()) {
        if (session.refreshTokenHash === hash) return { ...session }
      }
      return null
    },
    async revoke(id) {
      const session = sessions.get(id)
      if (session && !session.revokedAt) {
        sessions.set(id, { ...session, revokedAt: new Date().toISOString() })
      }
    },
    async revokeFamily(familyId) {
      const now = new Date().toISOString()
      for (const [id, session] of sessions) {
        if (session.familyId === familyId && !session.revokedAt) {
          sessions.set(id, { ...session, revokedAt: now })
        }
      }
    },
    async revokeAllForUser(userId) {
      const now = new Date().toISOString()
      for (const [id, session] of sessions) {
        if (session.userId === userId && !session.revokedAt) {
          sessions.set(id, { ...session, revokedAt: now })
        }
      }
    },
  }

  const deviceStore: DeviceStore = {
    async listForUser(userId) {
      return [...devices.values()]
        .filter((device) => device.userId === userId && !device.revokedAt)
        .map((device) => ({ ...device }))
    },
    async findById(id) {
      const device = devices.get(id)
      return device ? { ...device } : null
    },
    async upsert(device) {
      const existing = devices.get(device.id)
      const next = existing ? { ...existing, ...device, revokedAt: null } : { ...device }
      devices.set(device.id, next)
      return { ...next }
    },
    async touch(id, lastSeen) {
      const device = devices.get(id)
      if (device) devices.set(id, { ...device, lastSeen })
    },
    async revoke(id) {
      const device = devices.get(id)
      if (device) devices.set(id, { ...device, revokedAt: new Date().toISOString() })
    },
  }

  const resetStore: PasswordResetStore = {
    async create(record) {
      resets.set(record.tokenHash, { ...record })
    },
    async findByTokenHash(hash) {
      const record = resets.get(hash)
      return record ? { ...record } : null
    },
    async markUsed(hash, usedAt) {
      const record = resets.get(hash)
      if (record) resets.set(hash, { ...record, usedAt })
    },
    async invalidateForUser(userId) {
      for (const [hash, record] of resets) {
        if (record.userId === userId) resets.delete(hash)
      }
    },
  }

  const subscriptionsByOrg = new Map<string, SubscriptionRecord>() // Phase 18: Org-based subscriptions
  const subscriptionStore: SubscriptionStore = {
    async findByUserId(userId) {
      const subscription = subscriptions.get(userId)
      return subscription ? { ...subscription } : null
    },
    async findByOrganizationId(organizationId) {
      const subscription = subscriptionsByOrg.get(organizationId)
      return subscription ? { ...subscription } : null
    },
    async upsert(subscription) {
      // Store by both userId (legacy) and organizationId (Phase 18+)
      if (subscription.userId) {
        subscriptions.set(subscription.userId, { ...subscription })
      }
      if (subscription.organizationId) {
        subscriptionsByOrg.set(subscription.organizationId, { ...subscription })
      }
      return { ...subscription }
    },
  }

  const planStore: PlanStore = {
    async listPublic() {
      return DEFAULT_PLANS.filter((plan) => plan.isPublic).sort((a, b) => a.sortOrder - b.sortOrder)
    },
    async findById(id) {
      return findPlan(DEFAULT_PLANS, id) ?? null
    },
  }

  const keys = new Map<string, UserKeysRecord>()
  const keysStore: UserKeysStore = {
    async find(userId) {
      const record = keys.get(userId)
      return record ? { ...record } : null
    },
    async put(record) {
      keys.set(record.userId, { ...record })
      return { ...record }
    },
  }

  const envelopes: SyncEnvelopeRecord[] = []
  const cursors = new Map<string, number>()
  /** Two envelopes are in the same stream when they carry the same scope. */
  const inScope = (
    row: SyncEnvelopeRecord,
    scope: { userId: string; workspaceId: string | null },
  ) =>
    scope.workspaceId === null
      ? row.workspaceId === null && row.userId === scope.userId
      : row.workspaceId === scope.workspaceId

  const cursorKey = (deviceId: string, workspaceId: string | null) =>
    `${deviceId}:${workspaceId ?? ''}`

  const syncStore: SyncStore = {
    async append(scope, incoming) {
      const assigned: Record<string, number> = {}

      for (const envelope of incoming) {
        const existing = envelopes.find((row) => row.operationId === envelope.operationId)
        if (existing) {
          // Idempotent: a retry keeps the sequence it was already given.
          assigned[envelope.operationId] = existing.seq
          continue
        }

        const record: SyncEnvelopeRecord = {
          ...envelope,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          seq: envelopes.length + 1,
          createdAt: new Date().toISOString(),
        }
        envelopes.push(record)
        assigned[envelope.operationId] = record.seq
      }

      return assigned
    },

    async listSince(scope, since, limit) {
      return envelopes
        .filter((row) => inScope(row, scope) && row.seq > since)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((row) => ({ ...row }))
    },

    async latestSeq(scope) {
      return envelopes.reduce((max, row) => (inScope(row, scope) ? Math.max(max, row.seq) : max), 0)
    },

    async getCursor(deviceId, workspaceId) {
      return cursors.get(cursorKey(deviceId, workspaceId)) ?? 0
    },

    async setCursor(scope, deviceId, seq) {
      const key = cursorKey(deviceId, scope.workspaceId)
      cursors.set(key, Math.max(seq, cursors.get(key) ?? 0))
    },
  }

  const backups = new Map<string, BackupRecord>()
  const backupStore: BackupStore = {
    async create(backup) {
      backups.set(backup.id, { ...backup })
      return { ...backup }
    },
    async findById(id) {
      const backup = backups.get(id)
      return backup ? { ...backup } : null
    },
    async listForUser(userId, limit) {
      return [...backups.values()]
        .filter((backup) => backup.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((backup) => ({ ...backup }))
    },
    async update(id, patch) {
      const current = backups.get(id)
      if (!current) throw new Error(`Unknown backup ${id}`)
      const next = { ...current, ...patch }
      backups.set(id, next)
      return { ...next }
    },
    async delete(id) {
      backups.delete(id)
    },
    async listExpired(now, limit) {
      return [...backups.values()]
        .filter(
          (backup) =>
            backup.backupStatus === 'completed' &&
            backup.expiresAt !== null &&
            backup.expiresAt <= now,
        )
        .slice(0, limit)
        .map((backup) => ({ ...backup }))
    },
  }

  const usageStore: StorageUsageStore = {
    async find(userId) {
      return usageFor(userId)
    },
    async recalculate(userId) {
      return usageFor(userId)
    },
  }

  function usageFor(userId: string): StorageUsage {
    const completed = [...backups.values()].filter(
      (backup) => backup.userId === userId && backup.backupStatus === 'completed',
    )
    return {
      userId,
      bytesUsed: completed.reduce((sum, backup) => sum + backup.sizeBytes, 0),
      objects: completed.length,
    }
  }

  let reminders: ReminderScheduleRecord[] = []
  const reminderStore: ReminderScheduleStore = {
    async replaceForRefs(userId, refs, schedules) {
      reminders = reminders.filter(
        (row) => !(row.userId === userId && refs.includes(row.appointmentRef)),
      )
      for (const schedule of schedules) {
        reminders.push({
          ...schedule,
          id: randomUUID(),
          userId,
          state: 'scheduled',
          attempts: 0,
          lastError: null,
          createdAt: new Date().toISOString(),
          sentAt: null,
        })
      }
    },
    async listForUser(userId) {
      return reminders.filter((row) => row.userId === userId).map((row) => ({ ...row }))
    },
    async listDue(now, limit) {
      return reminders
        .filter((row) => row.state === 'scheduled' && row.fireAt <= now)
        .sort((a, b) => a.fireAt.localeCompare(b.fireAt))
        .slice(0, limit)
        .map((row) => ({ ...row }))
    },
    async markSent(id, sentAt) {
      const row = reminders.find((item) => item.id === id)
      if (row) Object.assign(row, { state: 'sent', sentAt })
    },
    async markFailed(id, error) {
      const row = reminders.find((item) => item.id === id)
      if (row) Object.assign(row, { state: 'failed', attempts: row.attempts + 1, lastError: error })
    },
    async deleteForRefs(userId, refs) {
      reminders = reminders.filter(
        (row) => !(row.userId === userId && refs.includes(row.appointmentRef)),
      )
    },
  }

  const preferences = new Map<string, NotificationPreferences>()
  const preferenceStore: NotificationPreferenceStore = {
    async find(userId) {
      return preferences.get(userId) ?? null
    },
    async put(userId, value) {
      preferences.set(userId, value)
    },
  }

  const subscriptions_ = new Map<string, PushSubscriptionRecord>()
  const pushStore: PushSubscriptionStore = {
    async listForUser(userId) {
      return [...subscriptions_.values()]
        .filter((row) => row.userId === userId && !row.failedAt)
        .map((row) => ({ ...row }))
    },
    async upsert(subscription) {
      subscriptions_.set(subscription.endpoint, { ...subscription })
      return { ...subscription }
    },
    async remove(endpoint) {
      subscriptions_.delete(endpoint)
    },
  }

  const billingEvents: BillingEventRecord[] = []
  const checkouts: { id: string; userId: string; planId: string }[] = []
  const billingStore: BillingStore = {
    async recordEvent(event) {
      const seen = billingEvents.some(
        (row) => row.provider === event.provider && row.externalId === event.externalId,
      )
      if (seen) return false
      billingEvents.push({ ...event })
      return true
    },
    async recordCheckout(checkout) {
      checkouts.push({ id: checkout.id, userId: checkout.userId, planId: checkout.planId })
    },
    async listEvents(userId, limit) {
      return billingEvents
        .filter((row) => row.userId === userId)
        .slice(-limit)
        .map((row) => ({ ...row }))
    },
  }

  const workspaces = new Map<string, WorkspaceRecord>()
  const members = new Map<string, WorkspaceMemberRecord>()
  const invites = new Map<string, WorkspaceInviteRecord>()
  const memberKey = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`

  const workspaceStore: WorkspaceStore = {
    async create(workspace) {
      workspaces.set(workspace.id, { ...workspace })
      return { ...workspace }
    },

    async findById(id) {
      const found = workspaces.get(id)
      return found && !found.deletedAt ? { ...found } : null
    },

    async listForUser(userId) {
      return [...members.values()]
        .filter((member) => member.userId === userId)
        .flatMap((member) => {
          const workspace = workspaces.get(member.workspaceId)
          if (!workspace || workspace.deletedAt) return []
          return [{ ...workspace, role: member.role }]
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    async update(id, patch) {
      const current = workspaces.get(id)
      if (!current) throw new Error(`Unknown workspace: ${id}`)
      const next = { ...current, ...patch }
      workspaces.set(id, next)
      return { ...next }
    },

    async softDelete(id, deletedAt) {
      const current = workspaces.get(id)
      if (current) workspaces.set(id, { ...current, deletedAt })
    },

    async listAll() {
      return [...workspaces.values()].filter((w) => !w.deletedAt).map((w) => ({ ...w }))
    },

    async listMembers(workspaceId) {
      return [...members.values()]
        .filter((member) => member.workspaceId === workspaceId)
        .map((member) => ({ ...member }))
    },

    async findMember(workspaceId, userId) {
      const found = members.get(memberKey(workspaceId, userId))
      return found ? { ...found } : null
    },

    async countMembers(workspaceId) {
      return [...members.values()].filter((member) => member.workspaceId === workspaceId).length
    },

    async putMember(member) {
      members.set(memberKey(member.workspaceId, member.userId), { ...member })
      return { ...member }
    },

    async removeMember(workspaceId, userId) {
      members.delete(memberKey(workspaceId, userId))
    },

    async createInvite(invite) {
      invites.set(invite.id, { ...invite })
      return { ...invite }
    },

    async findInviteByTokenHash(hash) {
      for (const invite of invites.values()) {
        if (invite.tokenHash === hash) return { ...invite }
      }
      return null
    },

    async listPendingInvites(workspaceId) {
      return [...invites.values()]
        .filter((invite) => invite.workspaceId === workspaceId && !invite.acceptedAt)
        .map((invite) => ({ ...invite }))
    },

    async markInviteAccepted(id, acceptedAt) {
      const current = invites.get(id)
      if (current) invites.set(id, { ...current, acceptedAt })
    },

    async deleteInvite(id) {
      invites.delete(id)
    },
  }

  const identities = new Map<string, IdentityKeyRecord>()
  const identityKeyStore: IdentityKeyStore = {
    async find(userId) {
      const found = identities.get(userId)
      return found ? { ...found } : null
    },

    async findPublicKeys(userIds) {
      const out: Record<string, string> = {}
      for (const userId of userIds) {
        const found = identities.get(userId)
        if (found) out[userId] = found.publicKey
      }
      return out
    },

    async put(record) {
      identities.set(record.userId, { ...record })
      return { ...record }
    },
  }

  const workspaceKeys = new Map<string, WorkspaceKeyRecord>()
  const workspaceKeyStore: WorkspaceKeyStore = {
    async find(workspaceId, userId) {
      const found = workspaceKeys.get(memberKey(workspaceId, userId))
      return found ? { ...found } : null
    },

    async listHolders(workspaceId) {
      return [...workspaceKeys.values()]
        .filter((row) => row.workspaceId === workspaceId)
        .map((row) => row.userId)
    },

    async put(record) {
      workspaceKeys.set(memberKey(record.workspaceId, record.userId), { ...record })
      return { ...record }
    },

    async revoke(workspaceId, userId) {
      workspaceKeys.delete(memberKey(workspaceId, userId))
    },
  }

  const auditEvents: AuditEventRecord[] = []
  const auditStore: AuditStore = {
    async append(events) {
      for (const event of events) {
        auditEvents.push({
          ...event,
          id: String(auditEvents.length + 1),
          createdAt: new Date().toISOString(),
        })
      }
    },

    async listForWorkspace(workspaceId, { before, limit }) {
      return auditEvents
        .filter((row) => row.workspaceId === workspaceId && (!before || row.id < before))
        .slice(-limit)
        .reverse()
        .map((row) => ({ ...row }))
    },

    async listForUser(userId, { limit }) {
      return auditEvents
        .filter((row) => row.userId === userId)
        .slice(-limit)
        .reverse()
        .map((row) => ({ ...row }))
    },
  }

  // Phase 18 P0: Organizations
  const organizations = new Map<string, OrganizationRecord>()
  const orgMembers = new Map<string, OrganizationMemberRecord>()
  const orgInvites = new Map<string, OrganizationInviteRecord>()
  const orgMemberKey = (orgId: string, userId: string) => `${orgId}:${userId}`

  const organizationStore: OrganizationStore = {
    async create(org) {
      organizations.set(org.id, { ...org })
      return { ...org }
    },

    async findById(id) {
      const found = organizations.get(id)
      return found && !found.deletedAt ? { ...found } : null
    },

    async findBySlug(slug) {
      for (const org of organizations.values()) {
        if (org.slug === slug && !org.deletedAt) return { ...org }
      }
      return null
    },

    async findByCustomDomain(domain) {
      for (const org of organizations.values()) {
        if (org.customDomain === domain && !org.deletedAt) return { ...org }
      }
      return null
    },

    async listForUser(userId) {
      return [...orgMembers.values()]
        .filter((member) => member.userId === userId)
        .flatMap((member) => {
          const org = organizations.get(member.organizationId)
          if (!org || org.deletedAt) return []
          return [{ ...org }]
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    async update(id, patch) {
      const current = organizations.get(id)
      if (!current) throw new Error(`Unknown organization: ${id}`)
      const next = { ...current, ...patch }
      organizations.set(id, next)
      return { ...next }
    },

    async softDelete(id, deletedAt) {
      const current = organizations.get(id)
      if (current) organizations.set(id, { ...current, deletedAt })
    },

    async listMembers(organizationId) {
      return [...orgMembers.values()]
        .filter((member) => member.organizationId === organizationId)
        .map((member) => ({ ...member }))
    },

    async findMember(organizationId, userId) {
      const found = orgMembers.get(orgMemberKey(organizationId, userId))
      return found ? { ...found } : null
    },

    async countMembers(organizationId) {
      return [...orgMembers.values()].filter((member) => member.organizationId === organizationId).length
    },

    async putMember(member) {
      orgMembers.set(orgMemberKey(member.organizationId, member.userId), { ...member })
      return { ...member }
    },

    async removeMember(organizationId, userId) {
      orgMembers.delete(orgMemberKey(organizationId, userId))
    },

    async createInvite(invite) {
      orgInvites.set(invite.id, { ...invite })
      return { ...invite }
    },

    async findInviteByTokenHash(hash) {
      for (const invite of orgInvites.values()) {
        if (invite.tokenHash === hash) return { ...invite }
      }
      return null
    },

    async listPendingInvites(organizationId) {
      return [...orgInvites.values()]
        .filter((invite) => invite.organizationId === organizationId && !invite.acceptedAt)
        .map((invite) => ({ ...invite }))
    },

    async markInviteAccepted(id, acceptedAt) {
      const current = orgInvites.get(id)
      if (current) orgInvites.set(id, { ...current, acceptedAt })
    },

    async deleteInvite(id) {
      orgInvites.delete(id)
    },
  }

  return {
    users: userStore,
    sessions: sessionStore,
    devices: deviceStore,
    passwordResets: resetStore,
    subscriptions: subscriptionStore,
    plans: planStore,
    keys: keysStore,
    sync: syncStore,
    backups: backupStore,
    storageUsage: usageStore,
    reminders: reminderStore,
    notificationPreferences: preferenceStore,
    pushSubscriptions: pushStore,
    billing: billingStore,
    workspaces: workspaceStore,
    organizations: organizationStore,
    identityKeys: identityKeyStore,
    workspaceKeys: workspaceKeyStore,
    audit: auditStore,
  }
}

export function createMemoryStorage(): Storage {
  return {
    stores: createMemoryStores(),
    healthy: async () => true,
    close: async () => undefined,
  }
}
