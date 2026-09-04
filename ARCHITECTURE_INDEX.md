# Clinote Multi-Tenant Architecture Index

**Status**: Phase 18 P0 ✅ + Phase 19 P0 ✅  
**Last Updated**: 2026-09-04

---

## Quick Navigation

### Current Implementation (Phases 18-19)
- [📋 Phase 18 P0 Progress](./PHASE_18_P0_PROGRESS.md) - APIs, types, storage
- [📋 Phase 19 P0 Progress](./PHASE_19_P0_PROGRESS.md) - Migration service
- [🚀 Session Summary](./SESSION_SUMMARY_PHASE19.md) - Latest session work

### Documentation
- [📚 Architecture Docs](./docs/PHASE_19_ARCHITECTURE.md) - System design
- [🔄 Migration Guide](./docs/MIGRATION_USERS_TO_ORGS.md) - Operational instructions
- [🏗️ Architecture Overview](./docs/architecture.md) - Clinote design principles

---

## File Structure

### Database Layer

#### Migrations
```
apps/api/src/db/migrations/
├── 0007_organizations.sql        ← Phase 18: Create organizations tables
└── 0008_workspaces_organization_id.sql ← Phase 19: Link workspaces to orgs
```

**What's Created:**
- `organizations` - Billing/identity boundary
- `organization_members` - Who's in the org
- `organization_invites` - Invitation tokens
- `organization_audit_events` - Org-level audit trail
- `organization_metrics_daily` - Usage metrics

### Storage Layer

#### Type Definitions
```
apps/api/src/storage/ports.ts
├── OrganizationRecord
├── OrganizationMemberRecord
├── OrganizationInviteRecord
├── OrganizationStore interface (28 methods)
├── WorkspaceRecord (+ organizationId field)
├── UserStore (+ listAll() method)
└── WorkspaceStore (+ listAll() method)
```

#### Memory Adapter
```
apps/api/src/storage/memory.ts
├── OrganizationStore (28 methods)
├── updated SubscriptionStore (org_id support)
├── updated UserStore (+ listAll())
└── updated WorkspaceStore (+ listAll())
```

#### PostgreSQL Adapter
```
apps/api/src/storage/postgres/index.ts
├── OrganizationStore (SQL queries)
│  ├── create, findById, findBySlug, findByCustomDomain
│  ├── listForUser, update, softDelete
│  ├── listMembers, findMember, countMembers, putMember, removeMember
│  ├── createInvite, findInviteByTokenHash, listPendingInvites
│  └── markInviteAccepted, deleteInvite
├── updated WorkspaceRow (+ organization_id)
├── updated WorkspaceStore (+ organizationId handling, listAll())
├── updated UserStore (+ listAll())
└── updated SubscriptionStore (org_id support)
```

### API Layer

#### Types
```
packages/types/src/organizations.ts (170 LOC)
├── OrganizationRole enum (owner, admin, billing)
├── Permissions system (7 permissions)
├── Schemas (Zod validators)
│  ├── organizationSchema
│  ├── organizationMemberSchema
│  ├── organizationBrandingSchema
│  └── organizationSettingsSchema
├── Request/Response schemas
├── Audit action types
└── canOrg() permission checker
```

#### Routes
```
apps/api/src/organizations/routes.ts (430 LOC)
├── GET /api/v1/organizations
├── POST /api/v1/organizations
├── GET /api/v1/organizations/:id
├── PATCH /api/v1/organizations/:id
├── GET /api/v1/organizations/:id/members
├── POST /api/v1/organizations/:id/invites
├── PATCH /api/v1/organizations/:id/members/:userId/role
├── DELETE /api/v1/organizations/:id/members/:userId
└── POST /api/v1/organizations/invites/:token/accept
```

**Helper Functions:**
- `requireOrgMembership()` - Verify user is member + check permissions
- `hashToken()` - SHA-256 token hashing
- `generateOrgSlug()` - Safe slug generation from email

### Entitlements

```
apps/api/src/entitlements.ts
├── resolveEntitlement() - User-based (legacy)
│  └── NOW: Loads plans from database (not hardcoded)
│  └── NOW: Real storage metrics (not fake data)
└── resolveOrganizationEntitlement() - Org-based (Phase 18+)
   ├── Checks subscription status
   ├── Loads plan from database
   └── Enforces limits (maxMembers, maxWorkspaces, etc.)
```

