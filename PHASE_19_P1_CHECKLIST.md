# Phase 19 P1: Admin UI & Real Metrics - Pre-Start Checklist

**Status**: Ready for Phase 19 P1 implementation  
**Prerequisite**: Phase 19 P0 migration service deployed and tested

---

## Pre-Implementation Tasks

### ✅ Phase 19 P0 Completion Verification

Before starting P1, ensure Phase 19 P0 is fully operational:

- [ ] Database migration 0008 has been applied

  ```bash
  psql $DATABASE_URL -c "\\d workspaces" | grep organization_id
  # Should show: organization_id | uuid
  ```

- [ ] Migration service runs successfully

  ```bash
  pnpm migrate:users --verify
  # Should show: ✅ Users with organization: [N]
  ```

- [ ] All users have organizations

  ```bash
  psql $DATABASE_URL -c "SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND id NOT IN (SELECT DISTINCT user_id FROM organization_members)"
  # Should return: 0
  ```

- [ ] All workspaces linked to organizations

  ```bash
  psql $DATABASE_URL -c "SELECT COUNT(*) FROM workspaces WHERE deleted_at IS NULL AND organization_id IS NULL"
  # Should return: 0
  ```

- [ ] API still responding to requests
  ```bash
  curl http://localhost:3000/health/live
  # Should return: {"status":"ok"}
  ```

---

## Phase 19 P1: Admin UI Implementation Plan

### Part A: Frontend Components (React/Vue)

#### Dashboard Page

```
components/organizations/DashboardPage.tsx
├── Header with org name, logo
├── Stats cards:
│  ├── Member count
│  ├── Workspace count
│  ├── Storage usage
│  └── Plan tier
├── Tabs:
│  ├── Members tab
│  ├── Workspaces tab
│  ├── Settings tab
│  └── Billing tab
└── Action buttons (invite, add workspace)
```

#### Members Management

```
components/organizations/MembersTab.tsx
├── Member list with:
│  ├── Email
│  ├── Name
│  ├── Role (dropdown to change)
│  ├── Joined date
│  └── Remove button
├── Invite member form:
│  ├── Email input
│  ├── Role select
│  └── Send invite button
├── Pending invites list
│  ├── Email
│  ├── Role
│  ├── Sent date
│  └── Resend/revoke buttons
└── Member limit indicator
```

#### Workspaces Tab

```
components/organizations/WorkspacesTab.tsx
├── List all org's workspaces
│  ├── Name + description
│  ├── Member count
│  ├── Owner info
│  └── Quick actions (access, leave, delete)
├── Create workspace button
└── Workspace limit indicator
```

#### Settings Tab

```
components/organizations/SettingsTab.tsx
├── Organization info:
│  ├── Name (editable)
│  ├── Slug (display only)
│  └── Description
├── Branding:
│  ├── Logo upload
│  ├── Primary color picker
│  ├── Secondary color picker
│  └── Custom domain input (Phase 22)
└── Danger zone:
   ├── Delete organization button
   └── Transfer ownership (future)
```

#### Billing Tab

```
components/organizations/BillingTab.tsx
├── Current plan display
├── Member usage vs limit
├── Storage usage vs limit
├── Upgrade/downgrade button
├── Billing history
└── Payment methods (if using payment processor)
```

### Part B: Backend Changes

#### New Types

```typescript
// packages/types/src/organizations.ts (additions)
interface OrganizationDashboard {
  organization: Organization
  memberCount: number
  workspaceCount: number
  storageUsed: number
  storageLimit: number
  plan: Plan
}

interface MemberWithStats extends OrganizationMember {
  user: UserInfo
  workspaceCount: number
}
```

#### New Routes

```
apps/api/src/organizations/
├── dashboard.ts        # GET /api/v1/organizations/:id/dashboard
├── workspaces.ts       # GET /api/v1/organizations/:id/workspaces
├── settings.ts         # PATCH /api/v1/organizations/:id/settings
├── billing.ts          # GET /api/v1/organizations/:id/billing
└── analytics.ts        # GET /api/v1/organizations/:id/analytics (Phase 19 P3)
```

### Part C: Real Metrics Implementation

#### Storage Usage Calculation

