# Clinote documentation

Read `architecture.md` first — it holds the invariants and the risk register
that everything else refers to.

| Document                                 | Contents                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| [architecture.md](architecture.md)       | Invariants, layering, package boundaries, architectural risks             |
| [local-first.md](local-first.md)         | What local-first means here, read/write paths, degradation rules          |
| [indexeddb.md](indexeddb.md)             | Dexie schema, indexes, blobs, migrations, quota, performance              |
| [backup.md](backup.md)                   | Archive format, backup pipeline, upload protocol, health, restore, import |
| [encryption.md](encryption.md)           | Key hierarchy, envelope format, device enrollment, recovery key           |
| [sync.md](sync.md)                       | Outbox, ordering, conflict policy, files, sync status                     |
| [appointments.md](appointments.md)       | Entity, calendar views, reminders, statuses                               |
| [notifications.md](notifications.md)     | Minimum disclosure, push/email split, jobs, preferences                   |
| [subscriptions.md](subscriptions.md)     | Plans as data, entitlements, gating, downgrade, billing abstraction       |
| [security.md](security.md)               | Threat model, auth, authz, logging/privacy rules, audit                   |
| [mobile.md](mobile.md)                   | Layout, iOS/Android constraints, capture, test matrix                     |
| [postgres-schema.md](postgres-schema.md) | Backend tables and what may never be stored in them                       |
| [api.md](api.md)                         | HTTP contract for `/api/v1`                                               |
| [deployment.md](deployment.md)           | Environments, config, migrations, release, observability                  |
| [roadmap.md](roadmap.md)                 | Phases and definition of done                                             |
