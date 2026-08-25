# Deployment

## 1. Components

```
web   Nuxt 3 — client-rendered SPA (`ssr: false`), CDN-fronted, service worker
api   Fastify — stateless container, N replicas behind a load balancer
jobs  same image as api, started with a worker entrypoint
db    PostgreSQL (managed), point-in-time recovery enabled
store S3-compatible object storage, private buckets, lifecycle rules
queue Redis or Postgres-backed job queue (single implementation behind an
      interface so it can be swapped)
mail  transactional email provider (behind an interface)
```

**SPA fallback is required.** `pnpm --filter @clinote/web generate` emits
`index.html`, `200.html` and the prerendered route shells. Because the app is
client-rendered, any deep link the user opens directly — `/clients/<uuid>`,
`/files/<uuid>` — does not exist as a file and the host must rewrite unknown
paths to `200.html` (Netlify `/* /200.html 200`, Vercel rewrite, nginx
`try_files $uri $uri/ /200.html`). Without it, in-app navigation works and a
refresh on a detail page returns 404. Verified against a plain static file
server during Phase 3; a host without the rewrite is misconfigured, not a bug in
the app.

## 2. Environments

`local` (docker compose: postgres, minio, mailpit) → `staging` (real providers,
test billing mode) → `production`.

Phase 8 ships the PostgreSQL half of that: `docker-compose.yml` runs Postgres 16
on host port **5433** — deliberately not 5432, so it cannot collide with another
database already running on a developer's machine.

```bash
pnpm db:up        # PostgreSQL :5433, MinIO :9100 (console :9101), Mailpit :1125 (UI :8125)
pnpm db:migrate   # apply migrations and seed the plan catalog
pnpm worker       # reminder delivery and backup retention
pnpm db:down      # stop them
```

Mailpit catches every outgoing message in development, so email templates can be
read without sending anything anywhere.

MinIO stands in for the production object store; the bucket `clinote-backups`
is created on first start and is private. Both ports are deliberately
non-default so they cannot collide with something already running.

Outside production the API applies pending migrations on boot. In production it
does not: migrations are a deploy step that must finish before the new version
serves traffic (§4).

Staging holds no production data. Ever.

## 3. Configuration

Environment variables, validated at boot by a zod schema; the process exits on
a missing or malformed variable rather than starting in a half-configured state.
Secrets come from the platform's secret manager, never from the repository.

Plan catalog, quotas and retention are database configuration, not env vars, so
they can change without a deploy (§7).

## 4. Migrations

Forward-only SQL migrations, applied by a job that runs before the new API
version becomes ready. Every migration must be safe against the previous
application version running concurrently (expand → migrate → contract).

## 5. Release flow

```
PR → CI (typecheck, lint, unit, integration, build) → staging deploy →
E2E suite on staging → manual mobile checklist for release candidates →
production deploy (rolling) → post-deploy smoke → monitor
```

The service worker is versioned; a new release prompts "Update available" rather
than swapping code under an active user, because an in-progress backup must not
be interrupted by an update.

## 6. Backups of our own infrastructure

Postgres PITR + daily snapshots; object storage versioning with a lifecycle
policy matching the retention entitlements. Restore drills are performed and
documented quarterly — a backup product that cannot restore its own database is
not credible.

## 7. Observability

Structured logs with the redaction middleware (`security.md` §7), request ids
propagated to the client in `X-Request-Id`, RED metrics per route, queue depth
and job failure alerts, and alerts on: backup completion rate, sync push error
rate, email bounce rate, storage growth.

## 8. Rollback

Every deploy is revertible to the previous image. Database migrations are
designed so that the previous image keeps working (expand/contract), which is
what makes rollback actually possible rather than theoretical.

## 9. Serving the app (Phase 15)

The bundle ships its own Content Security Policy in the page, with per-build
script hashes (`docs/security.md` §13). **Do not add a second CSP in the web
server**: two policies intersect, and a stale copy blocks the app.

What the web server should add, because a meta tag cannot:

```nginx
add_header X-Frame-Options DENY always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# index.html must not be cached, or an update never reaches an open tab.
location = /index.html { add_header Cache-Control "no-cache" always; }
# Hashed assets are immutable by construction.
location /_nuxt/ { add_header Cache-Control "public, max-age=31536000, immutable" always; }

# Single-page app: unknown paths are routes, not missing files.
location / { try_files $uri $uri/ /index.html; }
```

Serve the API from the same origin where possible. That is what lets the
refresh cookie stay `SameSite=Strict`, and it keeps `connect-src 'self'`
sufficient. When it lives elsewhere, set `NUXT_PUBLIC_API_BASE_URL` at build
time — the policy's `connect-src` is derived from it, so the two cannot drift.

Set `TRUST_PROXY` to the number of reverse proxies actually in front of the
API. Zero (the default) means the socket address is the client. Any other value
must match reality: too high and a client can forge its own address, too low
and every request appears to come from the load balancer.
