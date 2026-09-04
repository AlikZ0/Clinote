-- Phase 19: Link workspaces to organizations
-- Workspaces are now owned by organizations, not just users.
-- This column is nullable to support legacy workspaces during migration.

ALTER TABLE workspaces ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;

-- Add index for organization queries
CREATE INDEX idx_workspaces_organization_id ON workspaces(organization_id);

-- Add check constraint: all active workspaces must have an organization
-- (enforced at app level during/after migration, will become NOT NULL in Phase 19 P1)
