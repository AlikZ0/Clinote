/**
 * Storage ports.
 *
 * Authentication logic is written against these interfaces, not against a
 * database. Phase 8 adds the PostgreSQL adapter; the auth tests then run
 * against both without a line of auth code changing
 * (docs/architecture.md §5, docs/postgres-schema.md).
 */
import type {
  AuditAction,
  NotificationChannel,
  NotificationPreferences,
  Plan,
  Platform,
  ReminderKind,
  WorkspaceRole,
} from '@clinote/types'

export interface UserRecord {
  id: string
  email: string
  passwordHash: string
  name: string | null
  locale: string | null
  timezone: string | null
  emailVerifiedAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface SessionRecord {
  id: string
  userId: string
  /** SHA-256 of the refresh token; the token itself is never stored. */
  refreshTokenHash: string
  /** Rotation chain. Reusing any token in a family revokes the whole family. */
  familyId: string
  deviceId: string | null
  ip: string | null
  userAgent: string | null
  createdAt: string
  expiresAt: string
  revokedAt: string | null
}

export interface DeviceRecord {
  id: string
  userId: string
  name: string
  platform: Platform
  lastSeen: string | null
  createdAt: string
  revokedAt: string | null
}

export interface PasswordResetRecord {
  /** SHA-256 of the emailed token. */
  tokenHash: string
  userId: string
  expiresAt: string
  usedAt: string | null
  createdAt: string
}

export interface SubscriptionRecord {
  id: string
  userId: string | null // Null in Phase 18+ (subscriptions are org-based)
  organizationId: string | null // Set in Phase 18+ (the owner of the subscription)
  planId: string
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired'
  currentPeriodEnd: string | null
}

export interface UserStore {
  findById(id: string): Promise<UserRecord | null>
  findByEmail(email: string): Promise<UserRecord | null>
  create(user: UserRecord): Promise<UserRecord>
  update(id: string, patch: Partial<UserRecord>): Promise<UserRecord>
  /** Phase 19: List all users (for migration). Optional, returns empty if not implemented. */
  listAll?(): Promise<UserRecord[]>
}

export interface SessionStore {
  create(session: SessionRecord): Promise<SessionRecord>
  findByTokenHash(hash: string): Promise<SessionRecord | null>
  revoke(id: string): Promise<void>
  /** Reuse detection: one leaked token invalidates every session in its chain. */
  revokeFamily(familyId: string): Promise<void>
  revokeAllForUser(userId: string): Promise<void>
}

export interface DeviceStore {
  listForUser(userId: string): Promise<DeviceRecord[]>
  findById(id: string): Promise<DeviceRecord | null>
  upsert(device: DeviceRecord): Promise<DeviceRecord>
  touch(id: string, lastSeen: string): Promise<void>
  revoke(id: string): Promise<void>
}

export interface PasswordResetStore {
  create(record: PasswordResetRecord): Promise<void>
  findByTokenHash(hash: string): Promise<PasswordResetRecord | null>
  markUsed(hash: string, usedAt: string): Promise<void>
  invalidateForUser(userId: string): Promise<void>
}

export interface SubscriptionStore {
  findByUserId(userId: string): Promise<SubscriptionRecord | null>
  /** One live subscription per organization (Phase 18+). */
  findByOrganizationId(organizationId: string): Promise<SubscriptionRecord | null>
  /** One live subscription per account; billing (Phase 13) writes through this. */
  upsert(subscription: SubscriptionRecord): Promise<SubscriptionRecord>
}

export interface UserKeysRecord {
  userId: string
  kdf: string
  salt: string
  iterations: number
  /** Opaque to the server: `{ iv, key }`, both base64. */
  wrappedDekSync: unknown
  wrappedDekRecovery: unknown | null
  createdAt: string
  updatedAt: string
}

export interface UserKeysStore {
  find(userId: string): Promise<UserKeysRecord | null>
  put(record: UserKeysRecord): Promise<UserKeysRecord>
}

export interface SyncEnvelopeRecord {
  seq: number
  userId: string
  /** Null for a personal stream; set for a workspace one. */
  workspaceId: string | null
  operationId: string
  entityType: string
  entityId: string
  operation: 'put' | 'delete'
  hlc: string
  baseHlc: string | null
  deviceId: string
  /** base64 ciphertext. The server never decodes it. */
  payload: string
  createdAt: string
}

/** The user id comes from the session, never from the request body. */
export type NewSyncEnvelope = Omit<
  SyncEnvelopeRecord,
  'seq' | 'createdAt' | 'userId' | 'workspaceId'
>

/**
 * Which stream a request is talking about.
 *
 * A personal stream belongs to one account. A workspace stream belongs to a
 * workspace and is shared by its members — which is why the author (`userId`)
 * and the stream are now two separate things.
 */
export interface SyncScope {
  userId: string
  workspaceId: string | null
}

export interface SyncStore {
  /**
   * Appends envelopes and returns the sequence assigned to each operation id.
   * Idempotent: an operation id that was already accepted keeps its sequence.
   */
  append(scope: SyncScope, envelopes: NewSyncEnvelope[]): Promise<Record<string, number>>
  listSince(scope: SyncScope, since: number, limit: number): Promise<SyncEnvelopeRecord[]>
  latestSeq(scope: SyncScope): Promise<number>
  getCursor(deviceId: string, workspaceId: string | null): Promise<number>
  setCursor(scope: SyncScope, deviceId: string, seq: number): Promise<void>
}

export type BackupStatus = 'pending' | 'uploading' | 'verifying' | 'completed' | 'failed'

export interface BackupRecord {
  id: string
  userId: string
  deviceId: string
  objectKey: string
  sizeBytes: number
  checksum: string
  /** Wrapped with the user's KEK; the server cannot unwrap it. */
  wrappedDek: unknown
  appVersion: string
  databaseVersion: number
  backupStatus: BackupStatus
  emailStatus: 'pending' | 'sent' | 'failed' | 'skipped'
  errorCode: string | null
  createdAt: string
  completedAt: string | null
  expiresAt: string | null
}

export interface BackupStore {
  create(backup: BackupRecord): Promise<BackupRecord>
  findById(id: string): Promise<BackupRecord | null>
  listForUser(userId: string, limit: number): Promise<BackupRecord[]>
  update(id: string, patch: Partial<BackupRecord>): Promise<BackupRecord>
  delete(id: string): Promise<void>
  /** Completed backups past their retention window. */
  listExpired(now: string, limit: number): Promise<BackupRecord[]>
}

export interface StorageUsage {
  userId: string
  bytesUsed: number
  objects: number
}

export interface StorageUsageStore {
  find(userId: string): Promise<StorageUsage>
  /** Recomputed from the backups themselves, never incremented blindly. */
  recalculate(userId: string): Promise<StorageUsage>
}

export type ReminderState = 'scheduled' | 'sent' | 'failed' | 'cancelled'

export interface ReminderScheduleRecord {
  id: string
  userId: string
  appointmentRef: string
  fireAt: string
  kind: ReminderKind
  channel: NotificationChannel
  state: ReminderState
  attempts: number
  lastError: string | null
  createdAt: string
  sentAt: string | null
}

export interface ReminderScheduleStore {
  /** Replaces every schedule for the given refs, atomically per ref. */
  replaceForRefs(
    userId: string,
    refs: string[],
    schedules: Omit<
      ReminderScheduleRecord,
      'id' | 'userId' | 'state' | 'attempts' | 'lastError' | 'createdAt' | 'sentAt'
    >[],
  ): Promise<void>
  listForUser(userId: string): Promise<ReminderScheduleRecord[]>
  /** The scheduler's only query. */
  listDue(now: string, limit: number): Promise<ReminderScheduleRecord[]>
  markSent(id: string, sentAt: string): Promise<void>
  markFailed(id: string, error: string): Promise<void>
  deleteForRefs(userId: string, refs: string[]): Promise<void>
}

export interface NotificationPreferenceStore {
  find(userId: string): Promise<NotificationPreferences | null>
  put(userId: string, preferences: NotificationPreferences): Promise<void>
}

export interface PushSubscriptionRecord {
  id: string
  userId: string
  deviceId: string | null
  endpoint: string
  p256dh: string
  auth: string
  createdAt: string
  failedAt: string | null
}

export interface PushSubscriptionStore {
  listForUser(userId: string): Promise<PushSubscriptionRecord[]>
  upsert(subscription: PushSubscriptionRecord): Promise<PushSubscriptionRecord>
  /** A gone endpoint is pruned, not retried forever. */
  remove(endpoint: string): Promise<void>
}

export interface BillingEventRecord {
  id: string
  provider: string
  externalId: string
  type: string
  userId: string | null
  payload: unknown
}

export interface BillingStore {
  /** Returns false when this event was already processed. */
  recordEvent(event: BillingEventRecord): Promise<boolean>
  recordCheckout(checkout: {
    id: string
    userId: string
    planId: string
    provider: string
    externalId: string | null
  }): Promise<void>
  listEvents(userId: string, limit: number): Promise<BillingEventRecord[]>
}

export interface WorkspaceRecord {
  id: string
  ownerUserId: string
  name: string
  organizationId: string | null // Phase 18+: Link to billing/identity boundary
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface WorkspaceMemberRecord {
  workspaceId: string
  userId: string
  role: WorkspaceRole
  invitedAt: string
  joinedAt: string | null
}

export interface WorkspaceInviteRecord {
  id: string
  workspaceId: string
  email: string
  role: WorkspaceRole
  /** SHA-256 of the emailed token. */
  tokenHash: string
  invitedBy: string | null
  expiresAt: string
  acceptedAt: string | null
  createdAt: string
}

export interface WorkspaceStore {
  create(workspace: WorkspaceRecord): Promise<WorkspaceRecord>
  findById(id: string): Promise<WorkspaceRecord | null>
  /** Every workspace the user is a member of, with their role in each. */
  listForUser(userId: string): Promise<(WorkspaceRecord & { role: WorkspaceRole })[]>
  /** Phase 19: List all workspaces (for migration). Optional, returns empty if not implemented. */
  listAll?(): Promise<WorkspaceRecord[]>
  update(id: string, patch: Partial<WorkspaceRecord>): Promise<WorkspaceRecord>
  softDelete(id: string, deletedAt: string): Promise<void>

  listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]>
  findMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null>
  countMembers(workspaceId: string): Promise<number>
  putMember(member: WorkspaceMemberRecord): Promise<WorkspaceMemberRecord>
  removeMember(workspaceId: string, userId: string): Promise<void>

  createInvite(invite: WorkspaceInviteRecord): Promise<WorkspaceInviteRecord>
  findInviteByTokenHash(hash: string): Promise<WorkspaceInviteRecord | null>
  listPendingInvites(workspaceId: string): Promise<WorkspaceInviteRecord[]>
  markInviteAccepted(id: string, acceptedAt: string): Promise<void>
  deleteInvite(id: string): Promise<void>
}

export interface IdentityKeyRecord {
  userId: string
  /** base64 SPKI. Handed to other members so they can seal a key to it. */
  publicKey: string
  /** Wrapped with the account data key; opaque here. */
  wrappedPrivateKey: unknown
  createdAt: string
  updatedAt: string
}

export interface WorkspaceKeyRecord {
  workspaceId: string
  userId: string
  /** The workspace key sealed to this member. Opaque to the server. */
  sealedKey: unknown
  grantedBy: string | null
  createdAt: string
}

export interface IdentityKeyStore {
  find(userId: string): Promise<IdentityKeyRecord | null>
  findPublicKeys(userIds: string[]): Promise<Record<string, string>>
  put(record: IdentityKeyRecord): Promise<IdentityKeyRecord>
}

export interface WorkspaceKeyStore {
  find(workspaceId: string, userId: string): Promise<WorkspaceKeyRecord | null>
  /** Who already holds the key — the members an admin does not need to grant. */
  listHolders(workspaceId: string): Promise<string[]>
  put(record: WorkspaceKeyRecord): Promise<WorkspaceKeyRecord>
  revoke(workspaceId: string, userId: string): Promise<void>
}

export interface AuditEventRecord {
  id: string
  workspaceId: string | null
  userId: string | null
  action: AuditAction
  resourceType: string | null
  resourceId: string | null
  ip: string | null
  userAgent: string | null
  createdAt: string
}

export type NewAuditEvent = Omit<AuditEventRecord, 'id' | 'createdAt'>

export interface AuditStore {
  /** Append-only. There is deliberately no update and no delete. */
  append(events: NewAuditEvent[]): Promise<void>
  listForWorkspace(
    workspaceId: string,
    options: { before?: string; limit: number },
  ): Promise<AuditEventRecord[]>
  listForUser(userId: string, options: { limit: number }): Promise<AuditEventRecord[]>
}

export interface PlanStore {
  /** The catalog as served by `GET /plans`; prices are data, not constants. */
  listPublic(): Promise<Plan[]>
  findById(id: string): Promise<Plan | null>
}

/**
 * Organizations: Phase 18 P0 (docs/architecture.md).
 * The billing and identity boundary, containing workspaces (data boundary).
 */

export interface OrganizationRecord {
  id: string
  name: string
  slug: string
  ownerUserId: string
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  customDomain: string | null
  settings: unknown // jsonb in DB
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface OrganizationMemberRecord {
  organizationId: string
  userId: string
  role: 'owner' | 'admin' | 'billing'
  invitedAt: string
  joinedAt: string | null
}

export interface OrganizationInviteRecord {
  id: string
  organizationId: string
  email: string
  role: 'owner' | 'admin' | 'billing'
  tokenHash: string
  invitedBy: string | null
  expiresAt: string
  acceptedAt: string | null
  createdAt: string
}

export interface OrganizationStore {
  create(org: OrganizationRecord): Promise<OrganizationRecord>
  findById(id: string): Promise<OrganizationRecord | null>
  findBySlug(slug: string): Promise<OrganizationRecord | null>
  findByCustomDomain(domain: string): Promise<OrganizationRecord | null>
  /** Every organization the user belongs to or owns. */
  listForUser(userId: string): Promise<OrganizationRecord[]>
  update(id: string, patch: Partial<OrganizationRecord>): Promise<OrganizationRecord>
  softDelete(id: string, deletedAt: string): Promise<void>

