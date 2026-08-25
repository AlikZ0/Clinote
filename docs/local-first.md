# Local-first

## 1. Definition used in this project

Local-first means: **every read and every write completes against local storage,
without a network round trip, and the result is durable before the UI reports
success.** The network is an enhancement that replicates already-committed local
state.

This is not "offline support bolted onto an online app". The online path is the
optional one.

## 2. Consequences we accept

- The UI never shows a spinner for a CRUD operation.
- There is no "save failed because the server was down".
- Two devices on Free legitimately show different data (§3 of the product spec).
- Conflict resolution is a client concern (see `sync.md`).
- Server-side search over client data is impossible (see `architecture.md` R2).

## 3. Write path

```
component → composable → application service → repository → Dexie
                              │
                              ├─ stamps updatedAt + HLC
                              ├─ writes tombstone instead of hard delete
                              ├─ appends an outbox operation (always, all plans)
                              └─ emits a domain event (audit, UI invalidation)
```

The outbox is written on **Free too**. It is cheap, it keeps a single write path,
and it means enabling Pro does not require a data migration or a special
"first full upload" code path that is only exercised once. Free simply has no
consumer draining the queue; the queue is capped and pruned (see `sync.md`).

## 4. Read path

Repositories expose:

- keyed lookups (`getById`)
- index-backed paged queries (`listPage({ cursor, limit, filter })`)
- count queries that use Dexie indexes, never `toArray().length`

No service ever loads a whole table. Targets are 1,000+ clients, 10,000+ works,
10,000+ files (§66).

## 5. Deletes

Soft delete only, via `deletedAt`. Reasons:

- sync needs a tombstone to propagate a delete;
- restore/merge needs to distinguish "never existed" from "deleted";
- undo becomes possible.

Hard deletion happens in one place: a purge job that removes tombstones older
than the retention window and their orphaned blobs, and it runs locally.

## 6. Identifiers

UUID v4 generated on the client (`crypto.randomUUID`). Consequences:

- import/merge is idempotent (§30 — "не создавать дубликаты");
- no server round trip is needed to create an entity;
- an entity keeps its identity across export → import → restore.

## 7. Time

Wall-clock time is untrustworthy across devices. Every mutable record carries:

- `updatedAt` — ISO string, human-facing, device wall clock;
- `hlc` — hybrid logical clock string, machine-facing, used for ordering.

`hlc` is what conflict resolution reads. `updatedAt` is what the UI shows.

## 8. Degradation rules

| Situation              | Behaviour                                                          |
| ---------------------- | ------------------------------------------------------------------ |
| Offline                | All local features work. Status chip shows Offline. Outbox grows.  |
| Subscription lapsed    | Sync/backup stop. Local data, export and import keep working (I2). |
| Quota exceeded         | Human message + guided export/cleanup. Never a raw DOMException.   |
| Storage not persistent | Warning banner + Add to Home Screen guidance on iOS.               |
| Corrupted local DB     | Detected on open; offer export-of-what-is-readable and restore.    |

## 9. What is forbidden

- `localStorage` for domain data (allowed only for tiny UI preferences and a
  device id, never for client records — §85).
- Base64 blobs (§85). Blobs are stored as `Blob`.
- Any code path where a UI action awaits an HTTP request to become durable.
- Reading an entire table into memory to filter it in JS.
