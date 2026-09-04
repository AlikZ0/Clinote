# User → Organization Migration Guide

**Phase 19 P0**: Convert Clinote from single-tenant to multi-tenant architecture.

## Overview

This migration converts existing users to organizations, establishing the new multi-tenant billing and identity boundary. Each user becomes the owner of a personal organization, and their workspaces are linked to that organization.

### Timeline
- **Before migration**: Users own subscriptions and workspaces directly
- **After migration**: Organizations own subscriptions and workspaces; users are org members

### Key Changes
- Users become members of personal organizations
- Subscriptions move from `user_id` → `organization_id`
- Workspaces link to `organization_id`
- Backward compatibility: both `user_id` and `organization_id` supported during transition

---

## Prerequisites

1. **Database**: PostgreSQL with latest migrations applied
   ```bash
   pnpm migrate  # Run all pending migrations
   ```

2. **Environment**: DATABASE_URL must be set
   ```bash
   export DATABASE_URL="postgresql://user:pass@localhost/clinote"
   ```

3. **Backup**: Take a database backup before running
   ```bash
   pg_dump $DATABASE_URL > backup_before_migration.sql
   ```

---

## Migration Process

### Step 1: Dry-Run (Always Run First!)

Simulate the migration without writing anything to the database:

```bash
cd apps/api
pnpm migrate:users --dry-run
```

**Expected output:**
```
🧪 Running migration in DRY-RUN mode (no changes will be written)

  [100%] 247/247 users | 247 orgs | 247 subscriptions | 524 workspaces

📊 Migration Results:
  Total users:              247
  Processed:                247
  Created organizations:    247
  Migrated subscriptions:   247
  Linked workspaces:        524
  Skipped (already migrated): 0
  Errors: 0

✨ This was a dry-run. No changes were made.
   Run with --confirm to commit the migration.
```

**Review the numbers:**
- Do all users have organizations?
- Do subscription and workspace counts look right?
- Are there any errors?

### Step 2: Run Actual Migration

Once you've verified the dry-run looks good:

```bash
pnpm migrate:users --confirm
```

**This will:**
1. Create personal organizations for all users
2. Add users as org owners
3. Migrate subscriptions to org_id
4. Link all workspaces to organizations

⏱️ **Duration**: ~1-10 seconds per 1000 users

### Step 3: Verify Migration

Check that migration completed successfully:

```bash
pnpm migrate:users --verify
```

**Expected output (success):**
```
📊 Verifying migration status...

✅ Users with organization: 247
❌ Workspaces without organization: 0

🎉 Migration appears complete!
```

**If problems found:**
```
📊 Verifying migration status...

✅ Users with organization: 245
⚠️  Users WITHOUT organization: 2
   IDs: user-123, user-456
❌ Workspaces without organization: 8

⚠️  Migration incomplete or issues found.
```

→ **Fix**: Manually re-run migration for missing users, or contact support

---

## Rollback Procedure

If migration fails catastrophically:

```bash
# 1. Stop the API
# 2. Restore database from backup
pg_restore --dbname=clinote backup_before_migration.sql

# 3. Verify backup restore
pnpm migrate:users --verify

# 4. Restart API
```

---

## What Each Phase Does

### Phase 1: Migration Service ✅ (Complete)
- Converts users to organizations
- Migrates subscriptions
- Links workspaces
- **Status**: Ready for deployment

### Phase 2: Admin UI (Next)
- Dashboard to manage organizations
- Member invites and role management
- Billing and subscription settings

### Phase 3: Real Metrics
- Calculate actual storage usage
- Enforce member limits per plan

### Phase 4: Audit Logging
- Log organization-level changes
- Separate from workspace audit

---

## Frequently Asked Questions

### Q: Can I run migration on a production database?
**A**: Yes, with proper precautions:
1. Always dry-run first on production data
2. Take a backup before running
3. Run during low-traffic period
4. Have rollback plan ready

### Q: What about existing org members who aren't the creator?
**A**: They get added to the personal organization with appropriate roles (determined in Phase 2)

### Q: Will this break any existing API calls?
**A**: No. The migration maintains backward compatibility:
- Subscriptions check both `user_id` and `organization_id`
- All existing APIs continue to work
- The entitlements layer handles both paths

### Q: What if a user already has an organization?
**A**: They're skipped (counted in "Skipped" results). No duplicates created.

### Q: How long does migration take?
**A**: ~1-10 seconds per 1000 users
- Example: 10,000 users ≈ 30-60 seconds

### Q: Can I run this multiple times?
**A**: Yes. Running a second time will skip users who already have orgs.

### Q: What about deleted users?
**A**: They're ignored (not migrated).

---

## Monitoring & Support

### Logs to Watch For

After migration, check API logs for:
- `Error: organization not found` - Indicates database inconsistency
- `subscription org_id mismatch` - Rare, indicates data corruption

### Support

If migration fails or you need help:

1. **Check error output** - Includes failed user IDs
2. **Run verify** - Shows what's missing
3. **Review logs** - API logs for specific errors
4. **Restore backup** - If needed
5. **Contact team** - With backup dump of `organizations` table

---

## Technical Details

### Generated Organization Slugs

From email address (guaranteed unique):

| Email | Slug |
|-------|------|
| john.doe@example.com | john.doe |
| alice.smith@company.co.uk | alice.smith |
| a@short.io | org-a |
| test+tag@test.com | test-tag |

### Database Changes

New column added to workspaces:
```sql
ALTER TABLE workspaces ADD COLUMN organization_id UUID REFERENCES organizations(id);
CREATE INDEX idx_workspaces_organization_id ON workspaces(organization_id);
```

### Migration Statistics Collected

- Users total/processed
- Organizations created
- Subscriptions migrated
- Workspaces linked
- Errors with user IDs

---

## After Migration

### What Changes for Users

1. **No visible change** initially - Everything continues to work

2. **Coming Soon (Phase 2+)**:
   - Organization dashboard
   - Member management UI
   - Admin panel access
   - Organization settings

### What Changes for Developers

1. **Entitlements**: Now support both `userId` and `organizationId`
   ```typescript
   const entitlement = await resolveOrganizationEntitlement(stores, orgId)
   ```

2. **Workspace queries**: Include `organization_id` in schema

3. **Audit logging**: Org-level events separate from workspace events

4. **Subscriptions**: Check both paths for backward compatibility

---

## Success Checklist

- [x] Database backup taken
- [x] Latest migrations applied
- [x] Dry-run executed and reviewed
- [x] Production migration run (--confirm)
- [x] Verification passed (--verify)
- [x] No error logs during migration
- [x] API still responding to requests
- [x] Sample users can still login
- [x] Workspaces still accessible
- [x] Subscriptions still working

---

**Ready to migrate?** Follow the steps in "Migration Process" section above! 🚀