  listMembers(organizationId: string): Promise<OrganizationMemberRecord[]>
  findMember(organizationId: string, userId: string): Promise<OrganizationMemberRecord | null>
  countMembers(organizationId: string): Promise<number>
  putMember(member: OrganizationMemberRecord): Promise<OrganizationMemberRecord>
  removeMember(organizationId: string, userId: string): Promise<void>

  createInvite(invite: OrganizationInviteRecord): Promise<OrganizationInviteRecord>
  findInviteByTokenHash(hash: string): Promise<OrganizationInviteRecord | null>
  listPendingInvites(organizationId: string): Promise<OrganizationInviteRecord[]>
  markInviteAccepted(id: string, acceptedAt: string): Promise<void>
  deleteInvite(id: string): Promise<void>
}

export interface Stores {
  users: UserStore
  sessions: SessionStore
  devices: DeviceStore
  passwordResets: PasswordResetStore
  subscriptions: SubscriptionStore
  plans: PlanStore
  keys: UserKeysStore
  sync: SyncStore
  backups: BackupStore
  storageUsage: StorageUsageStore
  reminders: ReminderScheduleStore
  notificationPreferences: NotificationPreferenceStore
  pushSubscriptions: PushSubscriptionStore
  billing: BillingStore
  workspaces: WorkspaceStore
  organizations: OrganizationStore // Phase 18 P0: Multi-tenant billing boundary
  identityKeys: IdentityKeyStore
  workspaceKeys: WorkspaceKeyStore
  audit: AuditStore
}

/**
 * A storage backend plus its lifecycle. Ports stay free of connection concerns;
 * this is where they live.
 */
export interface Storage {
  stores: Stores
  /** Used by the readiness probe: a failing dependency must not read as ready. */
  healthy(): Promise<boolean>
  close(): Promise<void>
}
