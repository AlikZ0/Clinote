# Phases and definition of done

## Definition of done (§86)

A feature is done when it has: implementation + tests + error handling +
security review + documentation + mobile consideration. Not before.

After every phase: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`,
then a manual pass over the main user flows (§89).

## Phases

| #   | Phase                   | Exit criteria                                                                                                             |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 0   | Architecture            | `docs/` complete: architecture, risks, schemas, backup spec, feature matrix, API contract, sync model, security model. ✅ |
| 1   | Monorepo + tooling      | pnpm workspaces, TS project refs, ESLint/Prettier, Vitest, CI-ready scripts; `web` and `api` start and build. ✅          |
| 2   | Local IndexedDB core    | Dexie schema v1, migrations, repositories, outbox writes, unit tests with fake-indexeddb. ✅                              |
| 3   | Clients, works, files   | Full CRUD, paged lists, thumbnails, blob viewer, surname search. ✅                                                       |
| 4   | PWA + offline           | Manifest, service worker, install prompts, persistent storage request, offline chip, iOS eviction mitigations (R1). ✅    |
| 5   | Import / export         | Archive format v1, export, replace-import, merge-import, integrity validation. ✅                                         |
| 6   | Appointments + calendar | Entity, day/week/month/agenda views, statuses, dashboard slices, Free gating UX. ✅                                       |
| 7   | Authentication          | Register/login/reset, sessions, device registration, entitlement snapshot. ✅                                             |
| 8   | Backend                 | Fastify app, Postgres schema, validation, rate limiting, plans catalog, health. ✅                                        |
| 9   | Cloud sync              | Outbox drain, pull cursor, HLC resolution, conflict surface, device limits. ✅                                            |
| 10  | Cloud backup            | init/complete upload protocol, storage accounting, history, health, restore. ✅                                           |
| 11  | Encryption              | Backup encryption, recovery key, rotation, device enrollment UX. (Key hierarchy landed in Phase 9.) ✅                    |
| 12  | Notifications           | Reminder schedules, push (content-free payload), email templates, preferences. ✅                                         |
| 13  | Billing                 | BillingProvider abstraction, checkout, webhooks, entitlement transitions. ✅                                              |
| 14  | Business / teams        | Workspaces, roles, permissions, members, audit log, shared workspace keys. ✅                                             |
| 15  | Security hardening      | Threat model, executable pen-test checklist, dependency audit, redaction tests, CSP and response headers. ✅              |
| 16  | Testing                 | Unit/integration/E2E per §79, mobile matrix per §80.                                                                      |
| 17  | Deployment              | Environments, migrations, observability, restore drill.                                                                   |

### Deferred from Phase 15

- **A device PIN and remote wipe.** A stolen unlocked device reads what its
  owner reads; the threat model says so rather than implying otherwise. Both
  are product decisions before they are security ones.
- **Subresource Integrity for the bundle.** Assets are same-origin and hashed
  by name; SRI would matter if they moved to a third-party CDN.
- **A published security contact and disclosure process.** `SECURITY.md` and an
  address belong with a public launch.
- **Per-account sign-in throttling.** Sign-in is rate-limited per address seen
  by the server; an attacker spread across many addresses is only slowed by the
  global limit. A per-account counter is a denial-of-service lever against a
  named user and needs its own design.
- **Padding envelopes and cover traffic.** Sizes and timing stay visible. The
  threat model accepts it explicitly.

### Also in this pass (Phase 15)

- A **500 where a 413 belonged**: an oversized body was flattened into an
  internal error, telling the client the server broke when the request was
  wrong — and filing a false server error in the log.
- **Sign-ins were never audited.** The action existed in the taxonomy and
  nothing wrote it. They are now recorded once per workspace the person belongs
  to, so a practice can see who reached its records without learning that they
  also work somewhere else.
- A **strict CSP that broke the app**, caught in the browser rather than in a
  review: `script-src 'self'` blocks the inline script Nuxt uses to carry the
  runtime config, and the app loaded to a blank page. Fixed by hashing at build
  time instead of widening the policy.
- **`X-Forwarded-For` was trusted implicitly by nobody and correctly by nobody
  either**: with no configuration, `request.ip` behind a proxy would have been
  the proxy's. Now a declared hop count, defaulting to zero.

### Deferred from Phase 14

- **Deleting a workspace.** Membership, roles and leaving all work; removing a
  whole practice touches every member's local database and deserves its own
  design rather than a `DELETE` bolted on.
- **Transferring ownership.** The rules that stop an admin taking a practice
  from its owner exist; the deliberate handover does not.
- **Rotating a workspace key after somebody leaves.** Their sealed copy is
  deleted, which ends future access. Re-keying so that _past_ envelopes become
  unreadable to them means re-encrypting the stream, and is a data-migration
  feature, not a permission one.
- **Per-workspace backups.** Backup still runs against the open dataset; whose
  quota a workspace backup consumes is a billing question that has not been
  answered yet.
- **Audit log pagination and export.** The endpoint takes `before`; the screen
  shows the most recent fifty.
- **Custom roles.** Permissions are already a set per role, so this is a table
  change — but it needs an editor, and nobody has asked for one.

### Also in this pass (Phase 14)

- A **CORS gap** found in the browser: the new `X-Clinote-Workspace` header was
  not in the allow-list, so every cross-origin request from a workspace failed
  preflight.
- A **key-location bug**: the account data key was stored in whichever database
  was open, so switching to a workspace made the device look locked. It now
  lives in the personal database, where it belongs.
- A **startup race**: pages mounted before the shell had chosen the dataset and
  briefly queried the personal database. Restoring the active workspace moved
  into a Nuxt plugin.
- A **flaky mail test** that read Mailpit's inbox once instead of waiting for
  delivery, and failed only when the rest of the suite ran alongside it.

### Deferred from Phase 13

- **A real payment provider.** The port exists and the development provider
  exercises the whole flow; a Stripe or App Store adapter is deployment work
  with its own integration tests.
- **Invoices and billing history for the user.** Events are recorded; showing
  them is a screen nobody needs before money is real.
- **Yearly interval and proration.** The contract carries `interval`; only
  monthly is offered.

### Also in this pass

- **Three languages.** English, Russian and Armenian, with catalogue parity
  and placeholder parity enforced by tests (docs/mobile.md §1).
- **Visual redesign.** One token set for light and dark, a calmer clinical
  palette, stat tiles on the dashboard, pill navigation, consistent focus rings
  and 44px touch targets throughout. Class names were kept, so the change is
  almost entirely in `assets/css/main.css`.

### Deferred from Phase 12

- **The evening digest at a fixed local time.** A "1 day before" offset produces
  the tomorrow reminder; sending one digest per practitioner at, say, 18:00
  their time needs a per-user schedule rather than a per-appointment one.
- **Email retry with backoff.** A failed delivery is recorded and picked up by a
  later run, but attempts are not spaced out yet; that belongs with a real job
  queue.
- **Backup and security emails.** The templates exist and are tested; wiring
  them to the backup pipeline and to session events is a small follow-up.
- **Real push delivery.** Untestable in this environment — see
  docs/notifications.md §7.

### Deferred from Phase 11

- **Re-keying after a compromise.** Rotation re-wraps the account key; replacing
  it outright would mean re-encrypting every envelope and every backup, and
  needs a migration plan of its own.
- **Recovery-key rotation on its own.** A new recovery key is issued when the
  passphrase changes; issuing one without changing the passphrase is a separate
  flow.
- **Server-side proof of passphrase knowledge.** Rotation is authorised by the
  session alone, which is honest about what a zero-knowledge server can check.
  A verifier value would let the server reject a rotation from a client that
  never unlocked, and is worth revisiting with account recovery.

### Deferred from Phase 10

- **Multipart upload.** One PUT per archive. A practice with gigabytes of x-rays
  needs multipart with resume; the protocol already has the shape for it
  (`init` can return several URLs).
- **Streaming encryption.** The archive is encrypted in memory, inherited from
  Phase 5's bound. Multipart and streaming belong together.
- **Retention job.** `listExpired` exists and is tested; the scheduler that
  calls it arrives with the job runner in Phase 12.
- **Backup emails.** `email_status` is a column with no sender behind it yet
  (Phase 12).
- **"Finish workday".** The product's daily trigger (§24, §62) is a UI flow on
  top of "Back up now"; it belongs with the dashboard work once notifications
  can nag about a missed day.

### Deferred from Phase 9

- **File bytes.** Metadata replicates; the bytes need the encrypted-object
  upload built in Phase 10.
- **Envelope compaction.** Superseded envelopes below every device's cursor can
  be pruned; nothing needs it until a real account has history.
- **Settings sync.** `settings` is device-local until syncable preferences get
  a stable id namespace — the outbox addresses entities by uuid, and a bare key
  is not one.
- **Push-triggered sync.** Devices poll every 15 seconds while visible and on
  focus/reconnect. Server-initiated wake-ups belong with Web Push (Phase 12).

### Deferred from Phase 8

- **Tables for later phases.** Only what today's features use is created;
  `sync_envelopes`, `backups`, `reminder_schedules` and `audit_events` come with
  their phases.
- **Connection resilience.** The pool fails fast rather than retrying; a
  circuit breaker and read replicas belong with real traffic, not before it.
- **Object storage and the job queue.** `docker-compose.yml` runs PostgreSQL
  only; MinIO and the mail catcher arrive with Phase 10 and Phase 12, when
  something actually uses them.

### Deferred from Phase 7

- **Persistence.** Accounts, sessions and devices live in an in-memory adapter
  behind `src/storage/ports.ts`. That is Phase 8's job; the auth code does not
  change when the PostgreSQL adapter arrives, and its tests will run against
  both.
- **Password reset email.** The API issues the token and calls a hook; sending
  it is Phase 12 (docs/notifications.md §4). Until then the token is only
  available to the process that handles the hook.
- **Email verification and OIDC (Google, Apple).** The schema has the fields and
  `identities` is designed for it (docs/postgres-schema.md); neither is wired.
- **Session list and remote sign-out.** Devices can be listed and removed;
  listing active sessions is a separate surface.

### Deferred from Phase 6

- **Hour-grid day view.** The day view is a time-ordered list rather than a
  scrollable hour column with a current-time marker. The list is what a phone
  wants; the grid is a desk affordance and is worth building alongside
  drag-to-reschedule, not before it.
- **Recurring appointments.** Not in the product spec, and a recurrence rule
  changes the entity, the sync payload and the reminder scheduling at once. It
  needs its own design pass.
- **Reminder delivery.** Phase 6 records which reminders a user chose; creating
  the server-side schedule rows and delivering them is Phase 12
  (docs/notifications.md §1).

### Deferred from Phase 5

- **Streaming archives.** Export and import hold the archive in memory. The
  cloud backup path in Phase 10 needs streaming for databases larger than a
  phone's memory, and that is where it will be built.
- **Selective import.** Merge is all-or-nothing per archive. Picking individual
  clients out of a backup is a real need for a practice that shares data, but it
  needs a UI for choosing and a preview of the consequences, not just a flag.

### Deferred from Phase 4

- **Export nudge.** `docs/architecture.md` R1 calls for "nag for export when the
  last export is older than N days". The export itself lands in Phase 5, so the
  nudge is built there, on top of the `backups` table that already records
  every export attempt.
- **Offline runtime verification.** Automated where the logic is pure; the
  service worker itself is on the per-release manual checklist
  (`docs/mobile.md` §7). It could not be exercised in the development browser
  used during Phase 4 — registration was accepted and the precache was written,
  but no worker ever activated (`navigator.serviceWorker.ready` never
  resolved), which is a property of that browser profile, not of the build.

### Deferred from Phase 3

- **List virtualization.** Lists are cursor-paged, so the _query_ cost is flat,
  but the DOM grows as pages are appended. That is fine to ~1,000 rows and is
  revisited when the file grid and the calendar make it matter.
- **Search across first name, phone and notes.** Phase 3 ships surname prefix
  search, which the list index serves directly. Anything wider needs a token
  index built on write, and that is a schema change best made together with the
  Phase 5 import/export work.
- **Component tests.** The logic lives in services and repositories, which are
  covered; the pages are thin. Page-level coverage arrives with the Playwright
  suite in Phase 16.

Rule (§89): a phase does not start while the previous foundational phase is
broken. Discovering an architectural problem stops implementation and updates
`docs/architecture.md` first.