### Migration Layer

```
apps/api/src/migrations/userToOrganization.ts (220 LOC)
├── migrateUsersToOrganizations()
│  ├── For each user:
│  ├── Create personal organization
│  ├── Add user as owner
│  ├── Migrate subscription
│  └── Link workspaces
├── verifyMigration() - Post-migration checks
└── rollbackMigration() - Safety function (stub)
```

### CLI

```
apps/api/src/cli/migrateUsers.ts (140 LOC)
├── --dry-run   # Simulate migration
├── --confirm   # Run actual migration
└── --verify    # Check migration status
```

---

## Data Model

### Organization Hierarchy

```
Organization
├── id: UUID
├── name: string
├── slug: string (unique, 3-50 chars)
├── ownerUserId: UUID
├── logoUrl: URL | null
├── primaryColor: string | null
├── secondaryColor: string | null
├── customDomain: string | null
├── settings: { personal?: true, ... }
├── createdAt: ISO8601
├── updatedAt: ISO8601
└── deletedAt: ISO8601 | null (soft delete)

OrganizationMember
├── organizationId: UUID (FK)
├── userId: UUID (FK)
├── role: 'owner' | 'admin' | 'billing'
├── invitedAt: ISO8601
└── joinedAt: ISO8601 | null

OrganizationInvite
├── id: UUID
├── organizationId: UUID (FK)
├── email: string
├── role: 'owner' | 'admin' | 'billing'
├── tokenHash: SHA-256 hash
├── invitedBy: UUID | null
├── expiresAt: ISO8601 (72 hours)
├── acceptedAt: ISO8601 | null
└── createdAt: ISO8601

OrganizationAuditEvent
├── id: UUID
├── organizationId: UUID
├── userId: UUID (who made change)
├── action: AuditAction enum
├── resourceType: string | null
├── resourceId: string | null
├── ip: string | null
├── userAgent: string | null
└── createdAt: ISO8601

Workspace (UPDATED)
├── id: UUID
├── ownerUserId: UUID
├── name: string
├── organizationId: UUID | null ← NEW (Phase 19)
├── createdAt: ISO8601
├── updatedAt: ISO8601
└── deletedAt: ISO8601 | null

Subscription (UPDATED)
├── id: UUID
├── userId: UUID | null ← LEGACY (for backward compat)
├── organizationId: UUID | null ← NEW (Phase 18+)
├── planId: UUID
├── status: enum
├── currentPeriodStart: ISO8601 | null
├── currentPeriodEnd: ISO8601 | null
├── cancelledAt: ISO8601 | null
├── createdAt: ISO8601
└── updatedAt: ISO8601
```

### Role-Based Permissions

#### Organization Roles
| Role | Manage Org | Invite Members | Manage Members | Audit | Billing | Analytics | Settings |
|------|:----------:|:--------------:|:--------------:|:-----:|:-------:|:---------:|:--------:|
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| admin | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| billing | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |

#### Workspace Roles
| Role | Create | Edit | Delete | Invite | Manage | View |
|------|:------:|:----:|:------:|:------:|:------:|:----:|
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| admin | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| doctor | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| assistant | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| viewer | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## API Endpoints

### Organization Management
```
GET    /api/v1/organizations
       List organizations user belongs to
       Response: { organizations: Org[] }

POST   /api/v1/organizations
       Create new organization
       Body: { name, slug }
       Response: { organization: Org }

GET    /api/v1/organizations/:id
       Get organization details
       Response: { organization: Org }

PATCH  /api/v1/organizations/:id
       Update organization (owner only)
       Body: { name?, slug?, branding?, settings? }
       Response: { organization: Org }
```

### Member Management
```
GET    /api/v1/organizations/:id/members
       List all members
       Response: { members: Member[] }

POST   /api/v1/organizations/:id/invites
       Invite member (admin+)
       Body: { email, role }
       Response: { invite: Invite }

PATCH  /api/v1/organizations/:id/members/:userId/role
       Change member role (admin+)
       Body: { role }
       Response: { member: Member }

DELETE /api/v1/organizations/:id/members/:userId
       Remove member (admin+)
       Response: { success: true }

POST   /api/v1/organizations/invites/:token/accept
       Accept invitation
       Response: { organization: Org }
```

---

## Feature Flags & Limits

