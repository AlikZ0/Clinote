-- Cloud backup metadata (docs/backup.md §4, docs/postgres-schema.md).
--
-- The archive itself lives in object storage and is encrypted on the device.
-- This table holds only what verification, history and quotas need.

CREATE TABLE backups (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id        uuid NOT NULL,
  object_key       text NOT NULL UNIQUE,
  size_bytes       bigint NOT NULL,
  -- SHA-256 of the ciphertext, as the device computed it before uploading.
  checksum         text NOT NULL,
  -- Wrapped with the user's key-encryption key. The server cannot unwrap it.
  wrapped_dek      jsonb NOT NULL,
  app_version      text NOT NULL,
  database_version integer NOT NULL,
  -- Separate from email_status on purpose: a bounced message is not a failed
  -- backup (product spec §77).
  backup_status    text NOT NULL DEFAULT 'pending',
  email_status     text NOT NULL DEFAULT 'pending',
  error_code       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz
);

CREATE INDEX backups_user_created_idx ON backups (user_id, created_at DESC);
CREATE INDEX backups_expiry_idx ON backups (expires_at) WHERE backup_status = 'completed';

CREATE TABLE storage_usage (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  bytes_used bigint NOT NULL DEFAULT 0,
  objects    integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
