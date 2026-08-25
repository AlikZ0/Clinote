# Backend database schema (PostgreSQL)

PostgreSQL stores **accounts, entitlements and ciphertext routing metadata**.
It does not store client medical data (§34, I3).

## Tables

```sql
users(
  id uuid pk, email citext unique not null, password_hash text,
  name text, locale text, timezone text,
  email_verified_at timestamptz, created_at, updated_at, deleted_at)

identities(                                  -- ready for Google/Apple (§35)
  id uuid pk, user_id uuid fk, provider text, subject text,
  created_at, unique(provider, subject))

sessions(
  id uuid pk, user_id uuid fk, refresh_token_hash text, family_id uuid,
  device_id uuid null, ip inet, user_agent text,
  expires_at, revoked_at, created_at)

user_keys(                                   -- wrapped key material only
  user_id uuid pk fk, kdf text, salt bytea, iterations int,
  wrapped_dek_sync bytea, wrapped_dek_recovery bytea, updated_at)

devices(
  id uuid pk, user_id uuid fk, name text, platform text,
  last_seen timestamptz, created_at, revoked_at)

subscriptions(
  id uuid pk, user_id uuid fk, plan_id text, status text,
  provider text, provider_subscription_id text,
  current_period_end timestamptz, cancel_at timestamptz,
  created_at, updated_at)

plans(                                       -- catalog is data, not code (§7)
  id text pk, name text, price_amount int, price_currency text,
  price_interval text, features jsonb, limits jsonb,
  is_public bool, sort_order int, updated_at)

backups(
  id uuid pk, user_id uuid fk, workspace_id uuid null, device_id uuid fk,
  object_key text, size_bytes bigint, checksum text,
  app_version text, database_version int,
  backup_status text, email_status text,        -- separate, §77
  error_code text, created_at, completed_at, expires_at)

storage_usage(
  user_id uuid pk fk, bytes_used bigint, objects int, updated_at)

sync_envelopes(
  seq bigserial pk, user_id uuid fk, workspace_id uuid null,
  operation_id uuid unique, entity_type text, entity_id uuid,
  operation text, hlc text, device_id uuid, payload bytea,
  created_at,
  index (user_id, workspace_id, seq))

sync_cursors(
  device_id uuid pk fk, user_id uuid fk, workspace_id uuid null,
  last_seq bigint, updated_at)

reminder_schedules(                           -- minimum disclosure (§notifications)
  id uuid pk, user_id uuid fk, appointment_ref text, fire_at timestamptz,
  kind text, channel text, state text, attempts int,
  created_at, sent_at,
  index (state, fire_at))

notification_preferences(
  user_id uuid pk fk, preferences jsonb, updated_at)

push_subscriptions(
  id uuid pk, user_id uuid fk, device_id uuid fk,
  endpoint text unique, p256dh text, auth text, created_at, failed_at)

workspaces(
  id uuid pk, owner_user_id uuid fk, name text,
  created_at, updated_at, deleted_at)

workspace_members(
  workspace_id uuid fk, user_id uuid fk, role text,
  invited_at, joined_at, primary key (workspace_id, user_id))

audit_events(                                 -- no content, §78
  id bigserial pk, workspace_id uuid null, user_id uuid fk, action text,
  resource_type text, resource_id uuid null, ip inet, user_agent text,
  created_at,
  index (workspace_id, created_at desc))

jobs(                                         -- if the Postgres queue driver is used
  id uuid pk, kind text, payload jsonb, run_at timestamptz,
  attempts int, locked_at, last_error text, created_at)
```

## What Phase 8 implemented

`apps/api/src/db/migrations/0001_init.sql` creates `users`, `identities`,
`devices`, `sessions`, `password_resets`, `plans` and `subscriptions` — the
tables the current features need. The remaining tables in this document
(`sync_envelopes`, `backups`, `reminder_schedules`, `audit_events`, …) arrive
with the phases that use them; adding empty tables early only invites schema
drift.

Two details the implementation settled:

- **`users_email_active_key` is a partial unique index** (`WHERE deleted_at IS
NULL`). A deleted account must not permanently reserve its email address.
- **Timestamps cross the boundary as ISO strings.** `pg` is configured to parse
  `timestamptz` into a string rather than a `Date`, because every timestamp in
  this system — ports, API contract, sync envelopes, archives — is an ISO
  string. Converting to `Date` here and back later is where timezone bugs start.

Migrations are forward-only, run inside a transaction, and take an advisory lock
so two instances starting together cannot both apply the same file.

## What Phase 14 added

`workspaces`, `workspace_members`, `workspace_invites`, `audit_events`,
`user_identity_keys`, `workspace_keys`; `sync_envelopes.workspace_id` put to
use; `sync_cursors` re-keyed to (device, workspace).

Points worth knowing before changing them:

- `workspace_invites.token_hash` stores SHA-256 of the emailed code, never the
  code — the same rule as password resets.
- `workspace_keys.sealed_key` is opaque JSON. No query may inspect it, and
  there is no column that could hold an unsealed key.
- `audit_events.resource_id` holds ids the server already relays. There is no
  column for content, and none may be added.
- `sync_cursors` gained a surrogate primary key plus a unique index on
  `(device_id, coalesce(workspace_id, <zero uuid>))`, because a device now has
  one cursor per stream rather than one in total.

## Notes

- `sync_envelopes.payload` is ciphertext. There is no column that could hold a
  client name, and none may ever be added.
- `entity_id` is a client-generated UUID — opaque to the server.
- `reminder_schedules.appointment_ref` is deliberately _not_ the appointment id,
  so a dump of this table cannot be joined against `sync_envelopes`.
- Row-level scoping: every query filters by `user_id` (and `workspace_id` for
  Business) in the statement itself.
- Retention and cleanup jobs operate on `backups.expires_at` and on
  `sync_envelopes` compaction (superseded envelopes for the same `entity_id`
  below every device's cursor can be pruned).
