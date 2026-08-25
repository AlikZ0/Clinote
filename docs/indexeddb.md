# IndexedDB / Dexie

## 1. Database

One Dexie database per workspace context:

- `clinote` — the default (personal) database, used by Free/Pro.
- `clinote_ws_<workspaceId>` — Business workspaces (§44: each workspace has its
  own clients, works, files, appointments, settings). Isolation by database
  rather than by a `workspaceId` column means a workspace can be attached,
  detached and purged atomically, and a query can never leak across workspaces.

## 2. Schema (v1)

```
clients      id, isDeleted, [isDeleted+sortKey], [isDeleted+arrivalDate], updatedAt
works        id, clientId, isDeleted, [clientId+dateKey], [isDeleted+dateKey], updatedAt
files        id, clientId, workId, hash, isDeleted, [clientId+createdKey], [isDeleted+createdKey]
fileBlobs    id                     (original + thumbnail bytes, see §4)
appointments id, clientId, isDeleted, [isDeleted+startKey], [clientId+startKey],
             [status+startKey], updatedAt
settings     key
outbox       ++seq, operationId, entityId, [state+seq], [entityType+entityId]
syncState    key                    (cursors, last pull)
backups      id, createdAt, status  (local index of cloud backups + local exports)
conflicts    id, entityType, entityId, detectedAt
```

Indexes exist to serve the actual screens: client list sorted by last name with
tombstones excluded, works for one client by date, today's appointments, the
outbox drain order.

Two storage details that the schema above encodes deliberately:

**`isDeleted: 0 | 1` instead of indexing `deletedAt`.** IndexedDB skips records
whose indexed key is `null` or `undefined`, so an index on a nullable
`deletedAt` silently omits every live record — exactly the ones the list needs.
A numeric flag is derived on every write; `deletedAt` remains the data.

**`sortKey` / `dateKey` / `createdKey` / `startKey` are unique derived keys**
(`<sort field>\u0000<id>`, lower-cased). Cursor pagination over a non-unique
index cannot resume exactly: two clients with the same surname share a key and
a page boundary either repeats or skips one. Appending the id makes every key
unique, so `where(index).above(cursor).limit(n)` is exact, and because the sort
field comes first a prefix search still works on the same index.

## 3. Entity fields

Exactly as specified in §14–§17. No additional personal data is stored: no
address, no national id, no diagnosis codes as first-class columns. Free-text
`notes` is the only place clinical text lives, and it is treated as sensitive
everywhere (never logged, never emailed, never sent to analytics).

## 4. Blobs

Bytes live in their own table, `fileBlobs` (`id` → `{ original, thumbnail }`),
separate from the `files` metadata row.

Phase 0 specified the blobs as columns on `files`; Phase 2 split them, because
metadata is read constantly (lists, counts, sync envelopes, export manifests)
while a 30 MB x-ray must be touched only when someone opens it. Keeping them in
one row means every metadata query deserializes blob references, and it makes
`files` unusable as the sync payload source. The split is invisible to the
domain model: `FileMeta` is unchanged and `fileRepository` owns both tables in a
single transaction.

- Lists render thumbnails only.
- The viewer requests the original on demand and revokes the object URL on
  unmount.
- PDFs get a first-page raster thumbnail where the browser allows it, otherwise
  a type icon.
- `hash` is the SHA-256 of the original, used for deduplication and for
  import/merge idempotency. Adding a file whose hash already exists for the same
  client returns the existing record instead of storing the bytes twice.
- A soft-deleted file keeps its bytes until the purge job runs, so an undo (and
  a restore of a tombstoned record from another device) stays possible.

## 5. Migrations

`migrations.ts` owns an append-only list of Dexie versions. Rules:

- Never edit a released version block — add a new one.
- Every migration is a pure function of the previous schema and is tested with
  a fixture database.
- `databaseVersion` in a backup manifest is the Dexie version. Restoring a
  _newer_ manifest into an older app is refused with a clear message; restoring
  an older manifest runs the same upgrade path as a live database.

## 6. Quota

Before large writes the app checks `navigator.storage.estimate()`.

- `< 10%` remaining → warning banner with an export shortcut.
- `QuotaExceededError` → "Not enough storage on this device." plus the guided
  flow (export, delete old files, restore later) — never the raw exception (§68).
- `navigator.storage.persist()` is requested at first write; the result is
  reflected in Settings → Storage.

## 7. Performance rules

- Paged queries via index cursors, never offset scanning of the whole table.
- Virtualized lists in the UI for clients, works and files.
- Bulk operations (import, restore) run in chunked transactions so the UI stays
  responsive and a failure rolls back a bounded amount of work.
- Counts come from `Table.count()` on an index.

## 8. The outbox is written by the repository, not above it

`docs/sync.md` §3 requires an operation to be enqueued in the same transaction
as the data write. That is only enforceable at the layer that owns the
transaction, so `RecordRepository` performs stamp → write → enqueue atomically.
Application services orchestrate use cases on top; they cannot produce a write
that skips the outbox.

The outbox stores _intent_, not content: `entityType`, `entityId`, `operation`
and the HLC, with no payload. The envelope is serialized from the current record
at drain time (docs/sync.md §2 sends whole records), which keeps the queue small,
keeps plaintext out of a second place, and lets consecutive pending operations
for one entity coalesce into a single upload.

## 9. One database per workspace (Phase 14)

Personal data lives in `clinote`. A workspace lives in
`clinote_ws_<workspaceId>`. Not a `workspaceId` column on every row:

- a query can never accidentally cross a workspace boundary — there is no join
  that could;
- losing access to a workspace is a database that is simply not opened, rather
  than rows that have to be found and deleted;
- the workspace key sits beside the data it opens.

Switching closes the current handle before opening the next, so no screen can
keep rendering rows from the workspace the user just left.

The **device id is shared** across those databases, read from the personal one.
A workspace database minting its own would register a second device with the
server and make the outbox, the HLCs and the device list disagree about what
this machine is.

The choice of active workspace is restored in a **Nuxt plugin**, not in the
app shell's `onMounted`: a page's `onMounted` runs first, so a screen would
otherwise query the personal database for a moment and render an empty
workspace.

## 10. Testing

`fake-indexeddb` in Vitest. Every repository has tests for: create, read, page,
soft delete, tombstone exclusion, migration from the previous version, and the
outbox side effect.
