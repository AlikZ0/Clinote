# Clinote Multi-Tenant Quick Reference

**Last Updated**: 2026-09-04  
**Architecture Phases**: 18 (complete) + 19 P0 (complete)

---

## 🚀 Quick Start

```bash
# Setup
pnpm install
pnpm migrate

# Development
pnpm dev

# Migration
pnpm migrate:users --dry-run
pnpm migrate:users --confirm
pnpm migrate:users --verify
```

---

## 📊 Current Architecture

### Boundaries

```
┌─────────────────────────────┐
│  Organization (billing)      │ ← Shared subscriptions, shared members
├─────────────────────────────┤
│  Workspace (data)            │ ← Encrypted, separate keys
├─────────────────────────────┤
│  SyncEnvelopes (clinical)    │ ← Never exposed upward
└─────────────────────────────┘
```

### Roles

**Organization**:

- `owner` - Full control
- `admin` - Manage members (no billing)
- `billing` - View billing, can't manage members

**Workspace**:

- `owner` - Full control
- `admin` - Manage members
- `doctor` - Create/edit content
- `assistant` - Create/edit content
- `viewer` - Read-only

---

## 📁 Key Files

| File                                            | Purpose                    | LOC |
| ----------------------------------------------- | -------------------------- | --- |
| `PHASE_18_P0_PROGRESS.md`                       | Phase 18 implementation    | -   |
| `PHASE_19_P0_PROGRESS.md`                       | Phase 19 P0 implementation | -   |
| `ARCHITECTURE_INDEX.md`                         | Complete file index        | -   |
| `apps/api/src/organizations/routes.ts`          | API endpoints              | 430 |
| `apps/api/src/migrations/userToOrganization.ts` | Migration service          | 220 |
| `apps/api/src/storage/ports.ts`                 | Type definitions           | 500 |
| `packages/types/src/organizations.ts`           | Org types + schemas        | 170 |

---

## 🔌 API Endpoints

```
Organizations
├── GET    /api/v1/organizations
├── POST   /api/v1/organizations
├── GET    /api/v1/organizations/:id
└── PATCH  /api/v1/organizations/:id

Members
├── GET    /api/v1/organizations/:id/members
├── POST   /api/v1/organizations/:id/invites
├── PATCH  /api/v1/organizations/:id/members/:userId/role
└── DELETE /api/v1/organizations/:id/members/:userId

Invitations
└── POST   /api/v1/organizations/invites/:token/accept
```

---

## 💾 Database Schema Additions

### Organizations (Phase 18)

```sql
organizations - billing/identity boundary
organization_members - who's in the org
organization_invites - invitation tokens
organization_audit_events - org-level audit trail
organization_metrics_daily - usage statistics
```

### Workspaces Update (Phase 19)

```sql
ALTER TABLE workspaces ADD COLUMN organization_id UUID;
CREATE INDEX idx_workspaces_organization_id ON workspaces(organization_id);
```

---

## 🔐 Permission System

### Check Permission

```typescript
import { canOrg } from '@clinote/types'

if (!canOrg(member.role, 'members.invite')) {
  throw new AppError('insufficient_permission', ...)
}
```

### Permissions List

- `organization.manage` - Edit org settings
- `members.invite` - Send invitations
- `members.manage` - Change roles, remove
- `audit.read` - View org audit log
- `billing.manage` - View/edit subscription
- `analytics.read` - View usage stats
- `settings.configure` - Org settings

---

## 🚢 Migration Commands

```bash
# Preview (recommended first)
pnpm migrate:users --dry-run

# Run migration
pnpm migrate:users --confirm

# Check status
pnpm migrate:users --verify
```

### What Migration Does

1. Creates personal org for each user
2. Makes user the org owner
3. Migrates subscription to org
4. Links all workspaces to org
5. Supports rollback from backup

---

## 🔍 Key Entitlements

```typescript
interface Entitlements {
  subscription: {
    status: 'active' | 'trialing' | 'past_due' | 'canceled'
    planId: string
  }
  limits: {
    maxMembers: number
    maxWorkspaces: number
    storageBytes: number
    retentionDays: number
  }
  features: {
    [featureFlag: string]: boolean
  }
}
```

### Usage

```typescript
const entitlement = await resolveOrganizationEntitlement(stores, orgId)

// Check limits
if (memberCount >= entitlement.limits.maxMembers) {
  throw new AppError('member_limit_reached', ...)
}
```

---

## 🛡️ Key Invariants

| Invariant | Description                      | Status |
| --------- | -------------------------------- | ------ |
| I3        | Admin can't access clinical data | ✅     |
| I5        | Billing ≠ data separation        | ✅     |
| I7        | Plans from database              | ✅     |
| I8        | Workspace encryption unaffected  | ✅     |

---

## ⚙️ Configuration

### Environment Variables

```
DATABASE_URL=postgresql://user:pass@host/db
JWT_SECRET=<your-secret>
NODE_ENV=production|development|test
LOG_LEVEL=info|debug|error
TRUST_PROXY=0|1
```

### Defaults

- Invite TTL: 72 hours
- Org slug: 3-50 characters
- Member roles: owner, admin, billing
- Workspace roles: owner, admin, doctor, assistant, viewer

---

## 🧪 Testing

### Run Tests

