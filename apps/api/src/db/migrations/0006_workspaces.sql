-- Business workspaces, roles and the audit log (docs/postgres-schema.md,
-- product spec §41–§44).
--
-- The audit log records who did what and when. It never records what was in a
-- record, because the server cannot read one (docs/security.md §8).

CREATE TABLE workspaces (
  id            uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX workspaces_owner_idx ON workspaces (owner_user_id) WHERE deleted_at IS NULL;

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         text NOT NULL,
  invited_at   timestamptz NOT NULL DEFAULT now(),
  joined_at    timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE workspace_invites (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email        citext NOT NULL,
  role         text NOT NULL,
  -- SHA-256 of the emailed token; the token itself is never stored.
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_invites_workspace_idx ON workspace_invites (workspace_id)
  WHERE accepted_at IS NULL;

CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  action       text NOT NULL,
  resource_type text,
  -- An opaque id. For client data it is the entity id the device chose, which
  -- the server already relays and still cannot read.
  resource_id  uuid,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_workspace_idx ON audit_events (workspace_id, created_at DESC);
CREATE INDEX audit_events_user_idx ON audit_events (user_id, created_at DESC);

-- Envelopes and backups belong to a workspace when one is in use.
ALTER TABLE sync_cursors DROP CONSTRAINT IF EXISTS sync_cursors_pkey;
ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS id uuid;
UPDATE sync_cursors SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE sync_cursors ALTER COLUMN id SET NOT NULL;
ALTER TABLE sync_cursors ADD PRIMARY KEY (id);

-- One cursor per device *and* workspace: a device syncing two workspaces has
-- two independent positions in two independent streams.
CREATE UNIQUE INDEX sync_cursors_device_workspace_key
  ON sync_cursors (device_id, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Shared access to encrypted data (docs/encryption.md §9).
--
-- A workspace has one data key. It is generated on a member's device and
-- handed to each other member sealed to that member's public key, so the
-- server relays access without ever holding it.

CREATE TABLE user_identity_keys (
  user_id             uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- base64 SPKI of an ECDH P-256 public key. Public by design.
  public_key          text NOT NULL,
  -- The matching private key, wrapped with the account data key.
  wrapped_private_key jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Opaque to the server: the workspace key sealed to this member.
  sealed_key   jsonb NOT NULL,
  granted_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Envelopes are pulled per workspace, not per account, once one is in use.
CREATE INDEX sync_envelopes_workspace_idx ON sync_envelopes (workspace_id, seq)
  WHERE workspace_id IS NOT NULL;
