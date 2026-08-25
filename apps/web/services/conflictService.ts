/**
 * Conflict resolution (docs/sync.md §5).
 *
 * A conflict card exists because two people changed the same thing without
 * seeing each other. Resolving it is an ordinary edit: it goes through the
 * repository, gets a new clock value and is pushed like anything else, so the
 * other device ends up with the decision rather than with a silent overwrite.
 */
import { AppError } from '@clinote/shared'
import type { EntityType } from '@clinote/types'
import type { ConflictRow, LocalCore } from '~/database'
import { CONTESTED_FIELDS } from './syncEngine'

export type ConflictChoice = 'mine' | 'theirs' | 'both'

export interface ConflictView {
  id: string
  entityType: EntityType
  entityId: string
  detectedAt: string
  /** Field-by-field differences, so a person can see what is actually at stake. */
  differences: { field: string; mine: string; theirs: string }[]
  title: string
}

const SEPARATOR = '\n\n— — —\n\n'

export class ConflictService {
  constructor(private readonly core: LocalCore) {}

  async list(): Promise<ConflictView[]> {
    const rows = await this.core.sync.listUnresolvedConflicts()
    const views: ConflictView[] = []

    for (const row of rows) {
      views.push({
        id: row.id,
        entityType: row.entityType,
        entityId: row.entityId,
        detectedAt: row.detectedAt,
        differences: this.differences(row),
        title: await this.describe(row),
      })
    }

    return views
  }

  async count(): Promise<number> {
    return (await this.core.sync.listUnresolvedConflicts()).length
  }

  async resolve(conflictId: string, choice: ConflictChoice): Promise<void> {
    const rows = await this.core.sync.listUnresolvedConflicts()
    const conflict = rows.find((row) => row.id === conflictId)
    if (!conflict) {
      throw new AppError('not_found', { message: 'That conflict has already been resolved.' })
    }

    const patch = this.patchFor(conflict, choice)
    if (Object.keys(patch).length > 0) {
      const repository = this.repositoryFor(conflict.entityType)
      if (repository) await repository.update(conflict.entityId, patch)
    }

    await this.core.sync.resolveConflict(conflictId)
  }

  private patchFor(conflict: ConflictRow, choice: ConflictChoice): Record<string, unknown> {
    const mine = conflict.localSnapshot as Record<string, unknown>
    const theirs = conflict.remoteSnapshot as Record<string, unknown>
    const fields = CONTESTED_FIELDS[conflict.entityType] ?? []
    const patch: Record<string, unknown> = {}

    for (const field of fields) {
      const ours = mine[field]
      const remote = theirs[field]
      if (ours === remote) continue

      if (choice === 'mine') patch[field] = ours
      else if (choice === 'theirs') patch[field] = remote
      else if (typeof ours === 'string' && typeof remote === 'string') {
        // Keeping both is only meaningful for text; for a time there is no
        // "both", and the UI does not offer it.
        patch[field] = `${remote}${SEPARATOR}${ours}`
      } else {
        patch[field] = ours
      }
    }

    return patch
  }

  private differences(conflict: ConflictRow): ConflictView['differences'] {
    const mine = conflict.localSnapshot as Record<string, unknown>
    const theirs = conflict.remoteSnapshot as Record<string, unknown>

    return (CONTESTED_FIELDS[conflict.entityType] ?? [])
      .filter((field) => mine[field] !== theirs[field])
      .map((field) => ({
        field,
        mine: String(mine[field] ?? ''),
        theirs: String(theirs[field] ?? ''),
      }))
  }

  /** Names the record without leaking clinical text into a list view. */
  private async describe(conflict: ConflictRow): Promise<string> {
    if (conflict.entityType === 'client') {
      const client = await this.core.clients.getById(conflict.entityId, { includeDeleted: true })
      return client ? `${client.lastName} ${client.firstName}` : 'A client'
    }

    if (conflict.entityType === 'work') {
      const work = await this.core.works.getById(conflict.entityId, { includeDeleted: true })
      if (!work) return 'A work'
      const client = await this.core.clients.getById(work.clientId, { includeDeleted: true })
      return client ? `${work.title} · ${client.lastName}` : work.title
    }

    if (conflict.entityType === 'appointment') {
      const appointment = await this.core.appointments.getById(conflict.entityId, {
        includeDeleted: true,
      })
      if (!appointment) return 'An appointment'
      const client = await this.core.clients.getById(appointment.clientId, { includeDeleted: true })
      return client ? `Appointment · ${client.lastName}` : 'An appointment'
    }

    return 'A record'
  }

  private repositoryFor(entityType: EntityType) {
    switch (entityType) {
      case 'client':
        return this.core.clients as unknown as {
          update(id: string, patch: Record<string, unknown>): Promise<unknown>
        }
      case 'work':
        return this.core.works as unknown as {
          update(id: string, patch: Record<string, unknown>): Promise<unknown>
        }
      case 'appointment':
        return this.core.appointments as unknown as {
          update(id: string, patch: Record<string, unknown>): Promise<unknown>
        }
      default:
        return null
    }
  }
}
