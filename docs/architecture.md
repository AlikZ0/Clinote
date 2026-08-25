# Clinote — Architecture

> Status: Phase 0 (design). Authoritative document. Any implementation that
> contradicts this file is either a bug or requires an update to this file first.

## 1. Product shape in one sentence

Clinote is a **local-first** practice-management application whose system of
record is IndexedDB on the user's device; the cloud is an **optional,
zero-knowledge replication and backup layer** that is unlocked by a paid plan.

```
Free      → Your data. Your device.
Pro       → Your data. Everywhere. Always protected.
Business  → Your clinic. Your team. One workspace.
```

## 2. Non-negotiable invariants

These hold for every phase, every feature, every refactor.

| #   | Invariant                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | The local IndexedDB database is the system of record. The app is fully usable with the network permanently unavailable.                             |
| I2  | The user can always read, export and delete their local data — including after a subscription lapses, expires or is refunded.                       |
| I3  | The server never receives plaintext client data (names, notes, works, files, appointment titles). Payloads are encrypted client-side before upload. |
| I4  | No client PII in emails, logs, analytics, error reports or audit records.                                                                           |
| I5  | A restore never destroys the current local database before the incoming snapshot has been downloaded, decrypted and verified.                       |
| I6  | Paid capability is enforced server-side. Frontend gating is UX only.                                                                                |
| I7  | Prices, quotas, retention and limits are server-configured data, never frontend constants.                                                          |
| I8  | Cryptography uses Web Crypto / Node `crypto` primitives only. No hand-rolled algorithms, no custom modes, no home-made KDFs.                        |
| I9  | A shared dataset's key is generated and handed over on member devices. The server relays sealed key material and can never open it.                 |

## 3. System diagram

```
                              CLINOTE
                                 │
                ┌────────────────┴────────────────┐
                │                                 │
           LOCAL CORE                          CLOUD
        (always present)                 (Pro / Business only)
                │                                 │
          Dexie / IndexedDB                Fastify API (v1)
                │                                 │
   ┌────────┬───┴────┬─────────┐      ┌───────┬───┴────┬─────────┐
   │        │        │         │      │       │        │         │
Clients   Works    Files  Appointments│ Auth  Sync   Backup   Billing
   │        │        │         │      │       │        │         │
   └────────┴────────┴─────────┘      │  PostgreSQL  S3-compatible
                │                     │  (metadata)  (ciphertext)
        Outbox / Sync queue           │       │
                │                     │   Job runner
        Encrypted envelopes ──────────┘       │
                                     Email ── Web Push
```

## 4. Layering (frontend)

Strictly one-directional. A layer may only call the layer directly below it.

```
Vue components / pages          — rendering, no business rules
        ↓
composables (useClients, …)     — reactive state, Pinia stores where shared
        ↓
application services            — use cases, invariants, feature gating, events
        ↓
repositories                    — persistence contracts, queries, tombstones
        ↓
Dexie (IndexedDB)               — storage engine
```

Rules:

- A component never imports Dexie or a repository.
- A repository never knows about subscriptions, UI state or the network.
- The sync engine is a _consumer_ of the repository layer, not a bypass of it.
- Every write goes through a service so that (a) `updatedAt`/HLC stamping, (b)
  outbox enqueueing and (c) audit events happen in exactly one place.

## 5. Package boundaries (monorepo)

```
apps/web        Nuxt 3 PWA. Owns UI, local core, sync client, crypto usage.
apps/api        Fastify. Owns auth, entitlements, sync relay, backup metadata,
                storage brokering, billing webhooks, job scheduling.
                Persistence sits behind ports (`src/storage/ports.ts`): Phase 7
                ships an in-memory adapter for development, Phase 8 adds the
                PostgreSQL one. The API refuses to start with the in-memory
                adapter in production.

packages/types   Entities, DTOs, API contracts, zod schemas. No runtime deps
                 beyond zod. Imported by BOTH web and api — this is the single
                 source of truth for the wire format.
packages/config  Plan catalog defaults, feature flag identifiers, limits shape.
                 Values are *defaults*; the server is authoritative at runtime.
packages/crypto  Envelope encryption, key derivation, wrapping, checksums.
                 Isomorphic (WebCrypto in browser, node:crypto webcrypto in api).
packages/backup  Backup archive format: manifest, serialization, validation,
                 integrity verification. Shared so the API can validate what a
                 client claims to have uploaded (size/format, never content).
packages/shared  Ids, clocks, Result type, error taxonomy, small utilities.
```

Dependency direction: `web`, `api` → `backup`, `crypto`, `config`, `types` → `shared`.
No package may import from `apps/*`. No cycles.

