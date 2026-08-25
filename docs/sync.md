# Cloud Sync

Applies to Pro and Business (§38). Free writes to the outbox but nothing drains it.

## 1. Model

The server is an **ordered ciphertext relay**, not a database of client records.

```
Device A ──push envelopes──▶  API ──assigns seq──▶ sync_envelopes (Postgres)
Device B ──pull since=cursor──▶ API ──returns envelopes in seq order──▶ Device B
```

The server guarantees: durability, a total order per account/workspace, and
at-least-once delivery. It guarantees nothing about _meaning_ — it cannot read
the payload.

## 2. Envelope

```
operationId   uuid   idempotency key, generated at mutation time
entityType    enum   client | work | file | appointment | settings
entityId      uuid   opaque to the server (already an opaque id)
operation     enum   put | delete
hlc           string hybrid logical clock, "<wallMillis>:<counter>:<deviceId>"
baseHlc       string the clock value the record had before this change, or null
                     for a creation — see §5
deviceId      uuid
payload       bytes  AES-GCM envelope of the full record (encryption.md §4)
seq           bigint assigned by the server on accept
```

`put` carries the whole record, not a field diff. Diffs would require the server
or the receiver to reconstruct state from a complete history; whole-record
puts make the stream self-healing and let old envelopes be compacted.

## 3. Outbox state machine (§39)

```
pending ──▶ uploading ──▶ synced
   ▲            │
   └──── failed ┘ (retryable, exponential backoff + jitter)
                 └──▶ conflict (needs local resolution)
```

Rules:

- An operation is enqueued in the **same Dexie transaction** as the data write.
  There is no window where the local data changed but the outbox does not know.
- Draining is batched (default 200 envelopes or 4 MB, whichever first) and
  triggered by: app foreground, network regained, mutation debounce (3 s), and a
  periodic tick while the tab is visible. Not one request per UI action (§38).
- `operationId` makes retries idempotent server-side.
- Free/lapsed plans: the outbox is capped and pruned oldest-first once a size
  limit is reached, because it will never be drained; the local data is
  untouched (I2). Enabling Pro performs a one-time full re-enqueue from the
  current database state rather than replaying an incomplete queue.

## 4. Pull and cursor

`GET /api/v1/sync/changes?since=<seq>&limit=…` returns envelopes with
`seq > since` in ascending order plus `nextCursor` and `hasMore`. The cursor is
stored in `syncState`. Delivery is at-least-once, so applying an envelope must
be idempotent — it is, because `put` is a whole-record write guarded by HLC
comparison.

## 5. Ordering and conflicts (§40)

Received envelope vs. local record:

| Case                         | Resolution                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------- |
| local record absent          | apply                                                                         |
| incoming `hlc` > local `hlc` | apply                                                                         |
| incoming `hlc` < local `hlc` | discard (our version is newer)                                                |
| equal `hlc`                  | impossible for distinct devices — the device id is the tiebreaker in the HLC  |
| delete vs. update            | delete wins if its `hlc` is newer; otherwise the update resurrects the record |

### Detecting divergence

Ordering alone cannot tell "B edited after seeing A" apart from "B edited
without ever seeing A" — both produce a newer clock value. The envelope
therefore carries `baseHlc`: the value the sender's record had _before_ the
change.

A receiver whose own value differs from `baseHlc` knows the sender never saw its
version. This is checked **before** deciding who wins, which makes it symmetric:
both devices raise the conflict, and both keep the other's text. Phase 9 first
implemented the obvious heuristic instead — "do I still have something queued
for this record?" — and it fires only on whichever device happened to push last,
silently losing the other's work. The test that found it is
`syncEngine.test.ts › surfaces the conflict on both devices`.

Last-write-wins at **record** granularity is used only for records whose fields
are independently safe to overwrite. Two cases are escalated instead of
silently overwritten:

1. **Concurrent edits to free text** (`client.notes`, `work.description`,
   `work.notes`) where both sides changed the field since their common ancestor.
2. **Appointment time changes** (`startAt`/`endAt`) made concurrently on two
   devices — silently picking one can send a person to the wrong slot.

For those, the loser is preserved in the `conflicts` table and the UI shows a
resolution card: _Keep mine · Keep theirs · Keep both_ (for notes, "keep both"
concatenates with a separator and attribution). Nothing is discarded before the
user chooses; the winning version is what other devices already have, so the
system stays converged while the conflict is open.