### Plans
- Each plan defines:
  - `maxMembers` - Max org members
  - `maxWorkspaces` - Max workspaces per org
  - `storageBytes` - Total storage
  - `featureFlags` - Feature availability
  - `retentionDays` - Backup retention

### Enforcement
- **Member Limits**: Checked on invitation
- **Workspace Limits**: Checked on creation
- **Storage Limits**: Checked on backup upload
- **Feature Flags**: Checked before operation

---

## Backward Compatibility

### Phase 18-19 Transition
```
Subscriptions:
  BEFORE: { userId, planId, status, ... }
  AFTER:  { userId?, organizationId?, planId, status, ... }
  
Query Logic:
  entitlement = await resolveEntitlement(userId)
    → First tries organizationId path
    → Falls back to userId path if org not found
    
Workspace Queries:
  BEFORE: WHERE owner_user_id = ?
  AFTER:  WHERE owner_user_id = ? OR organization_id = ?
```

### Timeline
- **Phase 18**: Both paths supported
- **Phase 19**: Migration service converts users
- **Phase 20**: Legacy user_id path deprecated
- **Phase 21**: user_id column removed

---

## Security Considerations

### Authentication
- JWT tokens required for all org endpoints
- User identity verified from token
- Membership verified per operation

### Authorization
- Two-level checks:
  1. Is user a member of organization?
  2. Does their role allow this action?
- Separate from workspace authorization

### Data Isolation
- Workspace audit logs don't expose to org level
- Organization audit logs don't touch clinical data
- Separate encryption for workspace data

### Audit Trail
- All member changes logged
- All settings changes logged
- All audit events timestamped and linked to actor

---

## Performance Considerations

### Indexes
```
organizations:
  - PRIMARY KEY (id)
  - UNIQUE (slug)
  - UNIQUE (custom_domain)
  - (owner_user_id) for listing user's orgs

organization_members:
  - PRIMARY KEY (organization_id, user_id)
  - (user_id) for listing user's orgs
  - (organization_id) for listing org members

workspaces:
  - PRIMARY KEY (id)
  - (owner_user_id) for listing workspaces
  - (organization_id) for org dashboard ← NEW (Phase 19)

subscriptions:
  - PRIMARY KEY (id)
  - (user_id) for legacy lookups
  - (organization_id) for org lookups ← NEW (Phase 18)
```

### Query Optimization
- Bulk operations use JOINs
- List operations filtered at DB level
- Soft deletes checked in all queries
- Pagination on large result sets

---

## Testing Strategy

### Unit Tests
- Migration slug generation
- Permission checking
- Token hashing

### Integration Tests
- Full migration on test database
- Verify all users → orgs
- Verify subscription updates
- Verify workspace linking

### End-to-End Tests
- Create organization
- Invite member
- Accept invitation
- Change role
- Remove member

### Load Tests
- 1000+ users migration performance
- Concurrent member invites
- Bulk workspace linking

---

## Deployment

### Prerequisites
```bash
# 1. Run pending migrations
pnpm migrate

# 2. Test on staging
pnpm migrate:users --dry-run

# 3. Review output
```

### Production Deployment
```bash
# 1. Backup database
pg_dump $DATABASE_URL > backup.sql

# 2. Run migration
pnpm migrate:users --confirm

# 3. Verify
pnpm migrate:users --verify

# 4. Monitor logs
```

### Rollback
```bash
# If needed:
pg_restore --dbname=clinote backup.sql
```

---

## What's NOT Implemented (Phases 19+)

| Feature | Phase | Status |
|---------|-------|--------|
| Admin UI dashboard | 19 P2 | Design phase |
| Real metrics calculation | 19 P3 | Planned |
| Organization audit logging | 19 P4 | Planned |
| Custom domains | 22 | Planned |
| SSO/SCIM integration | 22 | Planned |

---

## Related Documents

- 📋 [Phase 18 P0 Progress](./PHASE_18_P0_PROGRESS.md)
- 📋 [Phase 19 P0 Progress](./PHASE_19_P0_PROGRESS.md)
- 📚 [Architecture Documentation](./docs/PHASE_19_ARCHITECTURE.md)
- 🔄 [Migration Guide](./docs/MIGRATION_USERS_TO_ORGS.md)
- 🏗️ [System Architecture](./docs/architecture.md)

---

**Clinote Multi-Tenant Architecture - Complete Reference** ✅
