-- Phase 19: Link workspaces to organizations.
--
-- Superseded by 0007_organizations.sql, which already adds
-- workspaces.organization_id and workspaces_organization_idx.
--
-- As first written this file repeated both without IF NOT EXISTS, so it raised
-- 42701 duplicate_column on every database that had applied 0007 — which is
-- every database. Migrations run in a transaction (db/migrate.ts), so the whole
-- chain stopped here and no schema past 0007 could ever be applied.
--
-- A released migration is never deleted (docs/deployment.md §4). This one never
-- applied anywhere, so it is reduced to an idempotent no-op that leaves 0007's
-- column and index exactly as they are.
--
-- Note: 0007 declares the foreign key ON DELETE CASCADE. This file originally
-- declared ON DELETE RESTRICT. Whether deleting an organization should take its
-- workspaces with it is a product decision, not a migration detail, so the
-- shipped CASCADE stands until that decision is made.
--
-- The column stays nullable; it is filled by the user-to-organization migration
-- (apps/api/src/migrations/userToOrganization.ts).

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS workspaces_organization_idx
  ON workspaces (organization_id) WHERE deleted_at IS NULL;
