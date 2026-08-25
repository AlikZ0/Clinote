-- Initial schema (docs/postgres-schema.md).
--
-- What this database holds: accounts, entitlements and routing metadata.
-- What it must never hold: client names, notes, files or anything else a
-- practitioner records about a person (docs/architecture.md I3).

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id                uuid PRIMARY KEY,
  email             citext NOT NULL,
  password_hash     text NOT NULL,
  name              text,
  locale            text,
  timezone          text,
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

-- Partial: a deleted account must not block re-registration of the address.
CREATE UNIQUE INDEX users_email_active_key ON users (email) WHERE deleted_at IS NULL;

CREATE TABLE identities (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider   text NOT NULL,
  subject    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE devices (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       text NOT NULL,
  platform   text NOT NULL,
  last_seen  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX devices_user_active_idx ON devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the refresh token. The token itself is never stored.
  refresh_token_hash text NOT NULL UNIQUE,
  family_id          uuid NOT NULL,
  device_id          uuid,
  ip                 inet,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);

CREATE INDEX sessions_family_idx ON sessions (family_id);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_resets_user_idx ON password_resets (user_id);

CREATE TABLE plans (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  price_amount   integer NOT NULL,
  price_currency text NOT NULL,
  price_interval text NOT NULL,
  features       jsonb NOT NULL,
  limits         jsonb NOT NULL,
  is_public      boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY,
  user_id                  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan_id                  text NOT NULL REFERENCES plans (id),
  status                   text NOT NULL,
  provider                 text,
  provider_subscription_id text,
  current_period_end       timestamptz,
  cancel_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- One live subscription per account; history arrives with billing (Phase 13).
CREATE UNIQUE INDEX subscriptions_user_key ON subscriptions (user_id);