We do not use CRDTs in v1. The reason is documented rather than hidden: CRDT
text merging is the right long-term answer for `notes`, but it changes the
storage format, so v1 keeps records opaque and revisits this once the local core
is frozen. The escalation mechanism above exists precisely so that adopting a
CRDT later does not require changing user-visible behaviour.

## 6. Files

Blobs do not travel in sync envelopes. A `file` envelope carries metadata plus a
content hash; the bytes are uploaded as a separate encrypted object and fetched
lazily by the receiving device. Content is addressed by hash, so the same file
attached twice uploads once and can never conflict.

## 7. Sync status (§70)

`✓ Synced` · `Syncing…` · `Offline` · `Conflict (n)` · `Failed` — derived from
outbox counts and the last pull result, exposed by one composable so every
surface shows the same state.

## 8. Server-side limits

Per-account envelope rate limit, per-request size cap, payload size cap, and a
device allow-list check (Pro: 3 devices, Business: configurable — §37). Exceeding
the device limit returns a typed error the UI renders as "Device limit reached —
manage devices".

## 9. What Phase 9 shipped

| Piece                                                               | Where                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| Relay: append, ordered pull, cursor, device check, entitlement gate | `apps/api/src/sync/routes.ts`                            |
| Wrapped key material                                                | `apps/api/src/users/keys.ts`                             |
| Envelope storage (ciphertext only)                                  | `sync_envelopes`, `sync_cursors` in `0002_sync.sql`      |
| Key hierarchy on the device                                         | `apps/web/services/encryption.ts`                        |
| Drain, pull, HLC resolution, conflict detection                     | `apps/web/services/syncEngine.ts`                        |
| Resolution (keep mine / theirs / both)                              | `apps/web/services/conflictService.ts`                   |
| Passphrase, unlock, sync state                                      | `composables/useEncryption.ts`, `composables/useSync.ts` |
| Conflict surface                                                    | `pages/conflicts.vue`                                    |

Two notes on scope:

**Key management moved earlier.** The roadmap put it in Phase 11, but a payload
must be ciphertext the moment sync exists — shipping sync first would have meant
sending plaintext client data to the server, which invariant I3 forbids. Phase 9
therefore includes the passphrase → KEK → wrapped DEK path and the endpoints
that store the wrapped keys. Phase 11 keeps backup encryption, the recovery key,
rotation and device-enrollment UX.

**File bytes do not sync yet.** A `file` envelope carries metadata; the bytes
are a separate encrypted object (§6) and arrive with Phase 10's upload
protocol. Until then a file that syncs to a second device shows as "not stored
on this device", which the viewer already says.

## 10. Workspace streams (Phase 14)

A stream is addressed by a **scope**, not by an account:

| Scope     | Envelopes                      | Cursor          | Paid for by     |
| --------- | ------------------------------ | --------------- | --------------- |
| Personal  | one account's own              | (device, null)  | that account    |
| Workspace | every member's, for that space | (device, space) | the space owner |

Consequences the code had to be reshaped for:

- **The author and the stream are two different things.** `SyncStore.append`
  takes a scope plus the author, because in a workspace they differ.
- **A device has one cursor per workspace.** Advancing one stream must not skip
  envelopes in another, so `sync_cursors` is keyed by (device, workspace) and
  no longer by device alone.
- **The owner's plan governs.** An assistant on the Free plan syncs their
  clinic's workspace and still has no personal cloud sync — checking the
  caller's own plan would lock them out of their job, and granting them one
  would give away Pro. Device _registration_ follows the same rule: a member
  may register a device up to the best limit any of their workspaces allows.
- **Reading and writing are separated.** Pulling needs membership; pushing
  needs `clients.write`. That asymmetry is what makes a Viewer a viewer, and it
  is enforced server-side because a modified client would push regardless.

## 11. Tests

- two simulated devices, interleaved mutations → convergence;
- offline device accumulating 500 operations → drains in order after reconnect;
- duplicate delivery of the same envelope → no change;
- delete/update race in both orders → identical final state on both devices;
- concurrent notes edit → conflict row created, not silent loss;
- plan downgrade mid-sync → drain stops, local data intact.
