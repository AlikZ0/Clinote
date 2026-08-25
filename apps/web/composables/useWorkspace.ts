/**
 * Workspaces on this device (product spec §41–§44, docs/encryption.md §9).
 *
 * Three things live here and nowhere else:
 *
 *  - which dataset is open, and the switch that closes one local database and
 *    opens another;
 *  - the workspace key: fetched sealed, opened with this device's identity key,
 *    then kept in the workspace's own database so a reload does not need a
 *    colleague to be online;
 *  - what this member is allowed to do, which the UI reads to decide what to
 *    show. The server checks it again regardless — this is UX, not security.
 */
import { AppError } from '@clinote/shared'
import { can, type Permission, type WorkspaceRole, type AuditEvent } from '@clinote/types'
import { openSealedKey, sealKeyForMember, type SealedKey } from '@clinote/crypto'
import { activeWorkspaceId, getLocalCore, switchWorkspace } from '~/database'
import { createWorkspaceCipher, type EnvelopeCipher } from '~/services/encryption'

export interface WorkspaceSummary {
  id: string
  name: string
  role: WorkspaceRole
  memberCount: number
  createdAt: string
}

export interface WorkspaceMemberView {
  userId: string
  email: string | null
  name: string | null
  role: WorkspaceRole
  joinedAt: string | null
  hasKey: boolean
}

export interface PendingGrant {
  userId: string
  email: string | null
  role: WorkspaceRole
  publicKey: string | null
}

/** Where the local key stands. "awaiting" is a normal state, not a failure. */
export type WorkspaceKeyState = 'none' | 'awaiting' | 'ready'

const WORKSPACE_KEY_ROW = 'workspace-dek'

/** In memory for the lifetime of the tab, like every other opened key. */
let workspaceCipher: EnvelopeCipher | null = null
let workspaceKey: CryptoKey | null = null
let cipherFor: string | null = null