```typescript
// apps/api/src/storage/metrics.ts (new)
async function calculateOrganizationStorage(
  stores: Stores,
  orgId: string,
): Promise<{
  bytesUsed: number
  fileCount: number
  backupCount: number
}> {
  // 1. Get all workspaces in organization
  const workspaces = await stores.workspaces.listAll() // Filter by org_id

  // 2. For each workspace, calculate:
  //    - Storage used by backups
  //    - SyncEnvelope payload size (if applicable)

  // 3. Sum and return
}

async function enforceStorageLimits(stores: Stores, orgId: string): Promise<boolean> {
  // Check if org is within storage limits
  const entitlement = await resolveOrganizationEntitlement(stores, orgId)
  const usage = await calculateOrganizationStorage(stores, orgId)

  return usage.bytesUsed <= entitlement.limits.storageBytes
}
```

#### Member Limit Enforcement

```typescript
// Updated in apps/api/src/organizations/routes.ts
// POST /api/v1/organizations/:id/invites
async function inviteMember(request, reply) {
  const entitlement = await resolveOrganizationEntitlement(stores, orgId)
  const members = await stores.organizations.countMembers(orgId)
  const pending = (await stores.organizations.listPendingInvites(orgId)).length

  if (members + pending >= entitlement.limits.maxMembers) {
    throw new AppError('member_limit_reached', ...)
  }

  // ... continue with invite
}
```

---

## Phase 19 P1 Implementation Order

### Week 1: Foundation

1. **Day 1-2**: Create React/Vue components skeleton
   - Dashboard layout
   - Tab navigation
   - Member list component
   - Storage indicator component

2. **Day 3**: Wire up API calls
   - useQuery for org data
   - useMutation for member actions
   - Error handling + loading states

3. **Day 4**: Member management UI
   - Display member list with roles
   - Invite member form
   - Change role dropdown
   - Remove member confirmation

### Week 2: Metrics & Polish

4. **Day 5**: Implement storage calculation
   - StorageUsageStore integration
   - Real quota enforcement
   - Limit indicators

5. **Day 6**: Settings tab
   - Edit organization name
   - Logo upload
   - Color pickers

6. **Day 7**: Testing & refinement
   - Component tests
   - E2E flows
   - Performance optimization

---

## Development Checklist

### Frontend Setup

- [ ] Install required UI dependencies (if not already done)
- [ ] Create components directory structure
- [ ] Set up React Query / SWR for data fetching
- [ ] Create loading skeleton components
- [ ] Set up error boundary

### Backend Setup

- [ ] Create dashboard route handler
- [ ] Create analytics route handler
- [ ] Implement metrics calculation
- [ ] Add limit enforcement checks
- [ ] Create admin audit logging

### Testing

- [ ] Write component tests
- [ ] Test API endpoints with Postman/Thunder Client
- [ ] Manual E2E testing with real data
- [ ] Performance testing with large datasets
- [ ] Error scenario testing

### Documentation

- [ ] Document new API endpoints
- [ ] Add frontend component storybook
- [ ] Create admin user guide
- [ ] Add troubleshooting section

---

## Key Files to Create/Modify

### New Files to Create

```
apps/web/components/organizations/
├── DashboardPage.tsx
├── MembersTab.tsx
├── WorkspacesTab.tsx
├── SettingsTab.tsx
├── BillingTab.tsx
├── MemberList.tsx
├── InviteMemberForm.tsx
├── StorageIndicator.tsx
└── QuotaWarning.tsx

apps/api/src/organizations/
├── dashboard.ts
├── metrics.ts
└── analytics.ts

packages/types/src/
└── organizations.ts (add new types)
```

### Files to Modify

```
apps/api/src/organizations/routes.ts
├── Add dashboard route
├── Add metrics route
├── Add settings route
└── Update invite route (with real limit checking)

apps/api/src/app.ts
├── Register new dashboard routes

apps/web/pages/ or router/
├── Add /organizations/:id route
├── Add /organizations/:id/settings route
```

---

## API Endpoints to Add

```
GET    /api/v1/organizations/:id/dashboard
       Returns org stats for dashboard display
       Response: OrganizationDashboard

GET    /api/v1/organizations/:id/storage
       Returns storage usage and limits
       Response: { used: number, limit: number, percentage: number }

GET    /api/v1/organizations/:id/members/stats
       Returns member count and limit
       Response: { count: number, limit: number }

GET    /api/v1/organizations/:id/workspaces
       Lists organization's workspaces
       Response: { workspaces: Workspace[] }

GET    /api/v1/organizations/:id/analytics
       Returns usage analytics (Phase 19 P3)
       Response: { dailyActiveUsers, storage, ... }

PATCH  /api/v1/organizations/:id/settings
       Update organization settings
       Body: { name?, logoUrl?, colors? }
       Response: { organization: Organization }
```

