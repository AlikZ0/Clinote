/**
 * Dexie migrations (docs/indexeddb.md §5).
 *
 * APPEND ONLY. A released version block is never edited — editing one changes
 * the schema of databases that already exist on real devices, and IndexedDB has
 * no way to notice. New columns and indexes get a new `db.version(n)` block
 * with an `upgrade()` that backfills derived fields.
 */
import type Dexie from 'dexie'

/**
 * Only indexed fields appear here; everything else on a row is stored without
 * being indexed. Compound indexes are listed in the order the screens query
 * them, so no query has to sort in memory.
 */
export const SCHEMA_V1 = {
  clients: 'id, isDeleted, [isDeleted+sortKey], [isDeleted+arrivalDate], updatedAt',
  works: 'id, clientId, isDeleted, [clientId+dateKey], [isDeleted+dateKey], updatedAt',
  files: 'id, clientId, workId, hash, isDeleted, [clientId+createdKey], [isDeleted+createdKey]',
  fileBlobs: 'id',
  appointments:
    'id, clientId, isDeleted, [isDeleted+startKey], [clientId+startKey], [status+startKey]',
  settings: 'key',
  syncState: 'key',
  outbox: '++seq, operationId, entityId, state, [state+seq], [entityType+entityId]',
  backups: 'id, createdAt, status',
  conflicts: 'id, entityType, entityId, resolvedAt',
  // Non-extractable CryptoKey handles. Their bytes cannot be read back by any
  // script, including ours (docs/encryption.md §9).
  cryptoKeys: 'id',
} as const

export function applyMigrations(db: Dexie): void {
  db.version(1).stores(SCHEMA_V1)

  // v2 goes here. Do not touch v1.
}
