# Clinote

Local-first practice management.

> **Free** — your data, your device.
> **Pro** — your data, everywhere, always protected.
> **Business** — your clinic, your team, one workspace.

The system of record is IndexedDB on the user's device. The cloud is an
optional, zero-knowledge replication and backup layer unlocked by a paid plan.
Read [`docs/architecture.md`](docs/architecture.md) before changing anything —
it holds the invariants the rest of the code depends on.

## Repository layout

```
apps/
  web/        Nuxt 3 PWA — UI, local core, sync client
  api/        Fastify — auth, entitlements, sync relay, backup metadata, billing
packages/
  types/      Entities, DTOs and zod schemas shared by web and api
  config/     Plan catalog defaults + FeatureAccessService
  crypto/     Web Crypto envelope encryption, key hierarchy
  backup/     Archive format, checksums, validation
  shared/     Ids, hybrid logical clock, error taxonomy, Result
docs/         Architecture and specifications (start at docs/README.md)
```

## Requirements

- Node.js ≥ 22.12
- pnpm 10 (`corepack enable`)

TypeScript is pinned to 5.9 because typescript-eslint does not yet support
TypeScript 7.

## Getting started

```bash
pnpm install
pnpm db:up        # PostgreSQL on :5433 and MinIO on :9100 (docker compose)
pnpm db:migrate   # schema + seed plan catalog
pnpm dev          # web on :3000, api on :3001
```

The API defaults to an in-memory store so it runs with no database at all; set
`STORAGE_DRIVER=postgres` and `DATABASE_URL` (see `apps/api/.env.example`) to
use the real one. It refuses to start with the in-memory store in production.

Individually:

```bash
pnpm dev:web
pnpm dev:api
```

## Checks

```bash
pnpm verify       # typecheck + lint + test + build
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The API suite runs once per storage adapter. Set `TEST_DATABASE_URL` to include
the PostgreSQL run:

```bash
TEST_DATABASE_URL=postgres://clinote:clinote@127.0.0.1:5433/clinote \
TEST_S3_ENDPOINT=http://127.0.0.1:9100 \
pnpm test
```

`TEST_S3_ENDPOINT` additionally runs the object-store suite against a real
S3-compatible service.

CI always sets it, so the adapter is never left untested there.

`pnpm --filter @clinote/web generate` produces the static SPA in
`apps/web/.output/public`, which is what gets deployed for the local-first app.

## Status

Phase 0 (architecture) and Phase 1 (monorepo + tooling) are complete. The phase
plan and its exit criteria live in [`docs/roadmap.md`](docs/roadmap.md).
