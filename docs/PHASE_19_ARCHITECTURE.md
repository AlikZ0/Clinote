# Phase 19: Multi-Tenant Migration Architecture

## Overview

Phase 19 implements the operational side of multi-tenancy: converting existing users to personal organizations, linking workspaces, and migrating subscriptions.

### Architecture Layers

```
┌─────────────────────────────────────────┐
│ Frontend / Admin UI (Phase 19 P2)        │ User-facing org management
├─────────────────────────────────────────┤
│ API Routes (Phase 18 P0)                 │ /api/v1/organizations/* endpoints
├─────────────────────────────────────────┤
│ Entitlements (Phase 18 P0)               │ resolveOrganizationEntitlement()
├─────────────────────────────────────────┤
│ Migration Service (Phase 19 P1)          │ user → org conversion
├─────────────────────────────────────────┤
│ Storage Layer (Phase 18 P0 + 19 P1)      │ Organizations + Workspaces linked
├─────────────────────────────────────────┤
│ Database Schema (Phase 18 P0 + 19 P1)    │ organizations + workspaces.org_id
└─────────────────────────────────────────┘
```

## Data Model Evolution

### Before Migration (Phase 17)

```
User
├── owns Subscription(user_id)
└── owns Workspaces[]

Workspace
├── members: WorkspaceMembers[]
└── contains: SyncEnvelopes[] (clinical data)
```

### After Migration (Phase 19)

```
Organization (NEW)
├── owns Subscription(organization_id)
├── has Members (org_members)
└── owns Workspaces[]

Workspace
├── links to Organization(organization_id)
├── members: WorkspaceMembers[] (separate from org)
└── contains: SyncEnvelopes[] (clinical data)

User
├── is member of Organization (with org role)
└── is member of Workspaces (with workspace role)
```

### Subscription Model

**Before:**

```typescript
interface Subscription {
  user_id: string    // WHO owns this subscription
  planId: string
  status: 'active' | 'past_due' | ...
}
```

**After:**

```typescript
interface Subscription {
  user_id: string | null      // LEGACY: for backward compatibility
  organization_id: string     // NEW: who owns this subscription
  planId: string
  status: 'active' | 'past_due' | ...
}
```

## Invariants Preserved

### I3: Admin Panel Zero Data Access

✅ **Maintained**: Organization audit logs don't touch `sync_envelopes`

- Organization layer: billing, members, settings only
- Workspace layer: clinical data, remains encrypted
- Audit trail: separate `organization_audit_events` table

### I5: Billing vs Data Separation

✅ **Maintained**: Two distinct member tables

- `organization_members` - billing/identity (owner, admin, billing roles)
- `workspace_members` - data access (owner, admin, doctor, assistant, viewer roles)
- One user can be: org member without workspace access, or workspace member without org access

### I7: Database-Driven Plans

✅ **Maintained**: Plans loaded from `plans` table, not hardcoded

## Migration Strategy

### Three-Phase Approach

**Phase 1: User → Organization Conversion** (This phase)

```
For each user:
  1. Create organization (slug from email)
  2. Add user as owner
  3. Migrate subscription (if exists)
  4. Link all workspaces
```

**Phase 2: Admin Panel** (Next)

```
UI for:
  - Organization dashboard
  - Member management
  - Invite system
  - Role assignments
```

**Phase 3: Complete Enforcement**

```
After all systems tested:
  - Make workspaces.organization_id NOT NULL
  - Remove user_id fallback from subscriptions
  - Full validation everywhere
```

## Storage Layer Details

### UserStore Changes

**Added:** `listAll()` method

- Returns all non-deleted users
- Used by migration to iterate over all accounts
- Optional: implementations can return empty if not applicable

### WorkspaceStore Changes

**Added:**

- `organizationId` field to WorkspaceRecord
- `listAll()` method to enumerate all workspaces
- Update logic to set `organizationId`

### Backward Compatibility

- `organizationId` is nullable (during migration)
- Queries support both paths:
  ```typescript
  const subscription =
    (await stores.subscriptions.findByUserId(userId)) ??
    (await stores.subscriptions.findByOrganizationId(orgId))
  ```

