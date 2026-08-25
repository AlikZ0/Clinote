-- Billing (docs/subscriptions.md §7).
--
-- Webhooks are the source of truth for subscription state; a checkout redirect
-- is only a UX signal. This table makes replays harmless.

CREATE TABLE billing_events (
  id           uuid PRIMARY KEY,
  provider     text NOT NULL,
  -- The provider's own event id. A webhook delivered twice must change nothing.
  external_id  text NOT NULL,
  type         text NOT NULL,
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  payload      jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

CREATE INDEX billing_events_user_idx ON billing_events (user_id, processed_at DESC);

-- Checkout sessions started but not yet confirmed.
CREATE TABLE billing_checkouts (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan_id     text NOT NULL REFERENCES plans (id),
  provider    text NOT NULL,
  external_id text,
  state       text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

CREATE INDEX billing_checkouts_user_idx ON billing_checkouts (user_id, created_at DESC);
