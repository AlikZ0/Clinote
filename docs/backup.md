# Backup, export and restore

## 1. Two different things

|           | Local export/import                    | Cloud backup/restore                     |
| --------- | -------------------------------------- | ---------------------------------------- |
| Plans     | All, including Free                    | Pro / Business                           |
| Format    | `.zip` archive, unencrypted, user-held | Same archive, encrypted, uploaded        |
| Trigger   | User action                            | "Finish workday" + explicit "Backup now" |
| Retention | User's filesystem                      | 30 days (Pro) / 365+ days (Business)     |

The archive format is identical, which means one serializer, one validator, one
set of tests — and a cloud backup can be downloaded and opened as a local export
if the user ever leaves the product.

## 2. Archive format

```
clinote-backup-2026-08-25.zip
  manifest.json
  database.json
  files/
    clients/<clientId>/<fileId>.<ext>
```

`manifest.json`:

```json
{
  "format": "clinote-backup",
  "formatVersion": 1,
  "appVersion": "1.0.0",
  "databaseVersion": 1,
  "createdAt": "2026-08-25T19:42:11.000Z",
  "deviceId": "…",
  "counts": { "clients": 247, "works": 1310, "files": 892, "appointments": 63 },
  "checksum": "sha256:…"
}
```

`checksum` covers `database.json` plus a sorted list of `fileId:sha256` pairs, so
a truncated or tampered archive fails validation before anything is written.

`database.json` contains every table including tombstones, with blobs replaced
by a reference to their path under `files/`.

## 3. Backup pipeline (§24)

```
Finish workday
   ↓ snapshot     consistent read of all tables in one Dexie transaction
   ↓ validate     referential integrity, counts, required fields
   ↓ compress     zip (store for already-compressed media, deflate for JSON)
   ↓ encrypt      AES-256-GCM, per-backup DEK, DEK wrapped by KEK (encryption.md)
   ↓ upload       init → signed URL(s) → direct to object storage → complete
   ↓ verify       server checks size + ciphertext digest; client re-reads header
   ↓ done         local backups row, dashboard health, email notification
```

Each step is resumable and each failure has a distinct, actionable message. A
failure at "upload" keeps the encrypted artifact in a local staging table so a
retry does not re-encrypt gigabytes.

## 4. Upload protocol (§74)

Large archives never travel through the JSON API.

```
POST /api/v1/backups/init      { size, checksum, deviceId, parts }
  → { backupId, uploadUrls[], expiresAt }
PUT  <signed url>              (direct to S3-compatible storage, per part)
POST /api/v1/backups/complete  { backupId, parts[{ etag }] , checksum }
  → { status: "verifying" | "completed" }
```

The server verifies object size and digest, records metadata, updates storage
accounting, and enqueues the notification job. It never downloads the object to
inspect its contents — it cannot, and must not try.

## 5. Backup health (§26)

Server-side truth (`lastSuccessfulBackup`, `lastFailedBackup`, `backupCount`,
`storageUsed`) is mirrored on the dashboard:

```
Last backup: Today 19:42 ✓
Last 30 days: 29 successful · 1 failed
```

If the most recent attempt failed, or if there is no successful backup for the
previous working day, the dashboard shows a red state and a `[Retry backup]`
button. On app open, the missing-backup check runs (§63):

```
⚠️ Your last backup was not completed.   [Backup now]
```

We do **not** promise unattended daily backups from the browser (§25, R5). The
promise is: an explicit end-of-day action, plus detection and alerting when it
did not happen.

## 6. Retention

Server-side configuration, per plan (`subscriptions.md`). A retention job
deletes expired objects and their metadata rows, and never deletes the most
recent successful backup regardless of age.

## 7. What Phase 5 implemented, and where it differs from this document

Phase 5 shipped the local half: export, replace-import, merge-import and the
integrity checks. Two deliberate deviations from the plan above:

**The restore does not use a temporary database.** §7 below describes writing
into a temp database and swapping. The implementation instead materialises and
verifies the whole archive first, then clears and rewrites the live tables in a
single Dexie transaction (`apps/web/database/importWriter.ts`). This is a
stronger guarantee, not a weaker one: there is no window in which two databases
disagree, a failure anywhere rolls back to the original data, and it does not
require twice the storage on a device that may be short of it. The row counts
are re-read inside the transaction, so a partial write rolls back rather than
being reported as success.