## 6. Data ownership model

| Data                                | Lives in                     | Server sees                                                                      |
| ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| Clients, works, files, appointments | IndexedDB (canonical)        | ciphertext only                                                                  |
| Blobs (photos, x-rays, PDFs)        | IndexedDB `Blob` (canonical) | ciphertext only                                                                  |
| Sync envelopes                      | IndexedDB outbox → API       | ciphertext + routing metadata                                                    |
| Backups                             | S3-compatible object storage | ciphertext + size/checksum                                                       |
| Account, plan, devices, quotas      | PostgreSQL                   | plaintext (no client PII)                                                        |
| Appointment _scheduling metadata_   | PostgreSQL                   | timestamps only, no identity — see `docs/notifications.md` §"Minimum disclosure" |
| Workspace data                      | IndexedDB `clinote_ws_<id>`  | ciphertext only, shared between that workspace's members                         |
| Workspace keys                      | Member devices               | sealed blobs it cannot open — see `docs/encryption.md` §9                        |
| Roles, membership, audit entries    | PostgreSQL                   | plaintext: who and what, never which record                                      |

## 7. Architectural risks (identified in Phase 0)

These are the risks that can kill the product if handled late. Each one has an
owning document.

### R1 — iOS evicts IndexedDB (severity: critical)

Safari clears storage for sites not added to the Home Screen after ~7 days of
inactivity. For a Free user this means silent loss of the _system of record_.

Mitigation (mandatory, Phase 4):

- Request `navigator.storage.persist()` on first write and surface the result.
- Detect iOS Safari-not-installed and actively prompt "Add to Home Screen"
  before the user enters real data.
- Surface storage state on the dashboard ("Persistent storage: granted/denied").
- Nag for export when the last export is older than N days.
- Free onboarding states plainly that data lives only on this device.

See `docs/mobile.md`, `docs/local-first.md`.

### R2 — Zero-knowledge encryption vs. server features (severity: high)

If the server cannot read data, it cannot search, index, resolve conflicts
field-by-field, or say "Ivan at 14:30" in a reminder. This constrains the whole
product and must be accepted deliberately, not discovered in Phase 12.

Decisions:

- Sync is a **ciphertext relay**: server orders and fans out opaque envelopes.
- Conflict resolution happens **on the client**.
- Reminders use minimum-disclosure metadata (see `docs/notifications.md`),
  which is also exactly what §23 requires ("You have 3 appointments tomorrow").

### R3 — Key management and passphrase loss (severity: high)

A forgotten encryption passphrase means unrecoverable backups by design.
Mitigation: a generated **recovery key** shown once at setup, explicit
acknowledgement, and re-derivation on device enrollment. Documented in
`docs/encryption.md`.

### R4 — Multi-device key distribution (severity: high)

Device B must obtain the same data key as device A without the server learning
it. Solved by wrapping the data key with a passphrase-derived KEK and storing
only the wrapped blob server-side. See `docs/encryption.md` §"Device enrollment".

### R5 — Browser timers cannot guarantee backups (severity: medium)

Explicitly out of scope for MVP scheduling: the "Finish workday" action is the
trigger; the server detects and reports _absence_ of backups. See `docs/backup.md`.

### R6 — Blob volume and quota (severity: medium)

X-rays and PDFs are large. Thumbnails are generated on ingest, originals are
loaded lazily, and `QuotaExceededError` is translated into a human message and a
guided cleanup/export flow. See `docs/indexeddb.md`, §68 of the product spec.

### R7 — Sync before local-first is stable (severity: medium)

Sequencing risk, not technical. Phases 2–6 must be complete and tested before
Phase 9 begins; the outbox is written from Phase 2 onward so that no rewrite is
needed later, but nothing consumes it until Phase 9.

## 8. Phase gate policy

A phase is complete only when: implementation + tests + error handling +
security review + documentation + mobile consideration (§86). Every phase ends
with `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green.

## 9. Where to read next

| Topic                            | Document           |
| -------------------------------- | ------------------ |
| Local-first rules and layering   | `local-first.md`   |
| Dexie schema, migrations, quotas | `indexeddb.md`     |
| Archive format, health, restore  | `backup.md`        |
| Keys, envelopes, enrollment      | `encryption.md`    |
| Outbox, ordering, conflicts      | `sync.md`          |
| Calendar and reminders model     | `appointments.md`  |
| Push/email, minimum disclosure   | `notifications.md` |
| Plans, entitlements, gating      | `subscriptions.md` |
| Threat model and controls        | `security.md`      |
| iOS/Android specifics            | `mobile.md`        |
| Environments and rollout         | `deployment.md`    |
| HTTP contract                    | `api.md`           |