export function useWorkspace() {
  const workspaces = useState<WorkspaceSummary[]>('workspace.list', () => [])
  const activeId = useState<string | null>('workspace.active', () => null)
  const keyState = useState<WorkspaceKeyState>('workspace.keyState', () => 'none')
  const busy = useState('workspace.busy', () => false)
  const errorMessage = useState<string | null>('workspace.error', () => null)

  const api = useApi()
  const encryption = useEncryption()
  const { canUse } = useFeatureAccess()

  const active = computed(
    () => workspaces.value.find((workspace) => workspace.id === activeId.value) ?? null,
  )

  const role = computed<WorkspaceRole | null>(() => active.value?.role ?? null)

  /** What this member may do here. Personal data has no roles, so all of it. */
  function allows(permission: Permission): boolean {
    if (!activeId.value) return true
    return role.value !== null && can(role.value, permission)
  }

  async function refresh(): Promise<void> {
    activeId.value = activeWorkspaceId()
    if (!isAuthenticatedNow()) {
      workspaces.value = []
      return
    }

    try {
      const result = await api.request<{ workspaces: WorkspaceSummary[] }>('/workspaces')
      workspaces.value = result.workspaces

      // A workspace this device was left in but is no longer a member of: fall
      // back to the personal dataset rather than showing an empty screen.
      if (activeId.value && !result.workspaces.some((item) => item.id === activeId.value)) {
        await open(null)
      }
    } catch {
      // Offline is not an error here: the local database is already open, and
      // the list is only needed to switch away from it.
    }
  }

  function isAuthenticatedNow(): boolean {
    return useAuth().isAuthenticated.value
  }

  /** Opens a dataset and makes sure this device can read it. */
  async function open(workspaceId: string | null): Promise<void> {
    busy.value = true
    errorMessage.value = null
    try {
      await switchWorkspace(workspaceId)
      activeId.value = workspaceId
      workspaceCipher = null
      workspaceKey = null
      cipherFor = null
      await loadKey()
    } catch (error) {
      errorMessage.value = describeError(error)
    } finally {
      busy.value = false
    }
  }

  /**
   * Gets the workspace key for the open workspace.
   *
   * The stored copy comes first, so a device that has already been granted
   * access keeps working offline and after a reload.
   */
  async function loadKey(): Promise<void> {
    const workspaceId = activeId.value
    if (!workspaceId) {
      keyState.value = 'none'
      return
    }

    const core = await getLocalCore()
    const stored = await core.db.cryptoKeys.get(WORKSPACE_KEY_ROW)
    if (stored) {
      workspaceKey = stored.key
      workspaceCipher = await createWorkspaceCipher(workspaceId, stored.key)
      cipherFor = workspaceId
      keyState.value = 'ready'
      return
    }

    keyState.value = 'awaiting'
    const identity = await encryption.ensureIdentity()
    if (!identity) return

    try {
      const { sealedKey } = await api.request<{ sealedKey: SealedKey }>(
        `/workspaces/${workspaceId}/key`,
      )
      const key = await openSealedKey({ workspaceId, sealed: sealedKey, recipient: identity })

      await core.db.cryptoKeys.put({
        id: WORKSPACE_KEY_ROW,
        key,
        storedAt: new Date().toISOString(),
      })
      workspaceKey = key
      workspaceCipher = await createWorkspaceCipher(workspaceId, key)
      cipherFor = workspaceId
      keyState.value = 'ready'
    } catch (error) {
      // "Nobody has granted it yet" is the expected answer right after joining.
      if (error instanceof AppError && error.code === 'workspace_key_unavailable') return
      errorMessage.value = describeError(error)
    }
  }

  async function create(name: string): Promise<WorkspaceSummary | null> {
    return run(async () => {
      const identity = await encryption.ensureIdentity()
      if (!identity) {
        throw new AppError('key_unavailable', {
          message: 'Set up encryption before creating a workspace.',
        })
      }

      // The key is made here, on this device, and the server is handed a copy
      // it cannot open — including the creator's own.
      const { generateDataKey } = await import('@clinote/crypto')
      const key = await generateDataKey()

      // The id is chosen here because the key is sealed *to* it. Asking the
      // server for an id first would mean sealing in a second request, which
      // could fail and leave a workspace nobody can open.
      const workspaceId = crypto.randomUUID()
      const created = await api.request<{ workspace: WorkspaceSummary }>('/workspaces', {
        method: 'POST',
        body: {
          id: workspaceId,
          name,
          sealedKey: await sealKeyForMember({
            workspaceId,
            workspaceKey: key,
            sender: identity,
            recipientPublicKey: identity.publicKey,
          }),
        },
      })

      await refresh()
      await open(created.workspace.id)
      return created.workspace
    })
  }

  async function join(token: string): Promise<boolean> {
    const result = await run(async () => {
      await api.request('/workspaces/invites/accept', { method: 'POST', body: { token } })
      await encryption.ensureIdentity()
      await refresh()
      return true
    })
    return result === true
  }

  async function members(): Promise<WorkspaceMemberView[]> {
    if (!activeId.value) return []
    const result = await api.request<{ members: WorkspaceMemberView[] }>(
      `/workspaces/${activeId.value}/members`,
    )
    return result.members
  }

  async function invite(email: string, memberRole: WorkspaceRole): Promise<string | null> {
    const result = await run(async () => {
      const response = await api.request<{ token?: string }>(
        `/workspaces/${activeId.value}/invites`,
        { method: 'POST', body: { email, role: memberRole } },
      )
      return response.token ?? null
    })
    return result ?? null
  }

  async function removeMember(userId: string): Promise<boolean> {
    return (
      (await run(async () => {
        await api.request(`/workspaces/${activeId.value}/members/${userId}`, { method: 'DELETE' })
        return true
      })) === true
    )
  }

  async function changeRole(userId: string, next: WorkspaceRole): Promise<boolean> {
    return (
      (await run(async () => {
        await api.request(`/workspaces/${activeId.value}/members/${userId}`, {
          method: 'PATCH',
          body: { role: next },
        })
        return true
      })) === true
    )
  }

  async function pendingGrants(): Promise<PendingGrant[]> {
    if (!activeId.value || !allows('members.manage')) return []
    const result = await api.request<{ pending: PendingGrant[] }>(
      `/workspaces/${activeId.value}/keys/pending`,
    )
    return result.pending
  }

  /**
   * Hands a colleague the key, from this device.
   *
   * This is the moment access actually begins, and it can only happen on a
   * device that holds the key — no server-side path exists, by design.
   */
  async function grantAccess(member: PendingGrant): Promise<boolean> {
    return (
      (await run(async () => {
        const identity = await encryption.ensureIdentity()
        const workspaceId = activeId.value
        if (!identity || !workspaceId || !workspaceKey) {
          throw new AppError('key_unavailable', {
            message: 'This device does not hold the workspace key.',
          })
        }
        if (!member.publicKey) {
          throw new AppError('key_unavailable', {
            message: 'That person has not set up encryption yet.',
          })
        }

        await api.request(`/workspaces/${workspaceId}/keys/${member.userId}`, {
          method: 'PUT',
          body: {
            sealedKey: await sealKeyForMember({
              workspaceId,
              workspaceKey,
              sender: identity,
              recipientPublicKey: member.publicKey,
            }),
          },
        })
        return true
      })) === true
    )
  }

  async function auditEvents(limit = 50): Promise<AuditEvent[]> {
    if (!activeId.value || !allows('audit.read')) return []
    const result = await api.request<{ events: AuditEvent[] }>(
      `/workspaces/${activeId.value}/audit?limit=${limit}`,
    )
    return result.events
  }

  async function run<T>(operation: () => Promise<T>): Promise<T | null> {
    busy.value = true
    errorMessage.value = null
    try {
      return await operation()
    } catch (error) {
      errorMessage.value = describeError(error)
      return null
    } finally {
      busy.value = false
    }
  }

  return {
    workspaces,
    activeId,
    active,
    role,
    keyState,
    busy,
    errorMessage,
    available: computed(() => canUse('workspaces')),
    allows,
    refresh,
    open,
    loadKey,
    create,
    join,
    members,
    invite,
    removeMember,
    changeRole,
    pendingGrants,
    grantAccess,
    auditEvents,
    /** The cipher for the open workspace, or null on the personal dataset. */
    cipher: (): EnvelopeCipher | null =>
      cipherFor && cipherFor === activeWorkspaceId() ? workspaceCipher : null,
  }
}