## Migration Service API

### Main Function

```typescript
async migrateUsersToOrganizations(
  stores: Stores,
  options?: {
    userIds?: string[]      // Migrate specific users (for testing)
    dryRun?: boolean        // Don't commit changes
    onProgress?: (p) => void // Callback for updates
  }
): Promise<MigrationProgress>
```

### Verification Function

```typescript
async verifyMigration(stores: Stores): Promise<{
  usersWithoutOrg: string[]
  usersWithOrg: number
  workspacesWithoutOrg: number
}>
```

## Error Handling Strategy

### Individual User Failures

- Caught and logged
- Migration continues for other users
- Reported in final summary

### Dry-Run Validation

- Simulates entire migration
- Catches most issues before production
- Shows exact counts that will change

### Post-Migration Verification

- Identifies any incomplete conversions
- Reports which users/workspaces need attention
- Can re-run migration for stragglers

## Database Considerations

### Migration SQL

```sql
ALTER TABLE workspaces ADD COLUMN organization_id UUID
  REFERENCES organizations(id) ON DELETE RESTRICT;
CREATE INDEX idx_workspaces_organization_id ON workspaces(organization_id);
```

### Why RESTRICT?

- Prevents accidental organization deletion if it owns workspaces
- Enforces data integrity

### Index Strategy

- Quick lookups of workspaces by org
- Used when loading organization dashboard
- Essential for org-based features

## Security Implications

### Access Control

Before migration:

- User can access their subscriptions and workspaces directly

After migration:

- User must be in organization to access its subscriptions
- User must be in workspace to access its data
- Two independent membership checks

### Audit Trail

- Organization changes logged in `organization_audit_events`
- Workspace changes logged in `audit_events`
- Separate because org audit is visible to billing team, not data team

## Performance Expectations

### Migration Performance

- ~1-10 seconds per 1000 users
- Depends on: number of workspaces per user, DB performance
- Dry-run is fast (no DB writes)

### Post-Migration Performance

- Minimal impact on existing queries
- Some queries become org-aware (new indexes help)
- Clinical data queries unaffected (workspace layer unchanged)

## Testing Strategy

### Unit Level

- Migration service functions tested independently
- Verify slug generation
- Test dry-run vs actual execution

### Integration Level

- Full migration on test database
- Verify all users → orgs
- Verify all subscriptions → org_id
- Verify all workspaces → organization_id

### Production Level

1. Dry-run on production data
2. Review counts
3. Actual migration during maintenance window
4. Post-migration verification
5. Monitor logs for errors

## Future Phases (Not Yet Implemented)

### Phase 2: Admin UI

- Organization management dashboard
- Member invitation UI
- Bulk operations
- Settings customization

### Phase 3: Real Metrics

- Storage usage calculation
- Member limit enforcement
- Quota warnings

### Phase 4: Audit Logging

- Organization-level event logging
- Member change tracking
- Settings change history

### Phase 5+: White-Labeling

- Custom domains per organization
- Branding customization (logos, colors)
- SSO/SCIM integration

## Rollback Considerations

If migration fails:

1. Database backup available
2. Migration is idempotent (can run multiple times)
3. No destructive operations (only adds columns, inserts, updates)
4. Rollback: restore from backup, fix issues, retry

## Next Steps

1. **Test** - Run migration on staging environment
2. **Verify** - Check all migrations succeeded
3. **Deploy** - Apply to production during maintenance window
4. **Monitor** - Watch API logs for any issues
5. **Proceed** - Move to Phase 19 P2 (Admin UI)

---

## Related Documents

- [Migration Guide](./MIGRATION_USERS_TO_ORGS.md) - Step-by-step operational instructions
- [Phase 18 P0](../PHASE_18_P0_PROGRESS.md) - API endpoints and storage
- [Phase 19 P0 Progress](../PHASE_19_P0_PROGRESS.md) - Implementation details
- [Architecture](./architecture.md) - Overall system design
