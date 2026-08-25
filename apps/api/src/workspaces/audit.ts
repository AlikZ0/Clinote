/**
 * The audit log (product spec §43, docs/security.md §11).
 *
 * Two kinds of entry end up here, and both are deliberately thin:
 *
 *   - account and workspace actions the server performs itself — a sign-in, an
 *     invitation, a role change;
 *   - data actions, *derived from the sync envelopes the server already
 *     relays*. That derivation is the whole point: the log can say "Anna
 *     created a client at 14:02" without the server ever learning who that
 *     client is, and without the device disclosing anything new to say it.
 *
 * There is no column for content and no code path that would produce one.
 */
import type { AuditAction } from '@clinote/types'
import type { FastifyRequest } from 'fastify'
import type { NewAuditEvent, NewSyncEnvelope, Stores } from '../storage'

export interface AuditContext {
  workspaceId: string | null
  userId: string | null
  resourceType?: string | null
  resourceId?: string | null
}

function requestMetadata(request: FastifyRequest): { ip: string | null; userAgent: string | null } {
  const agent = request.headers['user-agent']
  return {
    ip: request.ip || null,
    // Truncated: a user agent is diagnostic, not an essay.
    userAgent: typeof agent === 'string' ? agent.slice(0, 255) : null,
  }
}

export async function recordAudit(
  stores: Stores,
  request: FastifyRequest,
  action: AuditAction,
  context: AuditContext,
): Promise<void> {
  const event: NewAuditEvent = {
    workspaceId: context.workspaceId,
    userId: context.userId,
    action,
    resourceType: context.resourceType ?? null,
    resourceId: context.resourceId ?? null,
    ...requestMetadata(request),
  }

  try {
    await stores.audit.append([event])
  } catch {
    // An audit write must never break the action it describes. Losing one
    // entry is bad; failing a sign-in because the log is full is worse.
  }
}

/**
 * The action an envelope implies.
 *
 * `baseHlc === null` means the sender had no previous version of this record,
 * which is precisely what a creation is. Everything else is a change.
 */
export function actionForEnvelope(envelope: NewSyncEnvelope): AuditAction | null {
  if (envelope.entityType === 'client') {
    if (envelope.operation === 'delete') return 'CLIENT_DELETED'
    return envelope.baseHlc === null ? 'CLIENT_CREATED' : 'CLIENT_UPDATED'
  }

  // Only creations are logged for the rest: an audit log that records every
  // keystroke-level update to a work item is noise, and noise gets ignored.
  if (envelope.baseHlc !== null || envelope.operation === 'delete') return null

  switch (envelope.entityType) {
    case 'work':
      return 'WORK_CREATED'
    case 'file':
      return 'FILE_ADDED'
    case 'appointment':
      return 'APPOINTMENT_CREATED'
    default:
      return null
  }
}

/**
 * Records a sign-in for every workspace this person belongs to.
 *
 * Once per workspace, rather than once per account: the log exists so that a
 * practice can see who reached its records, and an account with no colleagues
 * has nobody to be accountable to. It also keeps one clinic from learning that
 * a member signed in to work somewhere else.
 */
export async function recordSignIn(
  stores: Stores,
  request: FastifyRequest,
  userId: string,
): Promise<void> {
  try {
    const workspaces = await stores.workspaces.listForUser(userId)
    if (workspaces.length === 0) return

    const metadata = requestMetadata(request)
    await stores.audit.append(
      workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        userId,
        action: 'LOGIN' as const,
        resourceType: null,
        resourceId: null,
        ...metadata,
      })),
    )
  } catch {
    // Never at the cost of the sign-in itself.
  }
}

/** Turns one accepted push into its audit entries. Workspace streams only. */
export async function recordSyncAudit(
  stores: Stores,
  request: FastifyRequest,
  scope: { userId: string; workspaceId: string | null },
  envelopes: NewSyncEnvelope[],
): Promise<void> {
  if (!scope.workspaceId) return

  const metadata = requestMetadata(request)
  const events: NewAuditEvent[] = []

  for (const envelope of envelopes) {
    const action = actionForEnvelope(envelope)
    if (!action) continue
    events.push({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      action,
      resourceType: envelope.entityType,
      resourceId: envelope.entityId,
      ...metadata,
    })
  }

  if (events.length === 0) return

  try {
    await stores.audit.append(events)
  } catch {
    // As above: the sync push has already been accepted and must stand.
  }
}
