-- Cloud Sync (docs/sync.md) and the wrapped key material it needs
-- (docs/encryption.md §5).
--
-- `payload` is ciphertext. There is no column here that could hold a client
-- name, and none may ever be added (docs/architecture.md I3).

CREATE TABLE user_keys (
  user_id              uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  kdf                  text NOT NULL,
  salt                 text NOT NULL,
  iterations           integer NOT NULL,
  -- Wrapped by a key derived from the user's passphrase. The server cannot
  -- unwrap these and must never be able to.
  wrapped_dek_sync     jsonb NOT NULL,
  wrapped_dek_recovery jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_envelopes (
  seq          bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id uuid,
  -- Idempotency: a retried push is accepted once.
  operation_id uuid NOT NULL UNIQUE,
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  operation    text NOT NULL,
  hlc          text NOT NULL,
  -- The version the sender's record had before this change; null for a
  -- creation. Relayed unchanged so receivers can detect divergence.
  base_hlc     text,
  device_id    uuid NOT NULL,
  payload      bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The pull query: everything for one account after a cursor, in order.
CREATE INDEX sync_envelopes_stream_idx ON sync_envelopes (user_id, seq);
-- Compaction (superseded versions of one entity) will use this.
CREATE INDEX sync_envelopes_entity_idx ON sync_envelopes (user_id, entity_id, seq DESC);

CREATE TABLE sync_cursors (
  device_id    uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id uuid,
  last_seq     bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sync_cursors_user_idx ON sync_cursors (user_id);
