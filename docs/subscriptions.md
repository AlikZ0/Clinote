# Subscriptions, entitlements and feature access

## 1. Rule

> Backend is authoritative for paid features. Frontend gating is UX, not
> security (§45, I6).

Every server route that touches a paid capability re-checks the entitlement. A
frontend that lies about its plan gets a `403 feature_not_available`.

## 2. Plan catalog is data (§7, §47, §48)

Prices, quotas, retention and device limits are **server configuration**, served
to the client and cached. `packages/config` holds the _shape_ and the seed
defaults; it is not the runtime source of truth.

```
GET /api/v1/plans →
[
  { "id": "free",     "price": { "amount": 0,    "currency": "USD", "interval": "month" }, … },
  { "id": "pro",      "price": { "amount": 599,  "currency": "USD", "interval": "month" }, … },
  { "id": "business", "price": { "amount": 1499, "currency": "USD", "interval": "month" }, … }
]
```

Amounts are integer minor units. Changing a price is a configuration change, not
a deploy of the frontend (§7).

## 3. Feature flags (§46)

```
cloudSync · cloudBackup · cloudRestore · appointments · calendar
notifications · pushNotifications · emailNotifications
teams · workspaces · auditLog · multiDevice
```

Limits (numeric entitlements):

```
storageBytes · backupRetentionDays · maxDevices · maxWorkspaces · maxMembers
```

Defaults: Pro 10 GB / 30 days / 3 devices; Business 100 GB / 365 days /
configurable devices and members (§37, §47, §48).

## 4. Entitlement snapshot

The client receives one object and never computes a plan comparison itself:

```jsonc
{
  "planId": "pro",
  "status": "active",          // active | past_due | canceled | expired
  "features": { "cloudSync": true, "teams": false, … },
  "limits":   { "storageBytes": 10737418240, … },
  "usage":    { "storageBytes": 1503238553, "devices": 2 },
  "expiresAt": "2026-09-25T00:00:00Z"
}
```

`FeatureAccessService.canUse("cloudSync")` reads this snapshot. There is no
`if (plan === "pro")` anywhere in components (§45). The snapshot is refreshed on
login, on app focus, after billing events, and on any `403 feature_not_available`.

## 5. Locked-feature UX (§56)

A Free user opening Calendar sees the feature explained and an upgrade action,
never a blank page or a broken screen:

```
Calendar
🔒 Available with Clinote Pro
Manage appointments and get automatic reminders.
[Upgrade to Pro]
```

The gate component is one shared `<FeatureGate feature="appointments">` wrapper.

### Local plan preview (development only)

Until accounts exist (Phase 7) there is no server entitlement, so every paid
screen would be unreachable and unreviewable. Settings therefore offers a
**local plan preview**, stored in this device's settings.

It is deliberately weak by construction:

- it applies only while no server entitlement has been received — a real
  entitlement replaces it and it stops being consulted;
- it changes what one device renders, never what an account may do, and every
  paid route is re-checked server-side (§1);
- it is visible: an active preview shows a badge in the app header.

It exists to build and review paid screens, not to grant capability, and it must
not be treated as a way to try Pro.

## 6. Downgrade and expiry (§71)

When Pro ends:

| Capability                              | After expiry                                       |
| --------------------------------------- | -------------------------------------------------- |
| Cloud sync, cloud backup, cloud restore | disabled                                           |
| Appointments already created            | readable, exportable, not editable via calendar UI |
| Local database, export, import          | **always available** (I2)                          |
| Existing cloud backups                  | retained for the plan's grace window, downloadable |

The user is never locked out of their own local data. This is a hard product
rule, not a setting.

## 7. Billing abstraction (§72)

```ts
interface BillingProvider {
  createCheckout(input): Promise<{ url: string }>
  getSubscription(userId): Promise<Subscription | null>
  cancelSubscription(userId): Promise<void>
  restoreSubscription(userId): Promise<Subscription | null>
  handleWebhook(raw, signature): Promise<BillingEvent[]>
}
```

No provider SDK type appears outside `apps/api/src/billing/providers/*`. App
Store / Play in-app purchase, which a mobile wrapper will eventually require, is
another implementation of the same interface — this is why `restoreSubscription`
exists in the contract from day one.

Webhooks are the source of truth for subscription state; checkout redirects are
only a UX signal. Webhook handlers are idempotent and signature-verified.

## 8. What Phase 13 shipped

| Piece                                                 | Where                                                  |
| ----------------------------------------------------- | ------------------------------------------------------ |
| Provider port                                         | `apps/api/src/billing/provider.ts`                     |
| Development provider (real HMAC signatures, no money) | `apps/api/src/billing/manual.ts`                       |
| Checkout, cancel, restore, webhook application        | `apps/api/src/billing/service.ts`, `routes.ts`         |
| Event and checkout records                            | `0005_billing.sql`                                     |
| Plans, upgrade, cancel, status                        | `pages/settings.vue`, `composables/useSubscription.ts` |
| Stand-in payment page                                 | `pages/billing/checkout.vue`                           |

Decisions worth keeping:

- **A checkout is not a subscription.** Starting one records a checkout row and
  nothing else; only a verified webhook creates or changes a subscription.
- **Webhooks are idempotent by construction.** `billing_events` has a unique
  `(provider, external_id)`, and a redelivery inserts nothing and applies
  nothing. Providers retry; a retry must change nothing.
- **The raw body is what gets verified.** A JSON parser that kept only the
  parsed object would force verification against a re-serialization, which is
  both fragile and unsafe, so the exact bytes are preserved.
- **Cancelling does not take anything away.** The provider's webhook decides
  when access ends; until then the account keeps what it paid for, and the UI
  says the cancellation was recorded rather than leaving the click looking
  ignored.
- **`past_due` suspends, it does not delete.** Cards fail for boring reasons;
  the account drops to Free only on expiry or cancellation, and local data is
  never touched (invariant I2, verified in the browser).
- **The development provider cannot run in production.** `loadEnv` refuses to
  start, and `createBillingProvider` refuses again.

Not shipped: a real payment provider. The port is what a Stripe or App Store
adapter implements, and connecting one is deployment work with its own
integration tests — the same rule this project has followed for every external
service.

## 9. Who pays for a workspace (Phase 14)

The **owner's** subscription keeps a workspace alive. Members do not need one.

That is not a convenience: a clinic buys Business, and its assistants should
not each have to buy their own to open the app at work. It means every
workspace check resolves the entitlement of `workspace.ownerUserId`, never of
the caller.

- Creating a workspace needs `features.workspaces` on the creator, and counts
  against `limits.maxWorkspaces`.
- Inviting needs `features.teams` on the owner, and counts members _plus
  pending invitations_ against `limits.maxMembers` — otherwise the limit is
  trivially exceeded by inviting everyone at once.
- When the owner's subscription lapses, the workspace stream stops for every
  member. Their local databases keep working, exactly as for a personal
  account (invariant I2).
- Device registration takes the best limit among the caller's own plan and the
  workspaces they belong to.

## 10. Tests

Entitlement resolution per plan and status, expiry transitions, server-side
enforcement on every paid route, gate rendering for Free, and a test that fails
if a component references a plan id directly.