---

## Database Queries to Optimize

```sql
-- Get organization with all stats
SELECT
  o.*,
  COUNT(DISTINCT om.user_id) as member_count,
  COUNT(DISTINCT w.id) as workspace_count,
  COALESCE(SUM(b.size_bytes), 0) as storage_used
FROM organizations o
LEFT JOIN organization_members om ON om.organization_id = o.id
LEFT JOIN workspaces w ON w.organization_id = o.id AND w.deleted_at IS NULL
LEFT JOIN backups b ON b.user_id IN (
  SELECT user_id FROM organization_members WHERE organization_id = o.id
) AND b.backup_status = 'completed'
WHERE o.id = $1
GROUP BY o.id;

-- Get workspace belonging to organization
SELECT * FROM workspaces
WHERE organization_id = $1 AND deleted_at IS NULL
ORDER BY created_at DESC;
```

---

## Testing Scenarios

### Scenario 1: Create Organization

1. Click "Create Organization"
2. Enter name and slug
3. Verify organization created
4. Verify user added as owner
5. Verify dashboard loads

### Scenario 2: Invite Member

1. Go to Members tab
2. Click "Invite Member"
3. Enter email and select role
4. Verify invitation sent
5. Verify pending invites list updated
6. Verify member count + 1 pending
7. Verify limit enforcement

### Scenario 3: Change Role

1. Go to Members tab
2. Click role dropdown on member
3. Select new role
4. Verify role updated
5. Verify audit log created

### Scenario 4: Storage Quota

1. Check organization storage
2. Verify calculation is correct
3. When at limit, verify can't upload backup
4. Verify warning message shown at 80%

### Scenario 5: Workspace Management

1. Go to Workspaces tab
2. See all organization workspaces
3. Verify workspace count matches limit
4. When at limit, verify can't create new

---

## Success Criteria for Phase 19 P1

- [ ] Dashboard page loads and displays org info
- [ ] Members tab shows all members with roles
- [ ] Invite member form sends invitations
- [ ] Accept invitation works from email link
- [ ] Member limits enforced (can't exceed plan)
- [ ] Storage usage calculated correctly
- [ ] Storage limits enforced
- [ ] Settings page allows editing org name/logo
- [ ] All operations create audit entries
- [ ] Mobile-responsive UI
- [ ] Error handling works gracefully
- [ ] Loading states show properly
- [ ] No breaking changes to existing APIs

---

## Performance Benchmarks

Target performance metrics:

| Operation         | Target   | Note               |
| ----------------- | -------- | ------------------ |
| Load dashboard    | < 500ms  | Including all tabs |
| List members      | < 300ms  | 1000 members       |
| Invite member     | < 200ms  | Email sent async   |
| Change role       | < 200ms  |                    |
| Calculate storage | < 1000ms | For large orgs     |

---

## Rollback Plan

If Phase 19 P1 has issues:

1. Revert frontend code
2. Revert new API routes
3. Existing org API still works (Phase 18)
4. Continue using Phase 18 endpoints
5. Retry Phase 19 P1 with fixes

---

## Known Unknowns to Clarify

- [ ] UI framework choice (React? Vue? Svelte?)
- [ ] CSS-in-JS or Tailwind?
- [ ] How to handle org logo upload (S3 or local)?
- [ ] Payment processor integration (Phase 22)?
- [ ] RBAC details for admin vs billing role?
- [ ] Mobile-first or desktop-first design?

---

## Post-Implementation

### Monitoring

- Track dashboard load times
- Monitor storage calculation performance
- Alert on limit enforcement failures

### Documentation

- Update user guides
- Add admin onboarding docs
- Create troubleshooting guide

### Metrics

- Track feature adoption
- Monitor error rates
- Gather user feedback

---

## Quick Start Commands

```bash
# Start development
pnpm dev

# Run tests
pnpm test

# Build for production
pnpm build

# Type checking
pnpm typecheck

# Linting
pnpm lint
```

---

**Phase 19 P1 Ready to Start!** 🚀

Previous session: Phase 19 P0 ✅  
Current session: Ready for Phase 19 P1
