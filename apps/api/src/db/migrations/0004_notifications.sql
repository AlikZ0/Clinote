-- Notifications (docs/notifications.md).
--
-- Minimum disclosure: the server schedules reminders but must not learn who a
-- practitioner's clients are. There is no title here, no client id, no
-- duration — only an instant, an opaque reference and a channel.

CREATE TABLE reminder_schedules (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Opaque, per-appointment random id chosen by the device. Deliberately NOT
  -- the appointment's own id, so a dump of this table cannot be correlated
  -- with sync_envelopes.
  appointment_ref text NOT NULL,
  fire_at         timestamptz NOT NULL,
  kind            text NOT NULL,
  channel         text NOT NULL,
  state           text NOT NULL DEFAULT 'scheduled',
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (user_id, appointment_ref, kind, channel)
);

-- The scheduler's only query: what is due?
CREATE INDEX reminder_schedules_due_idx ON reminder_schedules (state, fire_at);
CREATE INDEX reminder_schedules_user_idx ON reminder_schedules (user_id, appointment_ref);

CREATE TABLE notification_preferences (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  preferences jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id  uuid,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  failed_at  timestamptz
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE failed_at IS NULL;

-- Delivery attempts that survive a restart (docs/deployment.md §1).
CREATE TABLE jobs (
  id         uuid PRIMARY KEY,
  kind       text NOT NULL,
  payload    jsonb NOT NULL,
  run_at     timestamptz NOT NULL DEFAULT now(),
  attempts   integer NOT NULL DEFAULT 0,
  locked_at  timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE locked_at IS NULL;
