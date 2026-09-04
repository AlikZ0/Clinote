-- Organizations layer (Phase 18 P0).
--
-- Organizations are the BILLING and IDENTITY boundary.
-- Workspaces remain the DATA boundary (one workspace = one data key, one IndexedDB).
--
-- An organization can own multiple workspaces. A workspace belongs to exactly one org.
-- Subscriptions move from users to organizations.
-- Org members are the BILLING team (can manage plan, seats, payment method).
-- Workspace members are the DATA team (can access encrypted records).
-- These are separate and deliberately kept apart (docs/architecture.md).

-- Organizations: the commercial unit, branding container, billing boundary.
CREATE TABLE organizations (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE, -- For white-label domains: company.example.com, example.com/org/slug
  owner_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT, -- Cannot orphan an org

  -- White-label branding (Phase 22).
  logo_url        text,
  primary_color   text, -- hex or CSS color
  secondary_color text,
  custom_domain   text UNIQUE, -- e.g., company.clinote.com or clinote.company.com

  -- Org settings.
  settings        jsonb NOT NULL DEFAULT '{}', -- SSO config, feature flags per tenant, etc.

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX organizations_owner_idx ON organizations (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX organizations_custom_domain_idx ON organizations (custom_domain) WHERE custom_domain IS NOT NULL;

-- Org billing members: can manage subscription, seats, payment method.
-- Separate from workspace members to enforce separation of billing and data.
CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text NOT NULL, -- 'owner', 'admin', 'billing' (no 'doctor', no 'patient')
  invited_at      timestamptz NOT NULL DEFAULT now(),
  joined_at       timestamptz,
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX organization_members_user_idx ON organization_members (user_id);

-- Org invitations (separate from workspace invites).
CREATE TABLE organization_invites (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email            citext NOT NULL,
  role             text NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  invited_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX organization_invites_org_idx ON organization_invites (organization_id)
  WHERE accepted_at IS NULL;

-- Add organization_id to workspaces.
-- For backwards compatibility during migration, allow NULL (will be populated).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE;

-- Index for querying an org's workspaces.
CREATE INDEX IF NOT EXISTS workspaces_organization_idx ON workspaces (organization_id) WHERE deleted_at IS NULL;

-- Subscriptions move from users to organizations.
-- Remove the old UNIQUE constraint on user_id.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_key;

-- Add organization_id to subscriptions.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE;

-- New constraint: one live subscription per organization (not per user).
CREATE UNIQUE INDEX subscriptions_organization_key ON subscriptions (organization_id)
  WHERE status = 'active';

-- Keep user_id for audit, but it no longer drives entitlements.
CREATE INDEX subscriptions_organization_idx ON subscriptions (organization_id, updated_at DESC);

-- Org audit log (distinct from workspace audit log).
CREATE TABLE organization_audit_events (
  id               bigserial PRIMARY KEY,
  organization_id  uuid REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users (id) ON DELETE SET NULL,
  action           text NOT NULL,
  resource_type    text,
  resource_id      uuid,
  details          jsonb, -- JSON change details for non-sensitive fields (e.g., plan change, seat count)
  ip               inet,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX organization_audit_events_org_idx ON organization_audit_events (organization_id, created_at DESC);
CREATE INDEX organization_audit_events_user_idx ON organization_audit_events (user_id, created_at DESC);

-- Usage metrics rolled up daily per org (Phase 19, for analytics that don't touch client data).
-- Never queries sync_envelopes, only aggregates.
CREATE TABLE organization_metrics_daily (
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  date             date NOT NULL,

  -- Counts (metadata only, never client data).
  workspace_count  integer NOT NULL DEFAULT 0,
  member_count     integer NOT NULL DEFAULT 0,
  active_devices   integer NOT NULL DEFAULT 0,

  -- Storage usage in bytes.
  storage_bytes    bigint NOT NULL DEFAULT 0,

  -- Sync stats.
  envelope_count   bigint NOT NULL DEFAULT 0,
  envelope_bytes   bigint NOT NULL DEFAULT 0,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (organization_id, date)
);

-- Constraints and rules for the Phase 18 invariant: no org without a workspace, no workspace without an org.
-- This will be enforced at app level during migration (Phase 18 will migrate existing workspaces to orgs).