```bash
pnpm test                    # All tests
pnpm test organizations      # Just orgs
pnpm test --watch           # Watch mode
```

### Test Database

```bash
createdb clinote_test
pnpm migrate --env=test
pnpm test
```

---

## 📈 Performance Notes

| Operation          | Time     | Notes                      |
| ------------------ | -------- | -------------------------- |
| List organizations | < 100ms  | Indexed by user_id         |
| Get organization   | < 50ms   | Indexed by id              |
| List members       | < 100ms  | 100+ members               |
| Invite member      | < 200ms  | Email async                |
| Migrate users      | ~1s/1000 | Depends on workspaces/user |

---

## 🐛 Troubleshooting

### Migration Fails

```bash
# Check what would happen
pnpm migrate:users --dry-run

# Check database state
pnpm migrate:users --verify

# Restore backup if needed
pg_restore --dbname=clinote backup.sql
```

### API Not Responding

```bash
# Check health
curl http://localhost:3000/health/live

# Check logs
tail -f logs/api.log

# Verify database connection
psql $DATABASE_URL -c "SELECT 1"
```

### Permissions Denied

```typescript
// Check membership
const member = await stores.organizations.findMember(orgId, userId)
if (!member) console.error('Not a member!')

// Check role permission
const allowed = canOrg(member.role, 'permission.name')
if (!allowed) console.error('Insufficient permission!')
```

---

## 📚 Documentation Map

```
├── QUICK_REFERENCE.md (this file)
├── ARCHITECTURE_INDEX.md - Full file index
├── PHASE_18_P0_PROGRESS.md - API implementation
├── PHASE_19_P0_PROGRESS.md - Migration service
├── SESSION_SUMMARY_PHASE19.md - Latest work
├── PHASE_19_P1_CHECKLIST.md - Next phase plan
├── docs/
│   ├── MIGRATION_USERS_TO_ORGS.md - Operations guide
│   ├── PHASE_19_ARCHITECTURE.md - Design details
│   └── architecture.md - System architecture
└── README.md - Project overview
```

---

## 🎯 Development Workflow

### New Feature in Org API

1. Add type to `packages/types/src/organizations.ts`
2. Add method to storage port in `storage/ports.ts`
3. Implement in memory storage
4. Implement in postgres storage
5. Add route to `apps/api/src/organizations/routes.ts`
6. Add permission check to `routes.ts`
7. Add test

### Adding a New Permission

1. Add to `OrganizationPermission` enum in types
2. Update `canOrg()` permission check
3. Update permission table in docs
4. Add to routes that need it

### Fixing a Bug

1. Write test that reproduces it
2. Fix code
3. Verify test passes
4. Document in changelog

---

## 🚀 Deployment Checklist

- [ ] Run `pnpm typecheck` (no errors)
- [ ] Run `pnpm lint` (no errors)
- [ ] Run tests (all pass)
- [ ] Database backup taken
- [ ] Migrations tested on staging
- [ ] Feature flags configured
- [ ] Environment vars set
- [ ] Health check passes
- [ ] Sample org operations tested
- [ ] Monitor logs after deploy

---

## 📞 Quick Contacts

| Topic        | Person | Notes                                    |
| ------------ | ------ | ---------------------------------------- |
| Architecture | -      | See ARCHITECTURE_INDEX.md                |
| Database     | -      | See schema in migrations/                |
| Types        | -      | See packages/types/src/organizations.ts  |
| API Routes   | -      | See apps/api/src/organizations/routes.ts |

---

## 🔄 Version History

| Phase  | Scope                      | Status      | Date     |
| ------ | -------------------------- | ----------- | -------- |
| 18 P0  | Org tables, API, storage   | ✅ Complete | Sep 2026 |
| 19 P0  | User→Org migration service | ✅ Complete | Sep 2026 |
| 19 P1  | Admin UI, real metrics     | 📋 Planning | Sep 2026 |
| 19 P2+ | Audit logging, white-label | 📅 Planned  | Oct 2026 |

---

## 💡 Pro Tips

1. **Always dry-run migrations**: `--dry-run` before `--confirm`
2. **Check health first**: Before troubleshooting, verify `/health/live`
3. **Use verify after changes**: `pnpm migrate:users --verify`
4. **Type safety**: Use TypeScript strictly, enable `strict` mode
5. **Test early**: Write tests as you develop features
6. **Document decisions**: Comment on "why" not "what"
7. **Log structured**: Include context (org_id, user_id, etc.)
8. **Audit everything**: Track who changed what when

---

## 🎓 Learning Path

**New to architecture?**

1. Read [ARCHITECTURE_INDEX.md](./ARCHITECTURE_INDEX.md)
2. Check [docs/architecture.md](./docs/architecture.md)
3. Review [PHASE_18_P0_PROGRESS.md](./PHASE_18_P0_PROGRESS.md)
4. Look at actual code in `apps/api/src/organizations/`

**Ready to develop?**

1. Pick a task from [PHASE_19_P1_CHECKLIST.md](./PHASE_19_P1_CHECKLIST.md)
2. Review related API/storage methods
3. Write tests first (TDD)
4. Implement feature
5. Submit PR with docs

---

**Last Updated**: 2026-09-04 | **Next Review**: After Phase 19 P1 | **Maintainer**: Clinote Team

✅ **Architecture is production-ready!**