**The archive carries no thumbnails.** Previews are derived data; they are
regenerated from the originals on import. This also removed `hasThumbnail` from
the file entity: whether a preview exists is a property of one device's storage,
and a synced or exported record must not claim it.

Two bounds worth stating plainly:

- The archive is built and parsed in memory. That is correct for a device-sized
  database and a user-held file; the streaming path belongs with the encrypted
  cloud upload (Phase 10), which has to handle sizes a phone cannot hold.
- An import queues every imported record in the outbox, preserving the archive's
  HLC values, so a Pro device propagates a restore instead of hiding it. The
  clock values are never restamped — this device received those changes, it did
  not author them.

## 8. What Phase 10 shipped

| Piece                                                   | Where                                                  |
| ------------------------------------------------------- | ------------------------------------------------------ |
| init → signed URL → direct PUT → complete → verify      | `apps/api/src/backups/routes.ts`                       |
| Object storage behind a port; S3 and in-memory adapters | `apps/api/src/storage/objects/`                        |
| Metadata, retention, storage accounting                 | `0003_backups.sql`, `BackupStore`, `StorageUsageStore` |
| Encrypt, upload, restore on the device                  | `apps/web/services/cloudBackupService.ts`              |
| Health, history, restore, delete                        | `components/CloudBackupCard.vue`                       |

Details worth keeping:

- **The server verifies what landed, not what was promised.** `complete` reads
  the object's size and computes its digest server-side; a truncated or altered
  upload is refused and the object is deleted. The digest is of the ciphertext,
  which is all the server can see.
- **A key per backup.** Each archive gets its own data key, wrapped with the
  account's KEK and stored beside the metadata. A key that only ever protected
  one archive is a far smaller thing to lose.
- **Storage is recomputed, never incremented.** Usage comes from summing
  completed backups; a counter that drifts is worse than one that costs a query.
- **Restore is the Phase 5 import.** Download → verify checksum → decrypt →
  `ImportService.apply(..., 'replace')`, which takes a safety copy and swaps
  atomically. Nothing new was written for the destructive half.
- **Keys survive a reload.** The unwrapped data key and KEK are kept as
  non-extractable `CryptoKey` handles in IndexedDB (docs/encryption.md §9), so a
  page refresh does not demand the passphrase again. Their bytes cannot be read
  by any script, and exposure is no greater than the local database, which is
  plaintext on the device by design. Signing out forgets them.

## 9. Restore (§28, §65)

```
choose backup
   ↓ download        signed GET url
   ↓ decrypt         unwrap DEK with KEK, AES-GCM open (fails closed)
   ↓ validate        manifest, checksum, databaseVersion compatibility
   ↓ show info       date, device, counts, size
   ↓ safety copy     emergency local export of the CURRENT database
   ↓ confirm         explicit user confirmation, typed if replacing
   ↓ restore         chunked transactional write into a temporary database
   ↓ swap            atomic rename/switch once the write completed
   ↓ verify          counts and checksums re-read from the live database
```

The current database is only replaced at the "swap" step, after the incoming
snapshot has been fully written and verified (I5). If any step fails:

```
Restore failed. Your current data has not been changed.
```

## 10. Import modes (§30)

- **Replace** — same machinery as restore, with the same safety copy.
- **Merge** — per record, by UUID:
  - unknown id → insert;
  - known id, incoming `hlc` newer → update;
  - known id, incoming older → skip;
  - files deduplicated by `hash`;
  - tombstones respected (an incoming delete wins over an older update).

Merge is idempotent: importing the same archive twice changes nothing.

## 11. Failure notifications

`backupStatus` and `emailStatus` are separate fields (§77). A backup is
`completed` even if the notification email bounces; the email is retried by its
own job with backoff.

## 12. Tests

- golden-file round trip: build → parse → identical database;
- corrupted archive (bad checksum, missing manifest, truncated zip) → refused;
- restore failure injection at every step → current database intact;
- merge idempotency and tombstone precedence;
- 1 GB-class synthetic archive for streaming/memory behaviour.
