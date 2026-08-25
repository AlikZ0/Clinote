/**
 * Merge resolution for import (product spec §30, docs/backup.md §8).
 *
 * Records are matched by UUID, never by content, so importing the same archive
 * twice changes nothing. Which version wins is decided by the hybrid logical
 * clock — the same rule sync uses (docs/sync.md §5), so an import and a sync
 * cannot disagree about which version is newer.
 */
import { compareHlc } from '@clinote/shared'

export type MergeDecision = 'insert' | 'update' | 'skip'

export interface MergeCandidate {
  hlc: string
  deletedAt: string | null
}

export function resolveMerge(
  local: MergeCandidate | undefined | null,
  incoming: MergeCandidate,
): MergeDecision {
  if (!local) return 'insert'

  const order = compareHlc(incoming.hlc, local.hlc)
  if (order > 0) return 'update'
  if (order < 0) return 'skip'

  // Same HLC means the same version of the same record: nothing to do. A
  // tombstone still wins over a live record, because a delete that lost its
  // ordering must not be silently resurrected by re-importing an old archive.
  return incoming.deletedAt && !local.deletedAt ? 'update' : 'skip'
}

export interface MergeTally {
  inserted: number
  updated: number
  skipped: number
}

export function emptyTally(): MergeTally {
  return { inserted: 0, updated: 0, skipped: 0 }
}

export function record(tally: MergeTally, decision: MergeDecision): MergeTally {
  if (decision === 'insert') tally.inserted += 1
  else if (decision === 'update') tally.updated += 1
  else tally.skipped += 1
  return tally
}
